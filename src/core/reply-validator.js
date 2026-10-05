/**
 * Reply Validator Module - YouTube Auto Reply Extension
 * 
 * Phase 7.4 - Reply Validator
 * 
 * This module provides a standalone function for validating AI-generated replies
 * before they are published to YouTube comments. It checks for:
 * - Empty or whitespace-only content
 * - Excessive length (character limit)
 * - Placeholder patterns ({{...}})
 * - Markdown code fences (```...)
 * - Reasoning leaks (when text is actually the model's chain of thought)
 * 
 * @namespace ReplyValidator
 */

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
