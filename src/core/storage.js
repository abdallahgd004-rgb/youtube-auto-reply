/**
 * Storage Module - YouTube Auto Reply Extension
 * 
 * Handles reading and writing settings to chrome.storage.local.
 */

import { DEFAULT_CONFIG } from './config.js';
import { logError, YTAR_DEVLOG, DEV_LOG_COMPONENT as C, DEV_LOG_LEVEL as L } from './debug.js';

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
  // Timed and DEBUG-level: getSettings() runs on every queue iteration, so this must
  // never be INFO or it would drown the log. Only the key NAMES are recorded — never
  // the values, which include the system prompt and the API key.
  const readTimer = YTAR_DEVLOG.startTimer({
    component: C.STORAGE,
    event: 'STORAGE_READ',
    endEvent: 'STORAGE_READ_END',
    errorEvent: 'STORAGE_ERROR',
    level: L.DEBUG,
    data: { area: 'local', operation: 'get', keys: ['enabled', 'dryRun', 'lmStudio', 'triggers', 'replyBehavior'] }
  });
  try {
    // Read from chrome.storage.local - may return partial or empty object
    //
    // The key list is EXPLICIT, not the whole area. That is why a new top-level setting
    // has to be added in TWO places: `DEFAULT_CONFIG` for the default, and here for the
    // read. A key in only one of them is either never loaded or never defaulted, and
    // `targetReplyHeartingEnabled` (Phase 23.1) is the live example — see config.js.
    const result = await chrome.storage.local.get([
      'enabled',
      'dryRun',
      'lmStudio',
      'triggers',
      'replyBehavior',
      'targetReplyHeartingEnabled'
    ]);

    // Deep merge stored values with defaults
    const merged = deepMerge(result);
    readTimer.done({ ok: true, keysReturned: result ? Object.keys(result).length : 0 });
    return merged;
  } catch (error) {
    logError('Error reading settings:', error);
    readTimer.fail(error, { ok: false, fellBackToDefaults: true });
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
  const writeTimer = YTAR_DEVLOG.startTimer({
    component: C.STORAGE,
    event: 'STORAGE_WRITE',
    endEvent: 'STORAGE_WRITE_END',
    errorEvent: 'STORAGE_ERROR',
    data: { area: 'local', operation: 'set', keys: Object.keys(settings || {}) }
  });
  try {
    // Create a deep copy of the provided settings to avoid mutating input
    const settingsCopy = JSON.parse(JSON.stringify(settings));

    // Save only the keys that were provided (partial save)
    await chrome.storage.local.set(settingsCopy);
    writeTimer.done({ ok: true, keysWritten: Object.keys(settingsCopy).length });
  } catch (error) {
    logError('Error saving settings:', error);
    writeTimer.fail(error, { ok: false, keysAttempted: Object.keys(settings || {}) });
    throw error;
  }
}

export { getSettings, saveSettings };
