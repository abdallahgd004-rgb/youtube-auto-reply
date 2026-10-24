// Phase 9.2 + 9.3 + 9.4 — Handled-Comment Store
import { logError } from './debug.js';

/**
 * Storage key for handled-comment records.
 *
 * IMPORTANT: This is a top-level chrome.storage.local key read directly via
 * `chrome.storage.local.get('handledComments')`. It is NOT a settings key, so it
 * must NOT be added to DEFAULT_CONFIG or the explicit key list in getSettings() —
 * doing so would silently break this module because getSettings only loads keys
 * from that whitelist.
 */
const STORAGE_KEY = 'handledComments';

/**
 * Default cleanup age threshold.
 *
 * Units: **milliseconds**. The parameter name and this const both carry
 * `MS` in their names to make the unit unmissable. 30 days =
 * `30 * 24 * 60 * 60 * 1000` ms.
 *
 * Passing a value like `30` (intending "30 days") would mean
 * "30 milliseconds" — always pass the full millisecond value or use
 * an expression such as `30 * 24 * 60 * 60 * 1000`.
 */
export const DEFAULT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Read the handled-comments object from storage.
 * Returns `{}` when the key is absent or storage fails.
 */
async function _readRecords() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (result && typeof result[STORAGE_KEY] === 'object' && !Array.isArray(result[STORAGE_KEY])) {
      return result[STORAGE_KEY];
    }
    return {};
  } catch (err) {
    logError('handled-comments read error:', err);
    return {};
  }
}

/**
 * Write the full records object back to storage.
 * Resolves silently on failure; never rejects to callers.
 */
async function _writeRecords(records) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  } catch (err) {
    logError('handled-comments write error:', err);
    // Silently resolve — a storage failure must NEVER disable replying.
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Mark a comment as handled (9.2).
 *
 * Merges the new record into existing records rather than replacing them,
 * so previously handled comments are preserved.
 *
 * **Opportunistic cleanup:** approximately every 10 calls this function
 * triggers `cleanupOldRecords()` internally to evict stale entries. This
 * means an extra storage write may occur on any given call, but the hot
 * path (the reply flow) is not blocked — the cleanup runs asynchronously
 * and its errors are already swallowed by `_writeRecords`. The caller may
 * also invoke `cleanupOldRecords()` explicitly at any time.
 *
 * @param {string} fingerprint — Stable comment identifier.
 * @param {Object} meta       — Arbitrary metadata to store alongside timestamp.
 * @returns {Promise<void>}   Resolves when written (or fails silently).
 */
export async function markHandled(fingerprint, meta = {}) {
  const records = await _readRecords();

  // Merge: keep existing keys, add/update this fingerprint.
  records[fingerprint] = {
    timestamp: Date.now(),
    ...records[fingerprint],   // preserve any prior fields from this fp
    ...meta,                   // new meta wins
  };

  await _writeRecords(records);

  // Opportunistic cleanup: run once per ~10 markHandled calls.
  // Rationale: every write would scan O(n) records which is wasteful;
  // a sparse periodic scan keeps storage bounded without adding latency
  // to the hot path (reply flow). The caller may also invoke
  // cleanupOldRecords() explicitly at any time.
  const counter = (globalThis.__handledCommentsWriteCounter ?? 0) + 1;
  globalThis.__handledCommentsWriteCounter = counter;
  if (counter % 10 === 0) {
    await cleanupOldRecords();   // fire-and-forget, errors already caught inside
  }

  return undefined;
}

/**
 * Check whether a comment has already been handled (9.3).
 *
 * @param {string} fingerprint — Stable comment identifier.
 * @returns {Promise<boolean>}  true if the fingerprint exists in storage.
 */
export async function isHandled(fingerprint) {
  const records = await _readRecords();
  return Boolean(records && Object.prototype.hasOwnProperty.call(records, fingerprint));
}

/**
 * Remove records older than a given age (9.4).
 *
 * The threshold comparison is **strictly less-than** (`<`). A record whose
 * `timestamp` equals the cutoff is NOT removed — it must be strictly older.
 *
 * **Edge case — `ageMs = 0`:** the cutoff equals `Date.now()`. Because of
 * the strict `<`, a record written in the exact same millisecond as the
 * call has `timestamp === cutoff` and survives. Only records from prior
 * milliseconds are removed. In practice this means `cleanupOldRecords(0)`
 * removes everything except records written in the current ms — effectively
 * "almost all" but not quite "everything." For a true "remove all" you
 * would need to pass `1` (or any positive value).
 *
 * @param {number} [ageMs] — Age threshold in **milliseconds**. Defaults to
 *   `DEFAULT_AGE_MS` (30 days = 2 592 000 000 ms). Always pass the full
 *   millisecond value; passing `30` means "30 ms", not "30 days".
 * @returns {Promise<number>} Number of records removed.
 */
export async function cleanupOldRecords(ageMs = DEFAULT_AGE_MS) {
  const records = await _readRecords();
  const cutoff = Date.now() - ageMs;
  let removed = 0;

  for (const [fp, entry] of Object.entries(records)) {
    if (entry && typeof entry.timestamp === 'number' && entry.timestamp < cutoff) {
      delete records[fp];
      removed++;
    }
  }

  await _writeRecords(records);
  return removed;
}
