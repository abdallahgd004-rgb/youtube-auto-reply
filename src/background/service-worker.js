// Background Service Worker - YouTube Auto Reply Extension
// Phase 6.3: Matching logic with trigger rules
// Phase 9.x: Deduplication — handled-comments store + in-session reply deduplicator

console.log('[YouTube Auto Reply] Background service worker initialized');

import { getModels, chatCompletion } from './api-client.js';
import { getTriggers } from '../core/trigger-crud.js';
import { match as containsMatch } from '../core/matchers/contains-matcher.js';
import { match as exactMatch } from '../core/matchers/exact-matcher.js';
import { buildReplyPrompt } from '../core/prompt-builder.js';
import { getSettings } from '../core/storage.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { isLimitReached, recordReply } from '../core/reply-rate-limiter.js';

// Phase 9.x — Deduplication imports
import { createFingerprint } from '../core/comment-fingerprint.js';
import { isHandled, markHandled } from '../core/handled-comments.js';
import { createReplyDeduplicator } from '../core/reply-deduplicator.js';

// Phase 10.2 — One-at-a-time job queue
import { createQueue } from '../core/queue.js';
const jobQueue = createQueue();

// In-session reply deduplicator (fast path).
// NOTE: This state is lost when the service worker is killed and restarted.
// That is acceptable — the persistent `handledComments` store in chrome.storage.local
// is the real guard; this deduplicator just avoids redundant LM Studio calls within a session.
const replyDedup = createReplyDeduplicator();

// Platform constant for this single-platform MVP (YouTube only).
const PLATFORM_SITE = 'YouTube';

// ─── Phase 10.2 — Sequential job processor ────────────────────────────────
/**
 * Process a single COMMENT_DETECTED job.
 *
 * This is the EXISTING per-comment logic moved verbatim from the listener,
 * preserving every log line, every response field name, and the exactly-once
 * sendResponse behaviour.  The only structural change is that it receives its
 * inputs as properties on `job` instead of reading them from closure variables.
 */
let workerRunning = false;
let rateLimitPaused = false; // suppress repeated pause logging across polls

/**
 * Resolve the minimum inter-job delay, falling back to the configured default.
 *
 * A valid value is a finite number >= 0. `0` is valid and means "no delay".
 * Anything else (missing, undefined, null, NaN, Infinity, negative, string,
 * boolean) falls back to DEFAULT_CONFIG so an invalid setting can never produce
 * a 0ms delay by accident, nor an unbounded or hanging wait.
 *
 * @param {*} rawValue — the untrusted settings value
 * @returns {number} a finite, non-negative delay in milliseconds
 */
function resolveMinDelayMs(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
    return rawValue;
  }
  console.warn(
    '[YouTube Auto Reply] invalid replyBehavior.minDelayMs, using default:',
    DEFAULT_CONFIG.replyBehavior.minDelayMs
  );
  return DEFAULT_CONFIG.replyBehavior.minDelayMs;
}

/**
 * Resolve the maximum inter-job delay, falling back to the configured default.
 *
 * A valid value is a finite number >= 0. `0` is valid. Anything else falls back to
 * DEFAULT_CONFIG. A value SMALLER than the resolved minimum is treated as
 * inverted-range user error and clamped up to the minimum, so the final random
 * delay can never end up below minDelayMs.
 *
 * @param {*} rawValue — the untrusted settings value
 * @param {number} minDelayMs — the already-resolved minimum, used as the floor
 * @returns {number} a finite, non-negative maximum delay in milliseconds
 */
function resolveMaxDelayMs(rawValue, minDelayMs) {
  let max;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
    max = rawValue;
  } else {
    console.warn(
      '[YouTube Auto Reply] invalid replyBehavior.maxDelayMs, using default:',
      DEFAULT_CONFIG.replyBehavior.maxDelayMs
    );
    max = DEFAULT_CONFIG.replyBehavior.maxDelayMs;
  }
  if (max < minDelayMs) {
    console.warn(
      '[YouTube Auto Reply] replyBehavior.maxDelayMs is below minDelayMs, clamping to minDelayMs'
    );
    return minDelayMs;
  }
  return max;
}

