/**
 * Reasoning-Model Token Budgets — Phase 20.24
 *
 * ONE owner for a rule that was broken in five places at once.
 *
 * ── The bug this module exists to prevent ────────────────────────────────────
 *
 * Every STRUCTURED call in this codebase (one whose answer must be parsed as JSON) used to
 * size `maxTokens` against the SIZE OF THE PAYLOAD ALONE — 64 tokens for a verdict that reads
 * `{"matched":false}`, 300 for a grounding check that reads `{"supported":true}`.
 *
 * That is only correct for a model that emits no thinking. The model actually in use,
 * `google/gemma-4-e2b`, is a REASONING model: it spends its budget thinking before it writes
 * anything, and that thinking is billed against `max_tokens` exactly like output is. Measured
 * against the running LM Studio server:
 *
 *     max_tokens=64   → finish_reason:"length", content:""   , reasoning_tokens:61
 *     max_tokens=256  → finish_reason:"stop"  , content:'{"matched":false}', reasoning_tokens:202
 *
 * So every one of those budgets was consumed entirely by thinking, `content` came back EMPTY,
 * and the extension had no answer to parse. `api-client.js` then substituted the thinking text
 * in its place, and the matcher reported "no JSON object in response" — a diagnostic that
 * points at the PARSER when the bug was in the BUDGET. Measured per call, on gemma-4-e2b:
 *
 *     semantic-matcher.js    budget   64 → reasoning used 202  ✗ empty content
 *     intent-analyzer.js     budget  200 → reasoning used 184  ✓ 16 tokens of headroom
 *     answerability-gate.js  budget  300 → reasoning used 399  ✗ empty content
 *     grounding-validator.js budget  300 → reasoning used 376  ✗ empty content
 *     knowledge-retrieval.js budget  600 → reasoning used 483  ✓ 117 tokens of headroom
 *
 * Note `intent-analyzer.js`: it passed, with sixteen tokens to spare. A rule that only fails
 * sometimes, on some comments, with no error anywhere else, is the worst kind to debug — which
 * is why this is now a rule with one owner rather than five numbers to remember.
 *
 * ── WHY A GENEROUS CEILING IS FREE ──────────────────────────────────────────
 *
 * The temptation is to size this tightly: measure the worst case, add a little, move on. That
 * is the wrong instinct here, and the reason is specific.
 *
 * `max_tokens` is a CEILING, not a reservation. The model stops on its own — `finish_reason`
 * comes back `"stop"` — and the unused remainder is simply never generated. Measured: a
 * 1500-token ceiling that finished in 264 cost 264. Raising the ceiling costs nothing when the
 * model finishes early; it only changes the outcome in the one case that matters, which is a
 * model that would otherwise be CUT OFF mid-thought.
 *
 * So the correct number is "comfortably more than any reasoning trace we have seen", not "just
 * enough". 1024 covers gemma-4-e2b's observed worst case (483, the twelve-section rerank) with
 * room over, and it also covers the ~628 tokens `config.js` already records for qwen3.5-9b.
 * A larger model with a longer habit of thinking needs more, and raising one constant is the
 * whole cost of finding out.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
 *
 * It does not estimate, predict or probe. There is no "reasoning happens to be about X% of
 * the budget" heuristic to tune, because that number is a property of the model AND the prompt
 * AND the comment, and a heuristic built on one measurement is exactly the kind of confident
 * guess that produces a silent failure. A ceiling either clears the thinking or it does not,
 * and a ceiling is free when it clears it.
 *
 * PURE by construction: no `chrome.*`, no DOM, no `fetch`. The active-model check reads from a
 * list the CALLER already fetched, so this module can be unit-tested without a server — the
 * same rule `markdown-parser.js` follows and `verify-extension.mjs` enforces.
 */

/**
 * Tokens reserved for a reasoning model's thinking, on top of the payload budget.
 *
 * A caller states the size of the ANSWER it needs to read; this is the space the model spends
 * before producing it. Deliberately far above every measurement in the header — see "why a
 * generous ceiling is free" for why overshooting is not the risk it looks like.
 */
export const REASONING_HEADROOM_TOKENS = 1024;

/**
 * Build the options for a structured (JSON-answering) LM Studio call.
 *
 * Every structured caller goes through this rather than passing `maxTokens` directly, for the
 * same reason `knowledge-store.js` is the sole writer of the knowledge keys: one rule, one
 * place. A sixth structured call added later gets the headroom by calling this, and cannot
 * forget it — whereas a bare `maxTokens` is a number that looks correct and is not.
 *
 * `maxTokens` in the argument is the size of the PAYLOAD (the JSON this call must be able to
 * emit), not the size of the request. The returned figure is the ceiling to send.
 *
 * `allowReasoningFallback: false` is set here, not left to the caller, because it is not a
 * preference — it is a property of the call. A verdict, a ranking, an intent and a grounding
 * check are all read by a parser that expects JSON, and a paragraph of English thinking is not
 * a degraded answer to those questions; it is a wrong one that gets reported as "no JSON
 * object in response". Opting out makes an exhausted budget surface as what it is — an empty
 * response — instead of as a parse failure that sends the reader to the wrong file.
 *
 * @param {Object} spec
 * @param {number} spec.maxTokens - payload budget: the size of the JSON answer this call reads
 * @param {string} spec.operation - diagnostic-log operation name, e.g. 'SEMANTIC_MATCH'
 * @param {number} [spec.temperature] - defaults to 0: structured calls are decisions, and the
 *        same input must produce the same verdict every time it is re-run
 * @returns {{temperature: number, maxTokens: number, operation: string,
 *   allowReasoningFallback: false}}
 */
