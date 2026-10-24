/**
 * Fixed Reply Module - YouTube Auto Reply Extension
 *
 * Phase 19.6 — an optional per-trigger reply mode.
 *
 * TWO SEPARATE LM STUDIO RESPONSIBILITIES
 *
 *   1. Semantic trigger matching — "does this comment express the intent of one of my
 *      trigger phrases?" (src/core/semantic-matcher.js). Unchanged by this module and
 *      still allowed to consult LM Studio for a trigger that has a fixed reply.
 *   2. Reply generation — "write a reply to this comment." (src/core/prompt-builder.js
 *      plus the API client). This is the responsibility a fixed reply REPLACES.
 *
 * The whole point of this module is that a fixed reply is used VERBATIM. It must not be
 * rewritten, paraphrased, translated, shortened, expanded or otherwise touched by a model,
 * so this module does no normalization of any kind: no `trim()`, no case folding, no
 * Arabic normalization, no whitespace collapsing. The only test applied to the text is
 * whether anything is left after trimming, and that result is used to VALIDATE, never to
 * produce the stored or published value.
 *
 * It deliberately does not import anything else: no `chrome.*`, no DOM, no network, no
 * storage. Both the service worker and the browser test pages call it directly.
 *
 * @namespace FixedReply
 */

/**
 * The reply modes a trigger rule can carry.
 *
 * A rule with no `replyMode` at all — every rule stored before Phase 19.6 — behaves as
 * `ai`, which is what `resolveReplyMode()` returns for it.
 */
export const REPLY_MODES = Object.freeze({
  /** LM Studio writes the reply. The behaviour that existed before Phase 19.6. */
  AI: 'ai',
  /** The rule's own `fixedReply` text is the reply. LM Studio is not asked to write one. */
  FIXED: 'fixed',
});

/** The reply modes in storage order, for the Options selector. */
export const VALID_REPLY_MODES = Object.freeze([REPLY_MODES.AI, REPLY_MODES.FIXED]);

/**
 * Read a rule's reply mode, defaulting to `ai`.
 *
 * Only the exact string `fixed` selects fixed mode. An absent field, `null`, `undefined`,
 * an unknown string, or a non-string all resolve to `ai`, so a hand-edited or partially
 * written rule can never accidentally suppress AI generation.
 *
 * @param {Object} [rule] - a trigger rule
 * @returns {string} REPLY_MODES.AI or REPLY_MODES.FIXED
 */
export function resolveReplyMode(rule) {
  if (!rule || typeof rule !== 'object') return REPLY_MODES.AI;
  return rule.replyMode === REPLY_MODES.FIXED ? REPLY_MODES.FIXED : REPLY_MODES.AI;
}

/**
 * The rule's fixed reply text, exactly as configured.
 *
 * Returned unchanged — not trimmed, not normalized, not re-encoded. Internal line breaks,
 * Arabic characters, punctuation, emoji and spacing all survive verbatim. Leading and
 * trailing whitespace is deliberately preserved too, because "exactly as written" is the
 * contract; the emptiness check below is what looks past that whitespace, not the value
 * that gets returned.
 *
 * @param {Object} [rule] - a trigger rule
 * @returns {string} the configured text, or '' when there is none
 */
export function getFixedReplyText(rule) {
  if (!rule || typeof rule !== 'object') return '';
  return typeof rule.fixedReply === 'string' ? rule.fixedReply : '';
}

/**
 * Whether a rule has usable fixed-reply text.
 *
 * This is a validity question, not a transformation: it answers "is there anything to
 * publish", by checking the trimmed length without ever modifying the text.
 *
 * @param {Object} [rule]
 * @returns {boolean}
 */
export function hasUsableFixedReply(rule) {
  return getFixedReplyText(rule).trim().length > 0;
}

/**
 * Decide how a matched rule's reply should be produced.
 *
 * The single decision point the service worker asks, so the rule is stated in exactly one
 * place: a fixed reply is used only when the mode is `fixed` AND there is real text to
 * use. A `fixed` rule with empty or whitespace-only text falls back to `ai` rather than
 * publishing nothing — the CRUD layer refuses to save that combination in the first place,
 * so this only covers a rule that was hand-edited into storage.
 *
 * @param {Object} [rule] - the matched trigger rule
 * @returns {{mode: string, text: string}} `mode` is REPLY_MODES.FIXED only when `text`
 *   is the rule's own reply, verbatim.
 */
export function resolveReplySource(rule) {
  if (resolveReplyMode(rule) === REPLY_MODES.FIXED) {
    const text = getFixedReplyText(rule);
    if (text.trim().length > 0) {
      return { mode: REPLY_MODES.FIXED, text };
    }
  }
  return { mode: REPLY_MODES.AI, text: '' };
}

/**
 * Validate a fixed reply before it is saved.
 *
 * `trim()` is used ONLY to decide whether the box is empty. The value a caller stores is
 * the one it was given, untouched — so punctuation, Arabic characters, spacing, emoji and
 * line breaks are preserved exactly as typed.
 *
 * @param {string} value - the raw textarea contents
 * @returns {{valid: boolean, reason: (string|null)}} reason is a stable token for tests
 */
export function validateFixedReply(value) {
  if (typeof value !== 'string') {
    return { valid: false, reason: 'NOT_A_STRING' };
  }
  if (value.trim().length === 0) {
    return { valid: false, reason: 'EMPTY' };
  }
  return { valid: true, reason: null };
}

/**
 * Validate a whole rule's reply fields together.
 *
 * `replyMode` itself is not validated against VALID_REPLY_MODES here: an unknown value is
 * already treated as `ai` by resolveReplyMode(), which is the safer reading of a bad
 * value. What IS enforced is the invariant that matters — a rule in fixed mode must carry
 * usable text.
 *
 * @param {Object} rule
 * @returns {{valid: boolean, reason: (string|null)}}
 */
export function validateReplyFields(rule) {
  if (resolveReplyMode(rule) === REPLY_MODES.FIXED) {
    return validateFixedReply(getFixedReplyText(rule));
  }
  return { valid: true, reason: null };
}
