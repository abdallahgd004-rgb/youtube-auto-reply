/**
 * LM Studio API Client - YouTube Auto Reply Extension
 * 
 * This module provides a simple client for sending chat completion requests
 * to the local LM Studio server.
 */

import { getSettings } from '../core/storage.js';
import { logError, YTAR_DEVLOG, DEV_LOG_COMPONENT as C, DEV_LOG_LEVEL as L, newRequestId } from '../core/debug.js';
import { resolveResponseText } from '../core/reasoning-budget.js';

// Default timeout in milliseconds (60 seconds)
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Task 13.1 — the single user-facing message for "LM Studio is not reachable".
 *
 * Kept as one exported constant so the popup, the options page and the service worker
 * all show the exact same wording instead of each inventing its own.
 */
export const LM_STUDIO_OFFLINE_MESSAGE = 'Cannot connect to LM Studio.';

/**
 * Task 13.3 — user-facing message for a request that timed out.
 *
 * Says explicitly that nothing was sent, because a timeout means the reply is simply
 * absent: there is no partial text to salvage, and nothing must be published.
 */
export const LM_STUDIO_TIMEOUT_MESSAGE =
  'LM Studio did not respond in time, so no reply was sent. Check that the model is loaded, then try again.';

/**
 * Task 13.4 — user-facing message for an empty completion.
 *
 * The pipeline records this as `failed` rather than attempting to publish nothing.
 */
export const LM_STUDIO_EMPTY_RESPONSE_MESSAGE =
  'LM Studio returned an empty reply, so nothing was sent. Try again, or choose a different model.';

/**
 * Task 13.4 / Phase 20.24 — the message for a STRUCTURED call whose budget went on thinking.
 *
 * Separate from {@link LM_STUDIO_EMPTY_RESPONSE_MESSAGE} because the two have different causes
 * and different fixes, and telling a user to "choose a different model" for what is a token
 * budget sends them to the one place the problem is not. A reasoning model that returns
 * `reasoning_content` and an empty `content` spent its whole ceiling thinking and was cut off
 * before writing the answer — the budget, not the model and not the connection.
 */
export const LM_STUDIO_REASONING_BUDGET_MESSAGE =
  'LM Studio spent the whole response budget thinking and returned no answer, so nothing was sent.';

/**
 * Whether an error is a request timeout (Task 13.3).
 *
 * An AbortError means the request reached LM Studio but no answer arrived inside
 * DEFAULT_TIMEOUT_MS. That is deliberately distinct from being offline.
 *
 * @param {*} error
 * @returns {boolean}
 */
function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const message = String((error && error.message) || '').toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

/**
 * Whether an error means "LM Studio could not be reached" (Task 13.1).
 *
 * When the local server is not running, `fetch` never gets a response — it fails at
 * the network layer and throws a low-level error whose message is browser jargon
 * ("Failed to fetch", "fetch failed", "NetworkError when attempting to fetch...").
 * That raw text used to leak straight into the UI, so a stopped LM Studio looked like
 * a bug ("✗ Failed to fetch") instead of the one actionable instruction the user needs.
 *
 * A timeout is deliberately NOT treated as offline: an AbortError means the server
 * accepted the connection but did not answer in time, which is Task 13.3's condition
 * and needs its own message. An HTTP error status is also not offline — that means the
 * server IS reachable and answered.
 *
 * @param {*} error - The caught error
 * @returns {boolean} true when LM Studio could not be reached
 */
function isOfflineError(error) {
  if (!error) return false;

  // A timeout is a different condition (Task 13.3) — never mislabel it as offline.
  if (error.name === 'AbortError') return false;

  const message = String((error && error.message) || error || '').toLowerCase();

  const networkSignals = [
    'failed to fetch',      // Chrome
    'fetch failed',         // Node/undici
    'networkerror',         // Firefox
    'load failed',          // Safari
    'econnrefused',
    'err_connection_refused',
    'err_connection_reset',
    'err_connection_closed',
    'err_name_not_resolved',
    'connection refused',
    'network request failed',
  ];
  if (networkSignals.some((signal) => message.includes(signal))) return true;

  // NOTE: a bare `TypeError` is deliberately NOT treated as offline here. Callers
  // convert network failures at the fetch boundary (see toNetworkError), where a
  // TypeError unambiguously means the request never left the browser. Without that
  // split, a TypeError thrown by our own response parsing — e.g. a malformed
  // `choices[0].message` — would be misreported to the user as "Cannot connect to
  // LM Studio", sending them to fix the wrong thing.
  return false;
}