/**
 * Pick a random whole-millisecond delay within an inclusive [min, max] range.
 *
 * The `+ 1` makes the range inclusive of `max`, so both endpoints are reachable.
 * The final clamp guards against any caller passing a reversed range, which would
 * otherwise make the multiplier negative and produce a delay outside the range.
 *
 * @param {number} min — inclusive lower bound, a finite number >= 0
 * @param {number} max — inclusive upper bound, a finite number >= min
 * @returns {number} an integer in [min, max]
 */
function randomDelayMs(min, max) {
  const span = max - min + 1;
  const picked = Math.floor(min + Math.random() * span);
  return Math.min(Math.max(picked, min), max);
}

/**
 * Resolve the hourly reply cap, falling back to the configured default.
 *
 * A valid value is a positive finite number. Anything else — missing, undefined,
 * null, NaN, Infinity, zero, negative, string, boolean — falls back to
 * DEFAULT_CONFIG. A cap that resolved to 0 or NaN must never be treated as a real
 * cap, because "limit reached" would then be permanently true and the extension
 * would stop replying forever.
 *
 * @param {*} rawValue — the untrusted settings value
 * @returns {number} a positive finite cap, or 0 meaning "no limit"
 */
function resolveMaxRepliesPerHour(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }
  console.warn(
    '[YouTube Auto Reply] invalid replyBehavior.maxRepliesPerHour, using default:',
    DEFAULT_CONFIG.replyBehavior.maxRepliesPerHour
  );
  return DEFAULT_CONFIG.replyBehavior.maxRepliesPerHour;
}

/**
 * Start the worker loop if it is not already running.
 *
 * The guard ensures at most one drain-loop runs at any time — jobs are
 * processed strictly FIFO, one-at-a-time.
 */
