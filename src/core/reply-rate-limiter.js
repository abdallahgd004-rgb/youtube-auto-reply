// Phase 10.5 — Reply Rate Limiter

/**
 * Storage key for the rolling window of recent reply timestamps.
 *
 * IMPORTANT: like `handledComments`, this is a top-level chrome.storage.local key
 * read directly, NOT a settings key. It must NOT be added to DEFAULT_CONFIG or to
 * the explicit key list in getSettings() — that list only loads settings, and
 * adding this there would silently do nothing useful.
 */
const STORAGE_KEY = 'recentReplyTimestamps';

/** Default rolling window: one hour. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Read the raw timestamp array from storage.
 * @returns {Promise<number[]>} ascending epoch-ms timestamps; [] on any failure
 */
async function readTimestamps() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result && result[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((t) => typeof t === 'number' && Number.isFinite(t));
  } catch (error) {
    console.error('[YouTube Auto Reply] rate limiter read error:', error.message);
    return [];
  }
}

/**
 * Write the timestamp array back to storage.
 * @param {number[]} timestamps
 * @returns {Promise<void>} resolves even if the write fails
 */
async function writeTimestamps(timestamps) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: timestamps });
  } catch (error) {
    console.error('[YouTube Auto Reply] rate limiter write error:', error.message);
  }
}

/**
 * Count replies within the rolling window, pruning expired entries as it goes.
 *
 * An unreadable store yields a count of 0. That direction is deliberate: failing
 * open means we might exceed the limit, whereas failing closed would silently stop
 * replying forever. Bounding the stored array keeps storage from growing forever.
 *
 * @param {number} [windowMs] — window size in ms. Defaults to one hour.
 * @returns {Promise<number>} number of replies inside the window
 */
export async function countRecentReplies(windowMs = DEFAULT_WINDOW_MS) {
  const timestamps = await readTimestamps();
  const cutoff = Date.now() - windowMs;
  const recent = timestamps.filter((t) => t > cutoff);
  if (recent.length !== timestamps.length) {
    await writeTimestamps(recent);
  }
  return recent.length;
}

/**
 * Whether the hourly reply cap has been reached.
 *
 * A limit that is not a positive finite number means "no limit" and returns false.
 *
 * @param {number} [limit] — max replies allowed in the window
 * @param {number} [windowMs] — window size in ms
 * @returns {Promise<boolean>} true when at or over the limit
 */
export async function isLimitReached(limit, windowMs = DEFAULT_WINDOW_MS) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return false;
  const count = await countRecentReplies(windowMs);
  return count >= limit;
}

/**
 * Record that a reply was just posted, dropping expired entries first.
 *
 * @param {number} [windowMs] — window size in ms
 * @returns {Promise<void>} resolves even if the write fails
 */
export async function recordReply(windowMs = DEFAULT_WINDOW_MS) {
  const timestamps = await readTimestamps();
  const cutoff = Date.now() - windowMs;
  const recent = timestamps.filter((t) => t > cutoff);
  recent.push(Date.now());
  await writeTimestamps(recent);
}
