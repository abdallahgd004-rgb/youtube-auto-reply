/**
 * Reply Validator Module - YouTube Auto Reply Extension
 * 
 * Phase 7.4 - Reply Validator, widened in Phase 19.4
 * 
 * This module provides a standalone function for validating AI-generated replies
 * before they are published to YouTube comments. It checks for:
 * - Empty or whitespace-only content
 * - Excessive length (character limit)
 * - Placeholder patterns ({{...}})
 * - Markdown code fences (```...)
 * - Reasoning leaks (when text is actually the model's chain of thought)
 * - Blacklisted phrases (Phase 19.4) — the most important being a model admitting it
 *   is an AI, which the system prompt forbids and which no viewer wants to read
 * - Repeats of a reply already written (Phase 19.4) — several identical comments under
 *   the trigger get the same generic answer, and a wall of identical replies is worse
 *   than no reply at all
 * 
 * @namespace ReplyValidator
 */

import { normalizeArabic } from './matchers/arabic-normalizer.js';

/**
 * Phase 19.4 — phrases that must never appear in a published reply.
 *
 * Configurable: `settings.replyBehavior.blacklist` replaces this list when it is a
 * non-empty array. These defaults cover the failure the system prompt explicitly asks
 * the model to avoid, in both languages the extension is used in.
 */
export const DEFAULT_BLACKLIST = Object.freeze([
  // Disclosing that a bot wrote the reply.
  'as an ai',
  'ai assistant',
  'language model',
  'نموذج لغوي',
  'ذكاء اصطناعي',
  'مساعد ذكي',
  'أنا ذكاء',
  'بوت',
]);

/**
 * Fold a string for blacklist and repeat comparison.
 *
 * Same treatment the matchers use: lowercase, then Arabic normalization. This is what
 * lets "As an AI," and "as an ai" compare equal, and lets a diacritics-carrying Arabic
 * phrase match a plain one.
 *
 * @param {string} value
 * @returns {string}
 */
function foldForComparison(value) {
  return normalizeArabic(String(value == null ? '' : value).toLowerCase());
}

/**
 * Phase 19.4 — reject a reply containing any blacklisted phrase.
 *
 * Substring matching on the folded form, so punctuation, case and Arabic diacritics
 * cannot smuggle a banned phrase through. An empty list disables the check entirely,
 * which is how a user opts out.
 *
 * @param {string} foldedReply — already folded by foldForComparison
 * @param {string[]} blacklist — raw phrases
 * @returns {string|null} the offending phrase, or null
 */
function findBlacklistedPhrase(foldedReply, blacklist) {
  if (!Array.isArray(blacklist)) return null;
  for (const raw of blacklist) {
    if (typeof raw !== 'string') continue;
    const needle = foldForComparison(raw);
    if (!needle) continue;
    if (foldedReply.includes(needle)) return raw;
  }
  return null;
}

/**
 * Phase 19.4 — reject a reply identical to one already written.
 *
 * Exact comparison on the folded form, deliberately NOT fuzzy. The service worker
 * already treats near-identical replies for DIFFERENT comments as an observation
 * rather than a block, because two distinct comments each deserve an answer; blocking
 * a real reply because it was similar would silently drop comments. An exact repeat,
 * however, means the model had nothing new to say, and posting it verbatim is what
 * makes a channel look automated.
 *
 * NOT CALLED for a Phase 19.6 fixed reply — see `allowRepeat` in validateReply(). The
 * reasoning above is about a model running out of things to say; it does not apply to a
 * reply the user typed once and asked for verbatim every time.
 *
 * @param {string} foldedReply
 * @param {string[]} recentReplies — raw replies already written
 * @returns {string|null} the earlier reply it repeats, or null
 */
function findRepeat(foldedReply, recentReplies) {
  if (!Array.isArray(recentReplies)) return null;
  for (const raw of recentReplies) {
    if (typeof raw !== 'string') continue;
    const folded = foldForComparison(raw);
    // Anything short is too likely to coincide by accident to be worth blocking.
    if (folded.length < 12) continue;
    if (folded === foldedReply) return raw;
  }
  return null;
}

