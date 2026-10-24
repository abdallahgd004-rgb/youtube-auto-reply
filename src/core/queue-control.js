// Phase 10.6 — Queue Pause / Resume Control
import { logError } from './debug.js';

/**
 * Storage key holding the user's pause flag.
 *
 * IMPORTANT: like `handledComments` and `recentReplyTimestamps`, this is a
 * top-level chrome.storage.local key read directly. It must NOT be added to
 * DEFAULT_CONFIG or to the explicit key list in getSettings() — that list only
 * loads settings, and putting this there would do nothing useful.
 */
const STORAGE_KEY = 'queuePaused';

/**
 * Whether the user has paused the queue.
 *
 * Stored rather than held in memory on purpose: a Chrome service worker is killed
 * when idle, so an in-memory flag would silently un-pause itself. Reading from
 * storage means a pause survives the worker being restarted.
 *
 * A read failure resolves to `false`. That direction is deliberate — failing closed
 * here would mean an unreadable store freezes the queue forever with no way for the
 * user to recover, because the Pause button reads the same key.
 *
 * @returns {Promise<boolean>} true when paused
 */
export async function isQueuePaused() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return !!(result && result[STORAGE_KEY] === true);
  } catch (error) {
    logError('queue pause read error:', error.message);
    return false;
  }
}

/**
 * Set the pause flag.
 *
 * Only a strict `true` pauses. Anything else — undefined, null, 0, 'true', {} —
 * writes `false`, so a malformed value can never leave the queue stuck paused.
 *
 * @param {*} paused — desired state
 * @returns {Promise<boolean>} the value actually written
 */
export async function setQueuePaused(paused) {
  const value = paused === true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: value });
  } catch (error) {
    logError('queue pause write error:', error.message);
  }
  return value;
}

/**
 * Flip the pause flag and return the new state.
 * @returns {Promise<boolean>} true if the queue is now paused
 */
export async function toggleQueuePaused() {
  const next = !(await isQueuePaused());
  await setQueuePaused(next);
  return next;
}
