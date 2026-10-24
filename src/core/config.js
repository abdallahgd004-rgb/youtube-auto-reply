/**
 * Default Configuration Module - YouTube Auto Reply Extension
 * 
 * This file contains the centralized default settings for the extension.
 * Other modules can import and use these defaults, then merge with user-provided values.
 */

const DEFAULT_CONFIG = {
  // Extension state
  enabled: false,

  // Phase 8 safety gate. When true, the extension prepares replies but NEVER clicks
  // submit. Defaults to true so nothing is ever posted to a real account by accident.
  dryRun: true,

  // LM Studio API configuration
  lmStudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    model: "",
    temperature: 0.7,
    // maxTokens: 1500 — this is the budget for REPLY GENERATION, which is a different job
    // from classification. The original note here ("reasoning models spend tokens on thinking
    // first; ~628 measured on qwen3.5-9b") was right about the cause and wrong about the
    // remedy: it treated the ceiling as if it had to be carved OUT of the payload rather than
    // have room for thinking ADDED to it, so the same mistake shipped in every structured
    // call. Phase 20.24 fixed that — see core/reasoning-budget.js and AGENTS.md.
    //
    // Reply generation keeps its own setting because it is genuinely different: the answer is
    // prose of an unbounded-ish length, not a fixed JSON payload.
    maxTokens: 1500,
    systemPrompt:
      "أنت مسؤول عن الرد على تعليقات عملاء يوتيوب. اكتب ردًا طبيعيًا وقصيرًا ومحترمًا. اكتب الرد بنفس لغة تعليق المستخدم. لا تخترع أسعارًا أو روابط أو معلومات غير موجودة؛ إن لم تكن المعلومة متوفرة في الفيديو فقل ذلك بوضوح وادعُ صاحب التعليق لطرح سؤال آخر. لا تذكر أبدًا أنك نموذج ذكاء اصطناعي. أجب في جملة واحدة إلى ثلاث جمل قصيرة فقط لأن هذا تعليق وليس مقالًا. لا تستخدم Markdown ولا النقاط ولا العناوين ولا الإيموجي ولا أسطر جديدة."
  },

  // Trigger keywords/phrases that will activate the auto-reply
  triggers: [],

  // ── Target replies & hearting ────────────────────────────────────────────
  //
  // OFF by default, and it must stay that way. Every other flag here defaults ON
  // because it suppresses work; this one makes the extension ACT on the
  // creator's behalf in a way nothing can undo — clicking the real heart control
  // in their logged-in session. A migration or a fresh install must never start
  // clicking things the user did not ask it to click, so the default is `false`
  // and the user opts in deliberately.
  //
  // TOP-LEVEL, not inside `replyBehavior`, because it is not a reply-behaviour
  // tuning knob — it is a separate capability. The cost of that choice is that
  // `getSettings()` lists top-level keys EXPLICITLY, so this name must appear in
  // BOTH this object AND that list; a key missing from the list is silently never
  // loaded, and this one would then read as undefined and behave as "off" — which
  // happens to match the default, so the failure would be invisible until someone
  // turned it on and it did nothing.
  targetReplyHeartingEnabled: false,

  // Reply behavior settings
  replyBehavior: {
    minDelayMs: 8000,      // Minimum delay before replying (ms)
    maxDelayMs: 20000,     // Maximum delay before replying (ms)
    maxRepliesPerHour: 30, // Rate limit: maximum replies per hour
    // DECLARED BUT READ BY NOTHING — do not assume these two work.
    //
    // `ignoreOwnComments` and `ignoreHandledComments` look like they switch the own-comment
    // and already-answered filters on and off. They do not. Neither is read anywhere in the
    // codebase: the own-comment filter runs in the DOM via `isOwnComment()` on the comment
    // markup, and the handled filter runs via `isHandled(fingerprint)` against the publish-
    // written store. Grep for either name and the only hit is this file. Written down here
    // because a future author reading three adjacent `ignore*` keys and assuming the family
    // behaves alike is a very reasonable mistake to make.
    ignoreOwnComments: true,   // DECLARED ONLY — the real filter is isOwnComment() in the DOM
    ignoreHandledComments: true, // DECLARED ONLY — the real filter is isHandled() in the worker

    // ── The channel owner's heart ──────────────────────────────────────────────
    //
    // When true, a comment the creator has hearted ("liked by creator") is never answered:
    // they have already singled that viewer out, on a thread they are watching, so a second
    // automatic reply is noise at best.
    //
    // ON by default, which is the opposite of `followupOnAnswered` below and deliberately so.
    // That one is off because nobody asked for it until they asked. This one was asked for,
    // it is cheap (no model call is spent on a comment it skips), and answering a comment the
    // creator personally endorsed is the worse failure of the two: a false positive mutes
    // every comment on the page at once, and does so silently.
    //
    // Read as a STRICT boolean in all three places it is consulted (page cache, Options
    // checkbox, panel button). A stored "true" string must not count.
    ignoreHeartedComments: true,

    // When true, a comment thread that already contains a reply from the channel owner
    // is never answered: the creator has already addressed this viewer.
    ignoreCreatorRepliedComments: true,

    // Phase 14.2 — response style. One of RESPONSE_STYLES in
    // src/core/prompt-builder.js: 'friendly' | 'professional' | 'short'.
    // Kept here (not hardcoded in the prompt builder) so the Options page can drive it.
    responseStyle: "friendly",

    // Phase 20.14 — which reply pipeline runs (§25).
    //
    // `trigger` is the default and it is load-bearing, not a formality: adding a mode must not
    // change what anyone gets today. A user upgrading has no knowledge base yet, so defaulting
    // to Knowledge would send every comment through retrieval and answerability against an
    // empty base — every comment skipped, with no error anywhere to explain it.
    //
    // "knowledge" uses the full 20.6–20.11 pipeline and ignores triggers; "hybrid" keeps
    // triggers and falls back to knowledge only when no trigger matched (§25's diagram).
    replyMode: "trigger",

    // Phase 14.3 — optional static context (product name, price, link, brief info).
    // Empty by default: when empty nothing is added to the prompt at all.
    staticContext: "",

    // Phase 19.4 — phrases that must never appear in a reply.
    //
    // A non-empty array here REPLACES the built-in list in reply-validator.js, so this
    // default is a copy of that list rather than a reference to it. The core case is a
    // model admitting it is an AI, which the system prompt forbids and which no viewer
    // wants to read under a creator's name. Users can add their own (competitor names,
    // words they never want to say) and can pass [] to turn the check off.
    // Phase 19.5 — named, swappable context blocks. Exactly one is enabled at a time
    // and the enabled one is appended to the prompt after staticContext. Empty by
    // default, so nothing changes for a user who never creates one.
    contextTemplates: [],

    blacklist: [
      "as an ai",
      "ai assistant",
      "language model",
      "نموذج لغوي",
      "ذكاء اصطناعي",
      "مساعد ذكي",
      "أنا ذكاء",
      "بوت"
    ],

    // Phase 22 — offer back the comments the creator has ALREADY replied to.
    //
    // OFF by default, and that is the only safe default: it is a feature nobody asked for
    // until they asked, it costs a model call per qualifying thread, and turning it on
    // changes what the extension reads off the page. A user upgrading has no expectation
    // of it, so it must not start on its own.
    //
    // It is a SEPARATE switch rather than a reply mode, on purpose. It does not answer
    // comments — the creator does — and it must not disturb the trigger/knowledge routing
    // that decides what gets auto-replied. `verify-extension.mjs` asserts that nothing on
    // the publish path reads it.
    followupOnAnswered: false,

    // The creator's own words to the model, used when drafting a follow-up. Empty means
    // "use the defaults in answered-followups.js".
    followupInstruction: ""
  }
};

/**
 * Export the default configuration object.
 * Other modules can import this and merge with chrome.storage values later.
 */
export { DEFAULT_CONFIG };
