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
  caseSensitive: false       // Default to case-insensitive for better UX
};

/**
 * Valid match mode values.
 * 
 * @constant {string[]}
 */
export const VALID_MATCH_MODES = ["contains", "exact"];

/**
 * Export the schema definitions.
 */
export { DEFAULT_TRIGGER_RULE, VALID_MATCH_MODES };