function ensureWorkerRunning() {
  if (workerRunning) return;
  workerRunning = true;
  (async () => {
    try {
      while (!jobQueue.isEmpty()) {
        // ── Phase 10.5: hourly reply cap ─────────────────────────────────
        // Checked BEFORE dequeuing, so a capped job stays in the queue rather
        // than being consumed and dropped. We wait and re-check on the next
        // iteration, which polls roughly once per min-delay interval and lets
        // the rolling window expire naturally. We never sleep for the whole
        // window, and we never drop the job.
        const rateSettings = await getSettings();
        const replyCap = resolveMaxRepliesPerHour(rateSettings?.replyBehavior?.maxRepliesPerHour);
        if (replyCap > 0 && (await isLimitReached(replyCap))) {
          if (!rateLimitPaused) {
            console.warn('[YouTube Auto Reply] hourly reply cap reached, pausing queue');
            rateLimitPaused = true;
          }
          await new Promise((resolve) => setTimeout(resolve, resolveMinDelayMs(rateSettings?.replyBehavior?.minDelayMs) || 1000));
          continue;
        }
        if (rateLimitPaused) {
          console.log('[YouTube Auto Reply] hourly reply cap cleared, queue resumed');
          rateLimitPaused = false;
        }

        const job = jobQueue.dequeue();
        try {
          await processJob(job);
        } catch (error) {
          console.error('[YouTube Auto Reply] job processor: unhandled error, continuing:', error.message);
          try { job.respondOnce({ success: false, error: `Processing failed: ${error.message}` }); }
          catch (_) {}
        }

        // ── Phase 10.4: random delay between jobs (within min/max) ─────
        // Only wait if another job is actually waiting. The delay is measured
        // from THIS point (after the previous job finished), so the previous
        // job's processing time is not counted toward it.
        // sendResponse already fired inside processJob, so the content script
        // is not made to wait out this gap.
        if (!jobQueue.isEmpty()) {
          const settings = await getSettings();
          const minDelayMs = resolveMinDelayMs(settings?.replyBehavior?.minDelayMs);
          const maxDelayMs = resolveMaxDelayMs(settings?.replyBehavior?.maxDelayMs, minDelayMs);
          const delayMs = randomDelayMs(minDelayMs, maxDelayMs);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      workerRunning = false;
    }
  })();
}

async function processJob(job) {
  const { id, text, fingerprint } = job;

  // ── Phase 9.x: Build fingerprint and check handled store ───────────────
  if (await isHandled(fingerprint)) {
    console.log(`[YouTube Auto Reply] COMMENT_DETECTED: SKIPPED_ALREADY_HANDLED - fp=${fingerprint}`);
    job.respondOnce({ success: true, id, result: 'SKIPPED_ALREADY_HANDLED' });
    return;
  }

  // Fetch trigger rules and perform matching
  let verdict = { success: true, id };
  try {
    const triggers = await getTriggers();

    // Filter to only enabled rules with non-empty phrases arrays
    const activeRules = triggers.filter(rule => rule.enabled && Array.isArray(rule.phrases) && rule.phrases.length > 0);

    if (activeRules.length === 0) {
      console.log('[YouTube Auto Reply] COMMENT_DETECTED: NO_MATCH - no enabled rules');
      verdict.result = 'NO_MATCH';
    } else {
      // Iterate through active rules; first match wins
      for (const rule of activeRules) {
        let matchedResult;

        if (rule.matchMode === 'contains') {
          matchedResult = containsMatch(text, rule.phrases, rule.caseSensitive);
        } else if (rule.matchMode === 'exact') {
          matchedResult = exactMatch(text, rule.phrases, rule.caseSensitive);
        } else {
          // Unknown match mode - skip this rule
          console.warn(`[YouTube Auto Reply] COMMENT_DETECTED: skipping rule ${rule.id} with unknown matchMode "${rule.matchMode}"`);
          continue;
        }

        if (matchedResult.matched) {
          const matchedPhrase = matchedResult.matchedPhrase || '';
          console.log(`[YouTube Auto Reply] COMMENT_DETECTED: MATCH - id=${id}, result=MATCH, phrase="${matchedPhrase}"`);
          verdict.result = 'MATCH';
          verdict.matchedPhrase = matchedPhrase;
          verdict.ruleId = rule.id;
          break; // First match wins
        }
      }

      if (!verdict.result) {
        console.log('[YouTube Auto Reply] COMMENT_DETECTED: NO_MATCH - no rules matched');
        verdict.result = 'NO_MATCH';
      }
    }
  } catch (error) {
    console.error('[YouTube Auto Reply] COMMENT_DETECTED error:', error.message);
    job.respondOnce({ success: false, error: `Matching failed: ${error.message}` });
    return;
  }

  // Only attempt generation when verdict.result === 'MATCH'
  if (verdict.result === 'MATCH') {
    let settings;
    let messages;
    try {
      settings = await getSettings();
      messages = buildReplyPrompt({ text }, settings);
    } catch (error) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED: Prompt build failed:', error.message);
      job.respondOnce({ success: false, error: `Prompt build failed: ${error.message}` });
      return;
    }

    try {
      console.log(`[YouTube Auto Reply] COMMENT_DETECTED: generation attempted for comment id=${verdict.id}`);
      const result = await chatCompletion(messages);

      // Log outcome AFTER the call resolves
      const replyText = result.text || '';
      console.log(`[YouTube Auto Reply] COMMENT_DETECTED: generation completed for comment id=${verdict.id}, reply length=${replyText.length}, preview="${(replyText || '').substring(0, 100)}..."`);
      verdict.reply = replyText;

      // ── Two independent decisions, deliberately decoupled ───────────────
      // 1. In-session reply deduplication (replyDedup): may suppress
      //    near-identical replies across different comments in the same cycle.
      // 2. Persistent marking (markHandled): records that THIS comment was
      //    handled so it won't be replayed after a service-worker restart.
      // The persistent store must NOT depend on reply similarity — two
      // different comments should both be recorded even if their replies
      // are near-duplicates (Rule 4 of the deduplicator). See bug #2.

      // Decision A: in-session reply deduplication verdict.
      const isReplyDuplicate = replyDedup.isDuplicate({
        reply: replyText,
        commentId: verdict.id,
      });
      if (isReplyDuplicate) {
        console.log(
          `[YouTube Auto Reply] COMMENT_DETECTED: in-session duplicate suppressed - fp=${fingerprint}`
        );
      }

      // Decision B: persistent marking — independent of reply similarity.
      // Only mark when generation succeeded, the reply is non-empty,
      // and dry-run is disabled. An empty reply is not a real reply;
      // persisting it would silently lose the comment.
      if (replyText && !settings.dryRun) {
        await markHandled(fingerprint);
        // Only a genuinely posted reply counts against the hourly cap. In dry-run
        // nothing is posted, so counting it would let test runs exhaust the cap
        // and make the extension look rate-limited when it never actually replied.
        await recordReply();
      }
    } catch (error) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED: Generation failed:', error.message);
      job.respondOnce({ success: false, error: `Generation failed: ${error.message}` });
      return;
    }
  }

  job.respondOnce(verdict);
}

