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
    // maxTokens: 1500 - Reasoning models (e.g., qwen3.5-9b) spend tokens on internal thinking first.
    // With 150, every reply is empty because the model exhausts its budget reasoning before generating content.
    // Based on measurements: ~628 tokens for reasoning + headroom for actual response = need ~700+ total.
    maxTokens: 1500,
    systemPrompt:
      "أنت مساعد ذكي ترد على تعليقات اليوتيوب باللغة العربية الفصحى. اكتب ردك بالعربية دائماً بغض النظر عن لغة التعليق. أجب في جملة واحدة إلى ثلاث جمل قصيرة فقط — هذا تعليق يوتيوب وليس مقالاً. لا تستخدم أبداً التنسيق Markdown أو النقاط أو العناوين أو علامات السطر أو الإيموجي. لا تخترع معلومات؛ إذا لم تكن المعلومة متوفرة في الفيديو، قل بوضوح أن الإجابة غير متوفرة في الفيديو وادعُ صاحب التعليق لطرح سؤال آخر. كن مهذباً ومختصراً."
  },

  // Trigger keywords/phrases that will activate the auto-reply
  triggers: [],

  // Reply behavior settings
  replyBehavior: {
    minDelayMs: 8000,      // Minimum delay before replying (ms)
    maxDelayMs: 20000,     // Maximum delay before replying (ms)
    maxRepliesPerHour: 30, // Rate limit: maximum replies per hour
    ignoreOwnComments: true,   // Don't reply to your own comments
    ignoreHandledComments: true // Don't reply to already-handled comments
  }
};

/**
 * Export the default configuration object.
 * Other modules can import this and merge with chrome.storage values later.
 */
export { DEFAULT_CONFIG };
