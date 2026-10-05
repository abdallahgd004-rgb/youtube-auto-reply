/**
 * Prompt Builder Module - YouTube Auto Reply Extension
 * 
 * Phase 7.1 - Prompt Builder
 * 
 * This module provides a standalone function for building chat completion prompts
 * to be sent to LM Studio's OpenAI-compatible API. It constructs the messages array
 * from comment text, system prompt, and optional context without any network calls.
 * 
 * @namespace PromptBuilder
 */

/**
 * Build a chat completion prompt from a YouTube comment and settings.
 * 
 * Constructs an array of message objects for LM Studio's OpenAI-compatible API.
 * The function handles missing/empty system prompts gracefully by omitting them,
 * validates that the comment has text content, and optionally includes context
 * about the video (e.g., title).
 * 
 * @param {Object} comment - The YouTube comment object to build a prompt for
 * @param {string} comment.text - The text content of the comment (required)
 * @param {Object} [comment.context] - Optional context object containing extra info like video title
 * @param {Object} settings - Configuration object with lmStudio.systemPrompt and other fields
 * @param {string} [settings.lmStudio.systemPrompt] - System prompt to include as the first message (optional)
 * @returns {Array<Object>} Array of message objects, each with role ('system' or 'user') and content strings
 * 
 * @throws {Error} If comment is missing or has no text property
 * @throws {Error} If comment.text is empty or null
 * 
 * @example
 * // With system prompt
 * const messages = buildReplyPrompt(
 *   { text: "بكام الكتاب؟", context: { videoTitle: "كتاب رائع" } },
 *   { lmStudio: { systemPrompt: "أنت مساعد ذكي..." } }
 * );
 * 
 * @example
 * // Without system prompt (system message omitted)
 * const messages = buildReplyPrompt(
 *   { text: "بكام الكتاب؟" },
 *   {}
 * );
 */
export function buildReplyPrompt(comment, settings) {
  // Validate comment exists and has text property
  if (!comment || typeof comment !== 'object') {
    throw new Error('Invalid comment: must be a non-null object');
  }

  if (typeof comment.text === 'undefined' || comment.text === null) {
    throw new Error('Comment is missing the required "text" property');
  }

  // Validate that text has content (not empty string, whitespace only, or null/undefined)
  const text = String(comment.text).trim();
  if (text.length === 0) {
    throw new Error('Comment text cannot be empty or contain only whitespace');
  }

  // Get system prompt from settings, defaulting to empty string
  const systemPrompt = settings?.lmStudio?.systemPrompt || '';

  // Build messages array
  const messages = [];

  // Add system message only if systemPrompt has content (omit when empty/missing)
  if (systemPrompt && String(systemPrompt).trim().length > 0) {
    messages.push({
      role: 'system',
      content: String(systemPrompt).trim()
    });
  }

  // Add user message with the comment text
  messages.push({
    role: 'user',
    content: text
  });

  // Handle optional context - append as additional user message if provided
  const context = comment?.context || {};
  if (Object.keys(context).length > 0) {
    // Build a simple context string from the context object
    let contextText = 'Context:\n';
    for (const [key, value] of Object.entries(context)) {
      contextText += `${key}: ${String(value)}\n`;
    }

    messages.push({
      role: 'user',
      content: contextText.trim()
    });
  }

  return messages;
}
