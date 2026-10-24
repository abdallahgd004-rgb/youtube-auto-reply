/**
 * Trigger Rule Schema - YouTube Auto Reply Extension
 * 
 * This module defines the data structure/schema for trigger rules.
 * A trigger rule represents a set of keywords/phrases that will activate
 * the auto-reply feature when detected in YouTube comments.
 * 
 * @namespace TriggerSchema
 */

/**
 * Trigger Rule Schema Definition
 * 
 * Represents a single trigger rule configuration.
 * Each rule defines what phrases to match and how to match them.
 * 
 * @typedef {Object} TriggerRule
 * @property {string} id - Unique identifier for the rule (e.g., "rule-001")
 * @property {boolean} enabled - Whether this rule is currently active
 * @property {string[]} phrases - Array of keyword/phrases to match in comments
 * @property {"contains"|"exact"} matchMode - Matching strategy:
 *   - "contains": Rule triggers if ANY phrase is contained in the comment text
 *   - "exact": Rule triggers only if the entire comment matches a phrase exactly
 * @property {boolean} caseSensitive - Whether matching should be case-sensitive
 * @property {"ai"|"fixed"} [replyMode] - How the reply for this rule is produced
 *   (Phase 19.6):
 *   - "ai" (default): LM Studio writes the reply. Every rule stored before Phase 19.6
 *     has no `replyMode` at all and behaves exactly this way.
 *   - "fixed": the rule's own `fixedReply` text IS the reply, used verbatim. LM Studio is
 *     still asked whether the comment matches (semantic matching is a separate job), but
 *     it is NOT asked to write a reply.
 * @property {string} [fixedReply] - the exact reply text, used only when replyMode is
 *   "fixed". Optional. Never trimmed, normalized or rewritten anywhere.
 */

/**
 * Default trigger rule configuration.
 * Used as a template for new rules or when merging with storage values.
 * 
 * @type {TriggerRule}
 */
const DEFAULT_TRIGGER_RULE = {
  id: "",                    // Will be set by the user/creator
  enabled: true,             // Rules are enabled by default
  phrases: [],               // No phrases defined until added by user
  matchMode: "contains",     // Default to contains matching (more flexible)
  caseSensitive: false,      // Default to case-insensitive for better UX
  // Phase 19.6 — reply mode. Absent on every rule stored before Phase 19.6, which is why
  // it is optional and why resolution treats anything but "fixed" as "ai" (see
  // resolveReplyMode() in core/fixed-reply.js).
  replyMode: "ai",           // LM Studio writes the reply unless the user says otherwise
  fixedReply: ""             // No fixed text until the user writes one
};

/**
 * Valid match mode values.
 * 
 * @constant {string[]}
 */
export const VALID_MATCH_MODES = ["contains", "exact"];

/**
 * Phase 19.6 — valid reply modes. Re-exported from core/fixed-reply.js rather than
 * duplicated, so there is one list to keep in step with the resolver.
 */
export { VALID_REPLY_MODES } from './fixed-reply.js';

/**
 * Export the schema definitions.
 */
export { DEFAULT_TRIGGER_RULE };