/**
 * Convert an error thrown by the `fetch()` call itself into a user-facing Error.
 *
 * Only ever called around the fetch call, so a `TypeError` here can only be a network
 * failure (Chrome raises `TypeError: Failed to fetch` for an unreachable host, and
 * some engines report it with an empty message). This is the reliable place to catch
 * the bare-TypeError case that isNetworkError must ignore.
 *
 * @param {*} error
 * @returns {Error}
 */
function toNetworkError(error) {
  if (isOfflineError(error) || (error && error.name === 'TypeError')) {
    const friendly = new Error(LM_STUDIO_OFFLINE_MESSAGE);
    friendly.cause = error;
    friendly.isOffline = true;
    return friendly;
  }
  return error instanceof Error ? error : new Error(String((error && error.message) || error));
}

/**
 * Convert a caught error into a clear, user-facing Error (Task 13.1).
 *
 * Offline failures become {@link LM_STUDIO_OFFLINE_MESSAGE}; every other error keeps
 * its own message, so this never hides real diagnostics. The returned Error keeps the
 * original as `cause` so the technical detail is still available in the console.
 *
 * @param {*} error - The caught error
 * @returns {Error} an Error safe to show to the user
 */
function toUserFacingError(error) {
  if (isOfflineError(error)) {
    const friendly = new Error(LM_STUDIO_OFFLINE_MESSAGE);
    friendly.cause = error;
    friendly.isOffline = true;
    return friendly;
  }
  return error instanceof Error ? error : new Error(String((error && error.message) || error));
}

/**
 * Task 13.2 — user-facing messages for a model that cannot be used.
 *
 * `model` defaults to an empty string in DEFAULT_CONFIG, so "nothing selected" is the
 * most common form of this problem and is called out separately from "selected but not
 * loaded", because the fix differs: choose one vs. load it first.
 */
export const LM_STUDIO_NO_MODEL_MESSAGE = 'No model selected. Choose a model in Settings.';
export const LM_STUDIO_INVALID_MODEL_MESSAGE =
  'Model not available in LM Studio. Load it in LM Studio, then select it in Settings.';

/** Longest API error detail kept for display; guards against a huge body. */
const MAX_ERROR_DETAIL_CHARS = 200;

/**
 * Whether an HTTP failure from LM Studio is really about the model (Task 13.2).
 *
 * LM Studio answers an unknown model with 400/404/422 and an OpenAI-style body, e.g.
 * {"error":{"message":"Model 'foo' not found","code":"model_not_found"}}. The status
 * alone is not enough — a malformed request body is also a 400 — so the body must also
 * mention the model before we claim the model is at fault.
 *
 * @param {number} status    — HTTP status code
 * @param {string} errorText — raw response body
 * @returns {boolean} true when the failure is model-related
 */
function isModelError(status, errorText) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return String(errorText || '').toLowerCase().includes('model');
}

/**
 * Pull a short, readable detail out of an LM Studio error body.
 *
 * Prefers the OpenAI-compatible `error.message`, and falls back to the raw body. Always
 * truncated: the previous behaviour embedded the entire JSON response into an Error
 * message that was then shown in the UI and written to the activity log.
 *
 * @param {string} errorText — raw response body
 * @returns {string} a bounded detail string ('' when nothing usable)
 */
function extractErrorDetail(errorText) {
  const raw = String(errorText || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const message = parsed && parsed.error && parsed.error.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim().slice(0, MAX_ERROR_DETAIL_CHARS);
    }
  } catch (_) {
    // Not JSON — fall through to the raw text.
  }
  return raw.slice(0, MAX_ERROR_DETAIL_CHARS);
}


/**
 * Send a chat completion request to LM Studio.
 * 
 * @param {Array<Object>} messages - Array of message objects with role and content
 * @param {Object} options - Optional override for specific settings (temperature, maxTokens)
 * @param {boolean} [options.allowReasoningFallback=true] - whether an empty `content` may fall
 *        back to `reasoning_content`. Defaults to true (Phase 7.3 prose behaviour).
 *        `structuredCallOptions()` sets it false for every JSON-answering call.
 * @returns {Promise<Object>} Object with the following shape:
 *   - `text`: The assistant's reply (from `content` field, or fallback to `reasoning_content` if empty)
 *   - `reasoning`: The model's internal thinking (from `reasoning_content`, may be empty string)
 *   - `raw`: The original response payload for debugging
 * @throws {Error} If the request fails or response is invalid
 */
