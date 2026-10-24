/**
 * Reply Modes — Phase 20.14
 *
 * §25: the extension supports three modes, and the existing trigger system must not be removed.
 *
 *   TRIGGER   comment → trigger → match → reply. The behaviour that shipped for Phase 1–19 and
 *             what every existing user has.
 *   KNOWLEDGE comment → understand → search → answerability → grounded reply. The full
 *             pipeline from 20.6–20.11.
 *   HYBRID    trigger first, knowledge only as a FALLBACK when no trigger matched. §25 calls
 *             this the recommended long-term mode, because it preserves existing behaviour and
 *             adds coverage rather than replacing it.
 *
 * ── The default is TRIGGER, and that is not a formality ───────────────────────
 *
 * Adding a mode must not change what anybody gets today. A user upgrading has no knowledge base
 * yet, so defaulting to Knowledge would silently send every comment through retrieval and
 * answerability against an empty base — every comment skipped, with no error anywhere.
 *
 * The same reasoning applies to an UNRECOGNISED stored value. It falls back to TRIGGER, never to
 * Knowledge: a bad value must not be able to switch a user onto a mode they never chose, and
 * falling back to the mode that works with no configuration is the recoverable direction.
 *
 * ── The pipeline descriptor is the real content ───────────────────────────────
 *
 * Rather than each caller comparing mode strings, `describeReplyMode()` returns what each mode
 * actually RUNS. That matters most for Hybrid, where §25's diagram is precise about ORDER:
 * the knowledge pipeline is reached only after a trigger match has failed. Encoding that as
 * `knowledgeOnlyAfterNoMatch` means 20.15 cannot accidentally run retrieval first, and it makes
 * the ordering assertable rather than a comment in prose.
 *
 * PURE: no storage, no DOM. The options page and the service worker both read the mode through
 * `normalizeReplyMode()`.
 */

import { DEFAULT_CONFIG } from './config.js';

export const REPLY_MODE = Object.freeze({
  TRIGGER: 'trigger',
  KNOWLEDGE: 'knowledge',
  HYBRID: 'hybrid',
});

/**
 * The mode used when nothing valid is stored.
 *
 * Deliberately TRIGGER, and deliberately read from `DEFAULT_CONFIG` rather than hardcoded here,
 * so the two can never disagree — a second literal would be a value that could drift from the
 * one a fresh install actually gets.
 */
export const DEFAULT_REPLY_MODE = DEFAULT_CONFIG.replyBehavior.replyMode;

/**
 * Every valid mode value.
 *
 * @returns {string[]}
 */
export function listReplyModes() {
  return Object.values(REPLY_MODE);
}

/**
 * Reduce a stored or user-supplied value to a valid mode.
 *
 * Tolerant of the shapes a hand-edited settings object produces — different case, surrounding
 * whitespace — because rejecting those rejects the user's actual choice over formatting. It is
 * NOT tolerant of an unknown mode: that falls back to the default rather than passing through,
 * because a mode nothing implements would otherwise be stored and then behave unpredictably
 * downstream.
 *
 * @param {*} value
 * @returns {string} a member of REPLY_MODE
 */
export function normalizeReplyMode(value) {
  if (typeof value !== 'string') return DEFAULT_REPLY_MODE;

  const candidate = value.trim().toLowerCase();
  return listReplyModes().includes(candidate) ? candidate : DEFAULT_REPLY_MODE;
}

/**
 * Whether a value is a mode this build implements.
 *
 * Separate from `normalizeReplyMode()` because the options page needs to tell the user "that is
 * not a reply mode" rather than silently rewriting their selection behind their back.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidReplyMode(value) {
  return typeof value === 'string' && listReplyModes().includes(value.trim().toLowerCase());
}

/**
 * What each mode actually runs.
 *
 * The fields are the three questions a caller has to answer, which is why they are booleans and
 * not a stage list: a list invites a caller to iterate it in the wrong order, and Hybrid's
 * order is the whole point of Hybrid.
 *
 *   - `usesTriggers`      — should the existing trigger matcher run?
 *   - `usesKnowledge`     — should the 20.6–20.11 pipeline run?
 *   - `knowledgeOnlyAfterNoMatch` — Hybrid's ordering rule from §25's diagram. True means a
 *     trigger match short-circuits the knowledge pipeline entirely.
 *
 * @param {*} value
 * @returns {{mode: string, usesTriggers: boolean, usesKnowledge: boolean,
 *   knowledgeOnlyAfterNoMatch: boolean}}
 */
export function describeReplyMode(value) {
  const mode = normalizeReplyMode(value);

  if (mode === REPLY_MODE.KNOWLEDGE) {
    return {
      mode,
      usesTriggers: false,
      usesKnowledge: true,
      knowledgeOnlyAfterNoMatch: false
    };
  }

  if (mode === REPLY_MODE.HYBRID) {
    return {
      mode,
      usesTriggers: true,
      usesKnowledge: true,
      // §25's diagram: trigger first, and only a non-match reaches the knowledge pipeline. The
      // field is named after the rule rather than the outcome so a caller cannot satisfy it by
      // running both pipelines and preferring the trigger afterwards.
      knowledgeOnlyAfterNoMatch: true
    };
  }

  // Trigger. `knowledgeOnlyAfterNoMatch` is false because the knowledge pipeline does not run
  // at all — the field means "may run after a miss", not "runs after a miss".
  return {
    mode: REPLY_MODE.TRIGGER,
    usesTriggers: true,
    usesKnowledge: false,
    knowledgeOnlyAfterNoMatch: false
  };
}

/**
 * Whether this mode uses the knowledge pipeline.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function modeUsesKnowledge(value) {
  return describeReplyMode(value).usesKnowledge;
}

/**
 * Whether this mode uses the existing trigger matcher.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function modeUsesTriggers(value) {
  return describeReplyMode(value).usesTriggers;
}