// Single consolidated message handler for all message types
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === 'openPopup') {
    chrome.tabs.create({ url: 'popup/popup.html' });
    return true; // Keep channel open for sendResponse
  }
  
  if (message.action === 'openOptions') {
    chrome.tabs.create({ url: 'options/options.html' });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'GET_LM_STUDIO_MODELS') {
    getModels()
      .then(models => {
        sendResponse({ success: true, models });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Error getting models:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CONNECTION') {
    // Use chatCompletion with a minimal request to test connectivity
    const messages = [
      { role: 'user', content: 'ping' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ 
          success: true, 
          model: result.raw.model || 'unknown',
          text: result.text?.substring(0, 50) + (result.text && result.text.length > 50 ? '...' : '')
        });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Connection test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CHAT_COMPLETION') {
    // Non-destructive test that returns full chat completion response
    const messages = [
      { role: 'user', content: 'Say hello' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ success: true, text: result.text });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Chat completion test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'GET_ENABLED_STATE') {
    chrome.storage.local.get('enabled', result => {
      const enabled = result.enabled !== undefined ? result.enabled : false;
      sendResponse({ enabled: enabled });
      return true; // Keep channel open for sendResponse
    });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'COMMENT_DETECTED') {
    const { id, author, text } = message.data || {};

    // Defensive: guard against missing/malformed payload
    if (!id) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED received invalid payload:',
        'missing id field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (id)' });
      return true;
    }
    if (!text) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED received invalid payload:',
        'missing text field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (text)' });
      return true;
    }

    // Normalize author for logging; empty is valid.
    const logAuthor = author || 'unknown';
    const textPreview = text.length > 100 ? text.substring(0, 100) + '...' : text;
    console.log('[YouTube Auto Reply] COMMENT_DETECTED received:',
      `id=${id}, author=${logAuthor}, text="${textPreview}"`);

    // Capture everything SYNCHRONOUSLY — sender.tab.url may be invalid after await.
    const comment = message.data?.comment;
    const pageInfo = {
      site: PLATFORM_SITE,
      url: sender.tab?.url,
    };
    const fingerprint = createFingerprint(comment, pageInfo);

    // Enqueue the job and start (or keep) the worker.
    // Only `id` is required (dedup key); `text` validated in parseComment; `author` may be empty.
    let _responded = false;
    const respondOnce = (response) => {
      if (!_responded) {
        _responded = true;
        sendResponse(response);
      }
    };
    const job = { id, text, fingerprint, respondOnce };
    jobQueue.enqueue(job);
    ensureWorkerRunning();
    return true;
  }

  // Default response for unknown message types
  sendResponse({ status: 'ok' });
  return true;
});

// Log startup message for verification
chrome.runtime.onInstalled.addListener(() => {
  console.log('[YouTube Auto Reply] Extension installed');
});