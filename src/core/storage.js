/**
 * Storage Module - YouTube Auto Reply Extension
 * 
 * Handles reading and writing settings to chrome.storage.local.
 */

import { DEFAULT_CONFIG } from './config.js';

/**
 * Deep merge function that combines stored settings with default configuration.
 * Preserves all default values while overwriting only the provided keys.
 * 
 * @param {Object} stored - Settings retrieved from chrome.storage.local (may be partial)
 * @returns {Object} Merged configuration object
 */
function deepMerge(stored = {}) {
  // Create a deep copy of defaults to avoid mutation
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Helper function for recursive merging
  function mergeIntoDefaults(target, source) {
    Object.keys(source).forEach(key => {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        // Recursively merge nested objects
        if (!target[key]) {
          target[key] = {};
        }
        mergeIntoDefaults(target[key], source[key]);
      } else {
        // Overwrite with stored value (handles arrays, primitives)
        target[key] = source[key];
      }
    });

    return target;
  }

  // Merge stored settings into defaults
  mergeIntoDefaults(merged, stored);

  return merged;
}

/**
 * Get the current extension settings from storage.
 * 
 * If no settings exist in chrome.storage.local, returns a copy of DEFAULT_CONFIG.
 * Partially stored settings are merged with defaults (deep merge for nested objects).
 * 
 * @returns {Promise<Object>} The complete configuration object
 */
async function getSettings() {
  try {
    // Read from chrome.storage.local - may return partial or empty object
    const result = await chrome.storage.local.get([
      'enabled',
      'dryRun',
      'lmStudio',
      'triggers',
      'replyBehavior'
    ]);

    // Deep merge stored values with defaults
    return deepMerge(result);
  } catch (error) {
    console.error('[YouTube Auto Reply] Error reading settings:', error);
    // On error, fall back to defaults
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

/**
 * Save settings to chrome.storage.local.
 * 
 * Only the provided keys will be stored (partial save is supported).
 * The function does not mutate the input object.
 * 
 * @param {Object} settings - Settings object to save (can be partial)
 * @returns {Promise<void>} Resolves when storage write completes
 */
async function saveSettings(settings = {}) {
  try {
    // Create a deep copy of the provided settings to avoid mutating input
    const settingsCopy = JSON.parse(JSON.stringify(settings));

    // Save only the keys that were provided (partial save)
    await chrome.storage.local.set(settingsCopy);
  } catch (error) {
    console.error('[YouTube Auto Reply] Error saving settings:', error);
    throw error;
  }
}

export { getSettings, saveSettings };