/**
 * Validate an AI-generated reply before publishing.
 * 
 * Accepts either a plain string or an object with { text, reasoning } for
 * detecting reasoning leaks when the model returns its thinking as content.
 * 
 * @param {string|Object} reply - Either:
 *   - A plain string (simple reply validation)
 *   - An object with { text, reasoning } to detect reasoning leaks
 * @param {Object} [options] - Optional overrides:
 *   - { number } options.maxLength - Maximum character length (default: 1000)
 *     Chosen as a safe upper bound for YouTube comments; typical replies are
 *     50-300 characters, and even verbose Arabic responses rarely exceed 800.
 *   - { string[] } options.blacklist - Phrases that must not appear (Phase 19.4).
 *     Defaults to DEFAULT_BLACKLIST. Pass [] to disable the check.
 *   - { string[] } options.recentReplies - Replies already written (Phase 19.4).
 *     An exact repeat of one of these is rejected. Omit to disable the check.
 *   - { boolean } options.allowRepeat - Phase 19.6. Skips ONLY the repeat check, and
 *     only this one. Set by the service worker when the reply came from a trigger's
 *     `fixedReply`, where publishing the identical text is the entire point. Every other
 *     check below still runs. Defaults to false, so an AI reply — and any caller that
 *     forgets the flag — keeps the Phase 19.4 protection unchanged.
 * @returns {Object} Validation result with shape:
 *   - { boolean } valid - Whether the reply passes all checks
 *   - { string? } reason - Machine-readable error token if invalid
 *   - { string? } reply - The trimmed, normalized reply (only if valid)
 * 
 * @throws {Error} If reply is not a string or object with text property
 */
