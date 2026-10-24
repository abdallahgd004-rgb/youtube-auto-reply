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
 * Task 14.2 — the response styles allowed in the MVP.
 *
 * Deliberately only these three: plan.md says not to add more styles in the MVP unless
 * necessary. Frozen so nothing can add a style at runtime.
 *
 * Each value is a single Arabic instruction appended to the system prompt.
 */
export const RESPONSE_STYLES = Object.freeze({
  friendly:
    'اكتب بأسلوب ودود ومتحمس، واختم بجملة تشجع صاحب التعليق على متابعة النقاش.',
  professional:
    'اكتب بأسلوب مهني ورسمي ومختصر، وابتعد عن المبالغة والعاطفة.',
  short:
    'اكتب جملة واحدة فقط بأقصى قدر ممكن من الاختصار.'
});

/** The style used when none is configured, or when the configured one is not recognised. */
export const DEFAULT_RESPONSE_STYLE = 'friendly';

/**
 * Task 14.3 — longest static context accepted, in characters.
 *
 * The context is injected into every prompt, so it is bounded to stop a pasted wall of
 * text from inflating the request. Surplus is dropped with a visible marker rather than
 * silently truncated mid-sentence.
 */
export const MAX_STATIC_CONTEXT_CHARS = 1000;

/**
 * Validate a configured response style.
 *
 * An unrecognised value falls back to the default rather than being passed through, so a
 * typo in stored settings can never produce a prompt with an empty style instruction.
 *
 * @param {*} value
 * @returns {string} a key of RESPONSE_STYLES
 */
export function normalizeResponseStyle(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(RESPONSE_STYLES, key)
    ? key
    : DEFAULT_RESPONSE_STYLE;
}

/**
 * Resolve the optional prompt parts, WITHOUT composing them.
 *
 * Exists so Phase 20.8's grounded builder renders the SAME parts without re-deciding which
 * ones apply. Two copies of the template-selection rule would drift silently, and the failure
 * would be invisible: the prompt would quietly carry different context in Knowledge Mode than
 * in Trigger Mode, and the user would have no way to tell why the voice changed when they
 * switched modes.
 *
 * @param {Object} [settings]
 * @returns {{base: string, style: string, styleKey: string, staticContext: string,
 *   template: ({name: string, body: string}|null)}}
 */
export function buildPromptParts(settings) {
  const base = settings?.lmStudio?.systemPrompt;
  const styleKey = normalizeResponseStyle(settings?.replyBehavior?.responseStyle);

  const templates = Array.isArray(settings?.replyBehavior?.contextTemplates)
    ? settings.replyBehavior.contextTemplates
    : [];
  // A blank body is skipped when CHOOSING, not just when rendering. Otherwise an enabled
  // template with an empty body — only reachable by hand-editing storage — would shadow a
  // perfectly good template behind it, and getActiveTemplate() (which filters through the
  // same rule) would disagree with what the prompt actually contains.
  const active = templates.find((t) =>
    t && t.enabled === true && typeof t.body === 'string' && t.body.trim().length > 0
  );

  const rawContext = settings?.replyBehavior?.staticContext;

  return {
    base: base && String(base).trim().length > 0 ? String(base).trim() : '',
    style: RESPONSE_STYLES[styleKey],
    styleKey,
    staticContext: typeof rawContext === 'string' && rawContext.trim().length > 0
      ? rawContext.trim()
      : '',
    template: active
      ? {
          // Read from settings synchronously rather than through context-templates.js: the
          // active template is already in this object, and a store round-trip would make
          // prompt building async for no benefit.
          name: typeof active.name === 'string' && active.name.trim() ? active.name.trim() : '',
          body: active.body.trim()
        }
      : null
  };
}

/**
 * Build the system message content from settings (Tasks 14.1-14.3).
 *
 * Composed of three optional parts, in order:
 *   1. the base system prompt (Phase 14.1 / settings.lmStudio.systemPrompt)
 *   2. the response-style instruction (14.2) — always present when a style resolves
 *   3. the static context block (14.3) — present ONLY when the user supplied some
 *
 * Returns '' when there is nothing at all to send, so callers can keep their existing
 * "omit the system message entirely" behaviour.
 *
 * @param {Object} [settings]
 * @returns {string} the system message content ('' when empty)
 */
export function buildSystemPrompt(settings) {
  const parts = [];
  const resolved = buildPromptParts(settings);

  if (resolved.base) {
    parts.push(resolved.base);
  }

  // 14.2 — style instruction. Resolved (never empty) so a bad setting still yields a
  // valid instruction rather than a gap in the prompt.
  parts.push(resolved.style);

  // 14.3 — static context, only when the user actually provided it.
  if (resolved.staticContext) {
    let context = resolved.staticContext;
    if (context.length > MAX_STATIC_CONTEXT_CHARS) {
      context = context.slice(0, MAX_STATIC_CONTEXT_CHARS) + '…';
    }
    parts.push(
      'معلومات ثابتة عن هذا الفيديو، استخدمها في الرد فقط عندما تكون ضرورية للإجابة ' +
      'ولا تخترع أي معلومة غير مذكورة هنا:\n' + context
    );
  }

  // Phase 19.5 — the active context template, appended LAST so it is the most specific
  // thing in the prompt and reads as an addition to the general instructions rather than a
  // replacement for them.
  if (resolved.template) {
    parts.push(
      (resolved.template.name
        ? `قالب «${resolved.template.name}» الخاص بهذا الفيديو:\n`
        : 'معلومات القالب الخاص بهذا الفيديو:\n') +
      resolved.template.body
    );
  }

  return parts.join('\n\n');
}

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

  // System message content, composed from the base prompt (14.1), the response style
  // (14.2) and any static context (14.3). Empty only when settings are absent entirely.
  const systemPrompt = buildSystemPrompt(settings);

  // Build messages array
  const messages = [];

  // Add system message only if there is content (omitted when settings are missing)
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
