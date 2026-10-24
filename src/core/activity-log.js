// Phase 11.1 + 11.2 + 11.4 — Activity Log (schema, bounded persistence, clear)
//
// Platform-agnostic by design: the schema and entry construction below are pure
// functions with no `chrome.*` access. Only the four thin persistence helpers at the
// bottom touch chrome.storage.local, so the log format can be reused or tested
// without an extension environment.

import { logError } from './debug.js';

/**
 * Storage key holding the activity log array.
 *
 * IMPORTANT: like `handledComments`, `recentReplyTimestamps` and `queuePaused`, this
 * is a top-level chrome.storage.local key read directly. It must NOT be added to
 * DEFAULT_CONFIG or to the explicit key list in getSettings() — that list only loads
 * settings keys, and adding it there would do nothing useful.
 */
const STORAGE_KEY = 'activityLogs';

/**
 * Maximum number of log entries kept (Phase 11.2: keep only a limited number).
 *
 * Newest entry first, so trimming always drops the OLDEST entries. This bounds
 * storage growth without any time-based cleanup pass.
 */
export const MAX_LOGS = 200;

/**
 * The complete set of status values (Phase 11.1).
 *
 * Frozen so a typo cannot silently introduce a new status: any value outside this set
 * is coerced to `failed` by createLog(), which surfaces the mistake immediately in
 * the log itself instead of hiding it.
 */
export const LOG_STATUS = Object.freeze({
  MATCHED: 'matched',
  QUEUED: 'queued',
  GENERATED: 'generated',
  PUBLISHED: 'published',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

/** Field order of a log entry, exactly as defined by Phase 11.1. */
const SCHEMA_FIELDS = Object.freeze([
  'timestamp',
  'site',
  'commentId',
  'commentText',
  'matchedRule',
  'generatedReply',
  'status',
  'error',
]);

/**
 * Coerce any value to a string, or '' when absent.
 * Keeps entries JSON-serializable (no undefined leaking into storage).
 */
function str(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Build one log entry in the Phase 11.1 schema (pure — no storage access).
 *
 * Every entry always carries all eight schema fields so a consumer can rely on the
 * shape without null-checking each field.
 *
 * @param {Object} input
 * @param {string} input.status        — one of LOG_STATUS
 * @param {string} [input.site]        — platform name; defaults to 'YouTube'
 * @param {string} [input.commentId]
 * @param {string} [input.commentText]
 * @param {string} [input.matchedRule] — id of the rule that matched
 * @param {string} [input.generatedReply]
 * @param {string} [input.error]       — failure reason, for status 'failed'
 * @param {number} [input.timestamp]   — ms epoch; defaults to now (testable)
 * @returns {Object} a complete log entry
 */
export function createLog(input = {}) {
  const status = Object.values(LOG_STATUS).includes(input.status)
    ? input.status
    : LOG_STATUS.FAILED;

  return {
    timestamp: typeof input.timestamp === 'number' ? input.timestamp : Date.now(),
    site: str(input.site) || 'YouTube',
    commentId: str(input.commentId),
    commentText: str(input.commentText),
    matchedRule: str(input.matchedRule),
    generatedReply: str(input.generatedReply),
    status: status,
    error: str(input.error),
  };
}

// ── Persistence (the only chrome.* boundary) ─────────────────────────────────

/**
 * Serialize writes through a single promise chain.
 *
 * saveLog() is a read-modify-write. Two overlapping calls would both read the old
 * array and the second write would discard the first entry. The reply pipeline
 * already runs one job at a time, but `queued` is logged from the message handler
 * while a job may still be processing, so the race is real. Chaining keeps every
 * append without changing any reply/queue behaviour.
 */
let _writeChain = Promise.resolve();

/** Read the stored log array. Returns [] when absent, malformed, or on failure. */
async function _read() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value = result && result[STORAGE_KEY];
    return Array.isArray(value) ? value : [];
  } catch (err) {
    logError('activity log read error:', err.message);
    return [];
  }
}

/** Write the full array back. Resolves silently on failure; never rejects. */
async function _write(entries) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: entries });
  } catch (err) {
    logError('activity log write error:', err.message);
    // Silently resolve — a logging failure must NEVER break replying.
  }
}

/**
 * Append a log entry, keeping only the newest MAX_LOGS entries (Phase 11.2).
 *
 * Newest first. Never throws and never rejects: logging is observability, and a
 * storage failure here must not affect the reply flow.
 *
 * The returned promise resolves once the entry is durable. Callers on the reply hot
 * path deliberately do NOT await it — the write still happens, just off the critical
 * path — but an awaitable result is what makes this testable and usable from a future
 * Logs UI.
 *
 * @param {Object} entry — an entry from createLog(), or a raw input object
 * @returns {Promise<Object>} resolves with the stored entry
 */
export function saveLog(entry) {
  const record = createLog(entry);
  _writeChain = _writeChain
    .then(async () => {
      const entries = await _read();
      entries.unshift(record);
      await _write(entries.length > MAX_LOGS ? entries.slice(0, MAX_LOGS) : entries);
    })
    .catch(() => { /* already logged inside _read/_write */ });
  return _writeChain.then(() => record);
}

/**
 * Read the log, newest first (the read half of Phase 11.3, exposed for a future UI).
 *
 * @returns {Promise<Array>} stored entries, or [] on failure
 */
export async function getLogs() {
  return _read();
}

/**
 * Delete every stored log entry (Phase 11.4 — the clear action).
 *
 * Uses `remove` rather than writing an empty array so the key is gone entirely and
 * subsequent reads return [] through the normal path.
 *
 * @returns {Promise<boolean>} true when the clear succeeded
 */
export async function clearLogs() {
  _writeChain = _writeChain.catch(() => {});
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    return true;
  } catch (err) {
    logError('activity log clear error:', err.message);
    return false;
  }
}

/** Exposed for tests/consumers that need to validate a shape. */
export const LOG_SCHEMA_FIELDS = SCHEMA_FIELDS;

/**
 * Phase 19.4 — the replies most recently written, for repeat detection.
 *
 * Reads from the log rather than a second store, so there is one history of what was
 * actually generated. Only `generated` rows qualify: a queued/matched/skipped/failed
 * row carries no reply text, and a `published` row has one.
 *
 * Read newest-first, so `limit` takes the most recent replies — the ones a model is
 * most likely to repeat verbatim.
 *
 * @param {number} [limit]  — how many replies to return (default 20)
 * @param {number} [windowMs] — only consider rows this recent (default: 1 hour)
 * @param {number} [now] — ms epoch, injectable for tests
 * @returns {Promise<string[]>} raw reply strings, newest first
 */
export async function getRecentGeneratedReplies(limit = 20, windowMs = 60 * 60 * 1000, now = Date.now()) {
  const capped = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const entries = await _read();
  const out = [];
  for (const entry of entries) {
    if (out.length >= capped) break;
    if (!entry || typeof entry.generatedReply !== 'string' || !entry.generatedReply.trim()) continue;
    if (entry.status !== LOG_STATUS.GENERATED && entry.status !== LOG_STATUS.PUBLISHED) continue;
    const at = typeof entry.timestamp === 'number' ? entry.timestamp : 0;
    if (now - at > windowMs) continue;
    out.push(entry.generatedReply);
  }
  return out;
}