export function validateReply(reply, options = {}) {
  // Default max length: 1000 characters. This is a character limit, not token count.
  // YouTube comments are typically short (50-300 chars), and even verbose Arabic
  // responses rarely exceed 800. 1000 provides headroom while preventing spammy
  // or excessively long outputs that would look unnatural on YouTube.
  const maxLength = options.maxLength ?? 1000;

  // Phase 19.4 — a non-array blacklist falls back to the built-in one; an EMPTY array
  // is honoured, so a user can deliberately switch the check off.
  const blacklist = Array.isArray(options.blacklist) ? options.blacklist : DEFAULT_BLACKLIST;
  const recentReplies = Array.isArray(options.recentReplies) ? options.recentReplies : [];

  // Phase 19.6 — a fixed reply is exempt from the repeat check ONLY. It is not exempt
  // from anything else: empty text, length, placeholders, code fences, reasoning leaks and
  // the blacklist are all evaluated exactly as they are for an AI reply. An empty array
  // is what disables the repeat check downstream, so the flag and the effect cannot drift
  // apart, and the decision stays in one place rather than being spread over the caller's
  // idea of which options to forward.
  const repeatCandidates = options.allowRepeat === true ? [] : recentReplies;

  /**
   * Reasoning leak detection rule:
   * When the API returns both `text` and `reasoning`, we must check whether `text`
   * is actually the model's chain of thought rather than a clean reply. This happens
   * when the token budget is tight (e.g., max_tokens=600) and the model spends all
   * tokens on reasoning, leaving content empty or containing only thinking text.
   * 
   * Detection: if `reasoning` is non-empty AND equals (or is contained in) `text`,
   * then `text` IS the reasoning -> reject with REASONING_LEAK.
   * 
   * This rule requires BOTH fields to be passed together. When called with a bare
   * string, reasoning leak detection is not applicable.
   */

  // Handle object input: { text, reasoning }
  if (typeof reply === 'object' && !Array.isArray(reply)) {
    // Validate that reply is not null before destructuring
    if (reply === null) {
      return { valid: false, reason: 'NOT_A_STRING', reply: undefined };
    }
    
    const { text, reasoning } = reply;

    // Validate that text exists and is a string
    if (text === null || typeof text !== 'string') {
      return { valid: false, reason: 'NOT_A_STRING', reply: undefined };
    }

    // Check for reasoning leak: when reasoning is non-empty AND contained in text
    if (reasoning && typeof reasoning === 'string' && reasoning.trim().length > 0) {
      const trimmedText = text.trim();
      const trimmedReasoning = reasoning.trim();
      
      // Detect actual leaks, not mere containment.
      // A leak occurs when the model's reasoning IS the reply content:
      // - The strings are equal after trimming (exact match), OR
      // - Reasoning is a substantial fraction of text (>50% ratio).
      // This prevents false positives like "Greeting" inside "Greeting! How can I help you?"
      // where the short reasoning string appears in a longer, distinct reply.
      // When reasoning is LONGER than text it cannot be contained in text → not a leak.
      const leakThreshold = 0.5;
      let isLeak = false;

      if (trimmedText === trimmedReasoning) {
        isLeak = true; // Exact match after trim
      } else if (trimmedReasoning.length <= trimmedText.length && trimmedText.length > 0) {
          const ratio = trimmedReasoning.length / trimmedText.length;
          isLeak = ratio >= leakThreshold; // Reasoning is a substantial fraction of text
        }
      
      if (isLeak) {
        return { valid: false, reason: 'REASONING_LEAK', reply: undefined };
      }
    }

    // Continue with validation on text field
    const normalized = String(text).trim();

    // Check for empty/whitespace-only input -> EMPTY
    if (normalized.length === 0) {
      return { valid: false, reason: 'EMPTY', reply: undefined };
    }

    // Check length limit -> TOO_LONG
    if (normalized.length > maxLength) {
      return { valid: false, reason: 'TOO_LONG', reply: undefined };
    }

    // Check for placeholder patterns {{...}} -> PLACEHOLDER
    if (/\{\{.*?\}\}/.test(normalized)) {
      return { valid: false, reason: 'PLACEHOLDER', reply: undefined };
    }

    // Check for Markdown code fences ``` (open or closed) -> CODE_FENCE
    if (normalized.includes('```')) {
      return { valid: false, reason: 'CODE_FENCE', reply: undefined };
    }

    // ── Phase 19.4 ────────────────────────────────────────────────────────
    // Blacklist first: a reply that admits the writer is an AI is the failure worth
    // catching even if it would also have been a repeat.
    const foldedReply = foldForComparison(normalized);
    const blacklisted = findBlacklistedPhrase(foldedReply, blacklist);
    if (blacklisted !== null) {
      return { valid: false, reason: 'BLACKLISTED', reply: undefined, matchedPhrase: blacklisted };
    }

    const repeated = findRepeat(foldedReply, repeatCandidates);
    if (repeated !== null) {
      return { valid: false, reason: 'REPEAT_RESPONSE', reply: undefined };
    }

    // All checks passed - return the trimmed, normalized reply
    return { valid: true, reason: undefined, reply: normalized };
  }

  // Handle plain string input (simple validation, no reasoning leak check)
  if (typeof reply === 'string') {
    const normalized = String(reply).trim();

    // Check for empty/whitespace-only input -> EMPTY
    if (normalized.length === 0) {
      return { valid: false, reason: 'EMPTY', reply: undefined };
    }

    // Check length limit -> TOO_LONG
    if (normalized.length > maxLength) {
      return { valid: false, reason: 'TOO_LONG', reply: undefined };
    }

    // Check for placeholder patterns {{...}} -> PLACEHOLDER
    if (/\{\{.*?\}\}/.test(normalized)) {
      return { valid: false, reason: 'PLACEHOLDER', reply: undefined };
    }

    // Check for Markdown code fences ``` (open or closed) -> CODE_FENCE
    if (normalized.includes('```')) {
      return { valid: false, reason: 'CODE_FENCE', reply: undefined };
    }

    // ── Phase 19.4 ────────────────────────────────────────────────────────
    // Blacklist first: a reply that admits the writer is an AI is the failure worth
    // catching even if it would also have been a repeat.
    const foldedReply = foldForComparison(normalized);
    const blacklisted = findBlacklistedPhrase(foldedReply, blacklist);
    if (blacklisted !== null) {
      return { valid: false, reason: 'BLACKLISTED', reply: undefined, matchedPhrase: blacklisted };
    }

    const repeated = findRepeat(foldedReply, repeatCandidates);
    if (repeated !== null) {
      return { valid: false, reason: 'REPEAT_RESPONSE', reply: undefined };
    }

    // All checks passed - return the trimmed, normalized reply
    return { valid: true, reason: undefined, reply: normalized };
  }

  // Handle null, undefined, numbers, booleans, symbols -> NOT_A_STRING
  if (reply === null || typeof reply !== 'string') {
    return { valid: false, reason: 'NOT_A_STRING', reply: undefined };
  }

  // Should not reach here, but handle as fallback
  throw new Error('validateReply received invalid input type');
}