export function structuredCallOptions({ maxTokens, operation } = {}) {
  const payload = Number(maxTokens);

  return {
    temperature: 0,
    maxTokens: (Number.isFinite(payload) && payload > 0 ? payload : 0) + REASONING_HEADROOM_TOKENS,
    operation: typeof operation === 'string' ? operation : 'UNKNOWN',
    // See the note above: for a structured call the thinking is never the answer.
    allowReasoningFallback: false,
  };
}

/**
 * Whether a response's `content` is usable under the given fallback policy.
 *
 * Lives here rather than in `api-client.js` because the DECISION belongs to this module and
 * only the transport belongs to the client. `chatCompletion` asks; it does not rule.
 *
 * @param {string} content - `choices[0].message.content`
 * @param {string} reasoning - `choices[0].message.reasoning_content`
 * @param {boolean} allowReasoningFallback
 * @returns {string} the text to use, or '' when neither field is usable
 */
export function resolveResponseText(content, reasoning, allowReasoningFallback) {
  const primary = typeof content === 'string' ? content : '';
  if (primary.trim()) return primary;

  // A structured call stops here. The caller reports an empty response, which points at the
  // budget; substituting the thinking text instead would report a parse failure and point at
  // the parser.
  if (allowReasoningFallback === false) return '';

  const fallback = typeof reasoning === 'string' ? reasoning : '';
  return fallback;
}

/**
 * Identify the model LM Studio currently has loaded, from a list it reports.
 *
 * WHY NOT JUST ASK FOR ANY MODEL: LM Studio serves several models and they do not reason
 * alike. A budget verified against one says nothing about another, and quietly testing against
 * whichever model happened to load is how a fix gets "verified" while the user's actual model
 * stays broken. So the active model is resolved first and everything downstream is pinned to it.
 *
 * AMBIGUITY IS AN ERROR, not a coin flip. With more than one model loaded there is no single
 * "the active model" — LM Studio will serve whichever one a request names — so guessing would
 * produce a verification result that describes no real configuration. The caller is told, and
 * the human decides which one to unload.
 *
 * The caller supplies the list (from LM Studio's REST API, which exposes per-model load state;
 * the OpenAI-compatible `/v1/models` endpoint the extension itself uses does not). This module
 * therefore performs no network I/O and stays testable without a server.
 *
 * @param {Array<Object>} models - LM Studio model records, each with `id` and `state`
 * @returns {{ok: true, id: string} | {ok: false, reason: string, loaded: string[]}}
 */
export function resolveActiveModel(models) {
  if (!Array.isArray(models)) {
    return { ok: false, reason: 'no model list was supplied', loaded: [] };
  }

  const loaded = models
    .filter((m) => m && typeof m.id === 'string' && m.state === 'loaded')
    .map((m) => m.id);

  if (loaded.length === 0) {
    return {
      ok: false,
      reason: 'LM Studio reports no loaded model, so there is no model to verify against',
      loaded,
    };
  }

  if (loaded.length > 1) {
    return {
      ok: false,
      reason:
        'LM Studio has more than one model loaded (' +
        loaded.join(', ') +
        '), so there is no single active model to pin the verification to — unload all but one',
      loaded,
    };
  }

  return { ok: true, id: loaded[0], loaded };
}

/**
 * Assert that the model LM Studio has loaded is the one the caller expects.
 *
 * Fails LOUDLY and by NAME. The alternative — reporting a clean run against whatever was
 * loaded — is the specific failure mode this whole module exists to end: a verified budget
 * for a model the user does not run is worse than no verification at all, because it reads as
 * proof the problem is solved.
 *
 * @param {Array<Object>} models - LM Studio model records
 * @param {string} expectedId - the model id the verification was written against
 * @returns {{ok: true, id: string} | {ok: false, reason: string, loaded: string[]}}
 */
export function assertActiveModel(models, expectedId) {
  const active = resolveActiveModel(models);
  if (!active.ok) return active;

  if (active.id !== expectedId) {
    return {
      ok: false,
      reason:
        `the loaded model is "${active.id}" but this verification was written against ` +
        `"${expectedId}" — every number in it was measured on the other one, so a pass here ` +
        'would describe a configuration that is not running',
      loaded: active.loaded,
    };
  }

  return active;
}