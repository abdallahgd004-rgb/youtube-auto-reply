/**
 * Trigger CRUD Module - YouTube Auto Reply Extension
 * 
 * Core module for managing trigger rules (Add, Update, Delete).
 * Uses the existing storage layer (getSettings/saveSettings) for persistence.
 */

import { getSettings, saveSettings } from './storage.js';
// Phase 19.6 — reply mode resolution and the fixed-reply emptiness check. Imported for
// validation only; the resolver itself is deliberately not used to transform the text.
import { REPLY_MODES, resolveReplyMode, getFixedReplyText, validateFixedReply } from './fixed-reply.js';

/**
 * Phase 19.6 — the reply fields to persist, shared by addTrigger() and updateTrigger().
 *
 * Two rules govern this, and they are the whole contract of the feature:
 *
 *  1. BACKWARD COMPATIBILITY. A rule written before Phase 19.6 has no `replyMode`, so
 *     resolveReplyMode() reads it as "ai" and the stored copy gains `replyMode: 'ai'` and
 *     an empty `fixedReply`. Nothing about how such a rule behaves changes.
 *  2. EXACT TEXT. The user's `fixedReply` is copied across untouched. No trim, no Arabic
 *     normalization, no case folding, no whitespace collapsing — punctuation, characters,
 *     spacing, emoji and line breaks are saved exactly as typed. `trim()` appears only
 *     inside the emptiness check, never on the stored value.
 *
 * @param {Object} source - the incoming values (may omit both fields)
 * @param {Object} original - the stored rule being updated, for updateTrigger()
 * @returns {{replyMode: string, fixedReply: string}}
 * @throws {Error} if the rule is in fixed mode without usable text
 */
function resolveReplyFields(source, original) {
  const incoming = source || {};
  const previous = original || {};

  // Mode: the update's value if given, else the stored one, else "ai".
  const mode = resolveReplyMode({
    replyMode: incoming.replyMode !== undefined ? incoming.replyMode : previous.replyMode
  });

  // Text: the update's value if the caller mentioned the field at all (including an
  // explicit empty string, which is how a user clears it), else the stored text.
  // `in` rather than a truthiness check, so '' is treated as a real instruction.
  const hasIncomingText = Object.prototype.hasOwnProperty.call(incoming, 'fixedReply');
  const text = hasIncomingText
    ? getFixedReplyText(incoming)
    : getFixedReplyText(previous);

  if (mode === REPLY_MODES.FIXED) {
    const check = validateFixedReply(text);
    if (!check.valid) {
      // Never silently accept an empty fixed reply: a fixed rule with nothing to say would
      // either publish nothing or quietly fall back to AI, and both contradict what the
      // user asked for on screen.
      throw new Error('Invalid trigger: replyMode is "fixed" but fixedReply is empty');
    }
  }

  return { replyMode: mode, fixedReply: text };
}

/**
 * Generate a unique ID for a new trigger rule.
 * 
 * @returns {string} A unique identifier string
 */
function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 7);
  return `rule-${timestamp}-${random}`;
}

/**
 * Add a new trigger rule.
 * 
 * Creates/stores a Trigger Rule in settings.triggers.
 * Generates a unique id if not provided by the caller.
 * Preserves the existing Trigger Rule structure.
 * Saves the updated settings using saveSettings().
 * 
 * @param {Object} trigger - The trigger rule to add (must have phrases array)
 * @returns {Promise<Object>} The saved trigger rule with generated/confirmed id
 * @throws {Error} If trigger object is invalid or missing required fields
 */
