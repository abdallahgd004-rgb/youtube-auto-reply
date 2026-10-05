/**
 * Default Configuration Module - YouTube Auto Reply Extension
 * 
 * This file contains the centralized default settings for the extension.
 * Other modules can import and use these defaults, then merge with user-provided values.
 */

const DEFAULT_CONFIG = {
  // Extension state
  enabled: false,

  // LM Studio API configuration
  lmStudio: {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    model: "",
    temperature: 0.7,
    maxTokens: 150,
    systemPrompt: ""
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