async function chatCompletion(messages, options = {}) {
  let abortController;
  let timeoutId;

  try {
    // Read current settings from storage
    const settings = await getSettings();

    // Get LM Studio configuration with optional overrides
    const lmStudioConfig = { ...settings.lmStudio };

    // Apply optional overrides if provided
    if (options.temperature !== undefined) {
      lmStudioConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      lmStudioConfig.maxTokens = options.maxTokens;
    }

    // ── Task 13.2: refuse early when no model is selected ──────────────────
    // `model` defaults to '' in DEFAULT_CONFIG, so this is the most common way to hit
    // the model problem. Failing here means a clear message and no pointless request,
    // instead of sending an empty model name and surfacing LM Studio's raw 400 body.
    const configuredModel = lmStudioConfig.model;
    if (typeof configuredModel !== 'string' || configuredModel.trim() === '') {
      const noModel = new Error(LM_STUDIO_NO_MODEL_MESSAGE);
      noModel.isModelError = true;
      // Recorded even though no HTTP request follows: "the model was never set" is
      // the single most common reason a call produces no response at all.
      YTAR_DEVLOG.error(C.LM_STUDIO, 'REQUEST_REJECTED', {
        requestId: options.requestId || newRequestId(),
        runId: options.runId,
        commentId: options.commentId,
        message: 'no model configured; no request was sent',
        data: { operation: options.operation || 'UNKNOWN', endpoint: null, phase: 'preflight', failureKind: 'no_model' }
      });
      throw noModel;
    }

    // Build the API URL
    const apiUrl = `${lmStudioConfig.baseUrl}/chat/completions`;

    // Prepare request headers with Bearer token authentication
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${lmStudioConfig.apiKey}`
    };

    // Build the request body
    const requestBody = {
      model: lmStudioConfig.model,
      messages,
      temperature: lmStudioConfig.temperature,
      max_tokens: lmStudioConfig.maxTokens
    };

    // Remove undefined values from request body
    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    // Create AbortController for timeout handling
    abortController = new AbortController();

    // Set up the timeout
    timeoutId = setTimeout(() => {
      abortController.abort();
    }, DEFAULT_TIMEOUT_MS);

    // ── Development diagnostics ──────────────────────────────────────────
    // One timed span per HTTP request. It opens immediately before the fetch, so it
    // measures the network call itself rather than the settings read or the model
    // check above. A request rejected by those earlier steps is logged separately
    // below, so "no diagnostic at all" can never mean "the call was attempted".
    const requestId = newRequestId();
    const operation = options.operation || 'UNKNOWN';
    const requestTimer = YTAR_DEVLOG.startTimer({
      component: C.LM_STUDIO,
      event: 'REQUEST',
      endEvent: 'REQUEST_END',
      errorEvent: 'REQUEST_ERROR',
      requestId,
      runId: options.runId,
      commentId: options.commentId,
      data: {
        operation,
        endpoint: apiUrl,
        model: lmStudioConfig.model,
        temperature: lmStudioConfig.temperature,
        maxTokens: lmStudioConfig.maxTokens,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        // The apiKey is deliberately never included. The engine redacts by key name
        // as a second line of defence, but it is simply not passed here.
        authorizationHeaderPresent: true
      }
    });

    // Send POST request to LM Studio API with abort signal
    let response;
    try {
      // Task 13.1: convert a network-level failure here, where a TypeError can only
      // mean the request never reached LM Studio.
      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortController.signal
      });
    } catch (networkError) {
      requestTimer.fail(toNetworkError(networkError), {
        operation,
        endpoint: apiUrl,
        model: lmStudioConfig.model,
        httpStatus: null,
        phase: 'fetch',
        failureKind: 'network'
      });
      throw toNetworkError(networkError);
    }

    requestTimer.done({
      operation,
      endpoint: apiUrl,
      model: lmStudioConfig.model,
      httpStatus: response.status,
      ok: response.ok,
      responseParsing: 'pending'
    });

    // Check for HTTP errors (excluding timeout which is handled by AbortSignal)
    if (!response.ok) {
      const errorText = await response.text();

      // ── Task 13.2: a model LM Studio cannot use gets a clear message ────
      // Previously the whole JSON body was embedded in the Error, so both the UI and
      // the activity log showed:
      //   LM Studio request failed: 400 - {"error":{"message":"Model 'x' not found"...}}
      if (isModelError(response.status, errorText)) {
        const invalidModel = new Error(LM_STUDIO_INVALID_MODEL_MESSAGE);
        invalidModel.isModelError = true;
        // The raw failure stays on `cause` for the console; `detail` is a short
        // readable version of what LM Studio actually said.
        invalidModel.cause = new Error(`LM Studio request failed: ${response.status} - ${errorText}`);
        invalidModel.detail = extractErrorDetail(errorText);
        throw invalidModel;
      }

      throw new Error(`LM Studio request failed: ${response.status} - ${errorText}`);
    }

    // Parse JSON response
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      const errorText = await response.text();
      throw new Error(`LM Studio returned invalid JSON: ${errorText}`);
    }

    // Validate response shape - expect OpenAI-compatible format with choices array
    if (!responseData.choices || !Array.isArray(responseData.choices) || responseData.choices.length === 0) {
      throw new Error('LM Studio returned an invalid response (no choices)');
    }

    // Extract the assistant's message from the OpenAI-compatible response shape.
    // Task 13.4: validate the shape before reading into it. Previously a missing
    // `message` threw a TypeError that the offline classifier reported as
    // "Cannot connect to LM Studio", sending the user to fix the wrong thing.
    const assistantMessage = responseData.choices[0].message;
    if (!assistantMessage || typeof assistantMessage !== 'object') {
      throw new Error('LM Studio returned a response with no message object');
    }

// The model returns both 'content' (actual reply) and 'reasoning_content' (internal thinking).
    //
    // Phase 7.3 added the reasoning fallback so a PROSE reply is never lost to a model that
    // put its thinking where the answer should be. Phase 20.24 made it conditional, because the
    // fallback is wrong for a STRUCTURED call: a verdict, a ranking and a grounding check are
    // read by a JSON parser, and a paragraph of English thinking is not a degraded answer to
    // those — it is a wrong one. Substituting it there turned "the budget ran out" into "no
    // JSON object in response", a diagnostic that sends the reader to the parser when the bug
    // was in the token budget. `resolveResponseText` owns that decision; this module only
    // supplies the transport.
    //
    // Callers opt out via `options.allowReasoningFallback: false`, which is what
    // structuredCallOptions() sets for every JSON-answering call. Prose callers keep the
    // Phase 7.3 behaviour.
    const rawContent = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
    const reasoningContent = typeof assistantMessage.reasoning_content === 'string'
      ? assistantMessage.reasoning_content
      : '';

    const text = resolveResponseText(rawContent, reasoningContent, options.allowReasoningFallback);

    // Task 13.4 — an empty completion must become a clear `failed`, never an attempt to
    // publish nothing. Raised here so the service worker records the failure and never
    // hands a reply to the content script.
    //
    // Phase 20.24 — a STRUCTURED call gets its own message, and this is the whole point of
    // the opt-out. LM_STUDIO_EMPTY_RESPONSE_MESSAGE is user-facing prose written for a reply
    // ("Try again, or choose a different model"), which is actively misleading for a
    // classification: the model is reachable, it answered, and nothing about choosing a
    // different model or retrying would help. The actual cause is visible right here —
    // reasoning text came back and content did not, which means the ceiling was consumed
    // before the answer was written.
    if (!text || typeof text !== 'string' || text.trim() === '') {
      const empty = new Error(
        options.allowReasoningFallback === false && reasoningContent.trim()
          ? LM_STUDIO_REASONING_BUDGET_MESSAGE
          : LM_STUDIO_EMPTY_RESPONSE_MESSAGE
      );
      empty.isEmptyResponse = true;
      // Carried on the error so a caller can distinguish "the model produced no answer" from
      // "the answer was cut off", which have different fixes.
      empty.isReasoningBudget = options.allowReasoningFallback === false && !!reasoningContent.trim();
      throw empty;
    }

    // Return the result with extracted text, reasoning (if any), and raw response for debugging
    // The parsing outcome is recorded separately from the transport outcome: a request
    // can succeed at the HTTP level and still produce nothing usable, and those are
    // two different problems.
    YTAR_DEVLOG.log({
      component: C.LM_STUDIO,
      event: 'RESPONSE_PARSED',
      requestId,
      level: L.DEBUG,
      data: {
        operation,
        model: lmStudioConfig.model,
        httpStatus: response.status,
        textChars: text ? text.length : 0,
        reasoningChars: reasoningContent ? reasoningContent.length : 0,
        // Content only. The text itself is never logged here — it is the model's
        // answer and can be a full reply.
        contentPresent: !!text
      }
    });

    return {
      text,
      reasoning: reasoningContent,
      raw: responseData
    };

  } catch (error) {
    // Task 13.3 — a timeout is recorded, and nothing is ever published from it.
    if (isTimeoutError(error)) {
      logError('LM Studio request timed out after', DEFAULT_TIMEOUT_MS, 'ms');
      const timedOut = new Error(LM_STUDIO_TIMEOUT_MESSAGE);
      timedOut.isTimeout = true;
      timedOut.cause = error;
      throw timedOut;
    }

    // Log and re-throw other errors, converting an unreachable LM Studio into the
    // clear Task 13.1 message instead of leaking raw browser fetch jargon.
    logError('LM Studio API error:', error.message);
    throw toUserFacingError(error);
  } finally {
    // Clean up the timeout timer if it's still running
    if (abortController && timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Get available models from LM Studio.
 * 
 * @returns {Promise<Array<Object>>} Array of model objects with id and object type
 * @throws {Error} If the request fails or response is invalid
 */
async function getModels() {
  let abortController;
  let timeoutId;

  try {
    // Read current settings from storage
    const settings = await getSettings();

    // Build the API URL for models endpoint
    const apiUrl = `${settings.lmStudio.baseUrl}/models`;

    // Prepare request headers with Bearer token authentication
    const headers = {
      'Authorization': `Bearer ${settings.lmStudio.apiKey}`
    };

    // Create AbortController for timeout handling
    abortController = new AbortController();

    // Set up the timeout (reuse the shared 60-second timeout)
    timeoutId = setTimeout(() => {
      abortController.abort();
    }, DEFAULT_TIMEOUT_MS);

    // Send GET request to LM Studio models endpoint with abort signal
    let response;
    const modelsTimer = YTAR_DEVLOG.startTimer({
      component: C.LM_STUDIO,
      event: 'REQUEST',
      endEvent: 'REQUEST_END',
      errorEvent: 'REQUEST_ERROR',
      requestId: newRequestId(),
      data: { operation: 'MODEL_LIST', endpoint: apiUrl, model: null, method: 'GET' }
    });
    try {
      // Task 13.1: convert a network-level failure at the fetch boundary.
      response = await fetch(apiUrl, {
        method: 'GET',
        headers,
        signal: abortController.signal
      });
    } catch (networkError) {
      modelsTimer.fail(toNetworkError(networkError), {
        operation: 'MODEL_LIST', endpoint: apiUrl, httpStatus: null, phase: 'fetch', failureKind: 'network'
      });
      throw toNetworkError(networkError);
    }
    modelsTimer.done({ operation: 'MODEL_LIST', endpoint: apiUrl, httpStatus: response.status, ok: response.ok });

    // Check for HTTP errors (excluding timeout which is handled by AbortSignal)
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LM Studio request failed: ${response.status} - ${errorText}`);
    }

    // Parse JSON response
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      const errorText = await response.text();
      throw new Error(`LM Studio returned invalid JSON: ${errorText}`);
    }

    // Validate response shape - expect OpenAI-compatible format with data array
    if (!responseData.data || !Array.isArray(responseData.data)) {
      throw new Error('LM Studio returned an invalid models response');
    }

    // Return the model list as an array
    return responseData.data;

  } catch (error) {
    // Task 13.3 — a timeout is recorded, and nothing is ever published from it.
    if (isTimeoutError(error)) {
      logError('LM Studio request timed out after', DEFAULT_TIMEOUT_MS, 'ms');
      const timedOut = new Error(LM_STUDIO_TIMEOUT_MESSAGE);
      timedOut.isTimeout = true;
      timedOut.cause = error;
      throw timedOut;
    }

    // Log and re-throw other errors, converting an unreachable LM Studio into the
    // clear Task 13.1 message instead of leaking raw browser fetch jargon.
    logError('LM Studio API error:', error.message);
    throw toUserFacingError(error);
  } finally {
    // Clean up the timeout timer if it's still running
    if (abortController && timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export { chatCompletion, getModels };