async function addTrigger(trigger) {
  // Validate input
  if (!trigger || typeof trigger !== 'object') {
    throw new Error('Invalid trigger: must be a non-null object');
  }

  if (!Array.isArray(trigger.phrases) || trigger.phrases.length === 0) {
    throw new Error('Invalid trigger: phrases must be a non-empty array');
  }

  // Generate unique ID if not provided
  const id = trigger.id || generateId();

  // Phase 19.6 — resolved (and validated) before the rule object is built, so a rejected
  // fixed reply never reaches storage.
  const replyFields = resolveReplyFields(trigger, null);

  // Create the complete rule object with defaults for missing fields
  const rule = {
    id,
    enabled: trigger.enabled !== undefined ? trigger.enabled : true,
    phrases: [...trigger.phrases], // Copy array to avoid reference issues
    matchMode: trigger.matchMode || 'contains',
    caseSensitive: trigger.caseSensitive ?? false,
    replyMode: replyFields.replyMode,
    fixedReply: replyFields.fixedReply
  };

  // Get current settings and add the new rule
  const settings = await getSettings();
  
  if (!settings.triggers) {
    settings.triggers = [];
  }
  
  // Add to triggers array (avoid duplicates by id)
  const existingIndex = settings.triggers.findIndex(r => r.id === id);
  if (existingIndex >= 0) {
    throw new Error(`Trigger with id "${id}" already exists`);
  }
  
  settings.triggers.push(rule);

  // Save updated settings
  await saveSettings(settings);

  return rule;
}

/**
 * Update an existing trigger rule.
 * 
 * Finds the trigger by id and updates only the provided fields.
 * Preserves all fields that were not included in the update.
 * Saves the updated settings using saveSettings().
 * 
 * @param {string} triggerId - The unique identifier of the trigger to update
 * @param {Object} updates - Partial object with fields to update (must include phrases)
 * @returns {Promise<Object>} The updated trigger rule
 * @throws {Error} If trigger not found or invalid updates provided
 */
async function updateTrigger(triggerId, updates) {
  // Validate triggerId
  if (!triggerId || typeof triggerId !== 'string') {
    throw new Error('Invalid triggerId: must be a non-empty string');
  }

  // Get current settings
  const settings = await getSettings();

  // Find the trigger by id
  const index = settings.triggers.findIndex(r => r.id === triggerId);
  
  if (index < 0) {
    throw new Error(`Trigger with id "${triggerId}" not found`);
  }

  // Create updated rule, preserving existing fields and merging updates
  const originalRule = settings.triggers[index];
  // Phase 19.6 — merging against the stored rule, so switching a rule back to "ai" does
  // not erase its saved text and editing only the phrases leaves the reply alone.
  const replyFields = resolveReplyFields(updates, originalRule);
  const updatedRule = {
    id: originalRule.id,
    enabled: updates.enabled !== undefined ? updates.enabled : originalRule.enabled,
    phrases: updates.phrases !== undefined ? [...updates.phrases] : [...originalRule.phrases], // Preserve existing if not provided
    matchMode: updates.matchMode !== undefined ? updates.matchMode : originalRule.matchMode,
    caseSensitive: updates.caseSensitive ?? originalRule.caseSensitive,
    replyMode: replyFields.replyMode,
    fixedReply: replyFields.fixedReply
  };

  // Replace in the triggers array
  settings.triggers[index] = updatedRule;

  // Save updated settings
  await saveSettings(settings);

  return updatedRule;
}

/**
 * Delete an existing trigger rule.
 * 
 * Finds and removes the trigger by id from settings.triggers.
 * Saves the updated settings using saveSettings().
 * 
 * @param {string} triggerId - The unique identifier of the trigger to delete
 * @returns {Promise<void>} Resolves when deletion completes
 * @throws {Error} If trigger not found
 */
async function deleteTrigger(triggerId) {
  // Validate triggerId
  if (!triggerId || typeof triggerId !== 'string') {
    throw new Error('Invalid triggerId: must be a non-empty string');
  }

  // Get current settings
  const settings = await getSettings();

  // Find the trigger by id
  const index = settings.triggers.findIndex(r => r.id === triggerId);
  
  if (index < 0) {
    throw new Error(`Trigger with id "${triggerId}" not found`);
  }

  // Remove from triggers array
  settings.triggers.splice(index, 1);

  // Save updated settings
  await saveSettings(settings);
}

/**
 * Get all trigger rules (for reference).
 * 
 * @returns {Promise<Object[]>} Array of all trigger rules from settings.triggers
 */
async function getTriggers() {
  const settings = await getSettings();
  return settings.triggers || [];
}

export { addTrigger, updateTrigger, deleteTrigger, getTriggers };