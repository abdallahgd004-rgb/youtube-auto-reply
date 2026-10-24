// Phase 19.3 — Pending job persistence and recovery
//
// WHY THIS EXISTS
// A Chrome MV3 service worker is killed whenever it is idle for ~30 seconds. The job
// queue is in-memory only, so every comment still WAITING in the queue is silently lost
// when that happens. With the configured 8–20s delay between replies, a burst of
// matching comments is exactly the case where this hurts: the user watches several
// comments get replies and then nothing more arrives, with no error anywhere.
//
// WHAT IS PERSISTED
// Only the three fields needed to re-run the pipeline: the comment id, its text, and
// the handled-comment fingerprint. The job's `respondOnce` closure is deliberately NOT
// persisted — it belongs to a message channel that died with the worker, so a recovered
// job runs with a no-op responder.
//
// WHEN A JOB IS REMOVED
// At DEQUEUE time, not after processing. Once a job is being worked on, re-running it
// after a crash could spend a second LM Studio call and, with dry-run off, could post
// twice for one comment. Dropping an in-flight job is the safer direction and matches
// what already happens without this module. What this module protects is the jobs that
// were still WAITING.
//
// PRIVACY
// `pendingJobs` holds raw comment text, exactly like `activityLogs` does. It is local
// to the user's Chrome profile and is documented in docs/SECURITY_REVIEW.md.

/**
 * Storage key holding the pending job list.
 *
 * IMPORTANT: like `queuePaused`, `handledComments` and `activityLogs`, this is a
 * top-level chrome.storage.local key read directly. It must NOT be added to
 * DEFAULT_CONFIG or to the key list in getSettings().
 */
import { logError } from './debug.js';

const STORAGE_KEY = 'pendingJobs';

/**
 * Longest a persisted job may wait and still be recovered (Phase 19.3).
 *
 * A comment scrolled out of the loaded page can no longer be replied to, so an old job
 * is not worth resurrecting: the adapter would fail to find the comment and the reply
 * box. Two minutes covers a realistic queue wait (the default cap is 30 replies/hour
 * with 8–20s gaps) while bounding how long stale text is kept.
 */
export const MAX_RECOVERABLE_AGE_MS = 2 * 60 * 1000;

/**
 * Most jobs kept on disk.
 *
 * Bounds storage growth and bounds the worst case after a restart. Chosen well above
 * the default hourly reply cap of 30.
 */
export const MAX_PERSISTED_JOBS = 50;

/**
 * Serialize writes through a single promise chain.
 *
 * Both add and remove are read-modify-write. The reply pipeline processes one job at a
 * time, but `addPendingJob` is called from the message handler while the worker may
 * already be dequeuing, so the race is real. Chaining keeps both without changing any
 * reply behaviour.
 */
let _writeChain = Promise.resolve();

/** Read the stored list. Returns [] when absent or malformed. */
async function _read() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value = result && result[STORAGE_KEY];
    return Array.isArray(value) ? value : [];
  } catch (err) {
    logError('pending job read error:', err.message);
    return [];
  }
}

/** Write the full list back. Never rejects. */
async function _write(entries) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: entries });
  } catch (err) {
    logError('pending job write error:', err.message);
    // A logging/persistence failure must NEVER break replying.
  }
}

/**
 * Reduce any input to the persisted shape, or null when it is unusable.
 *
 * Only strings survive: a malformed entry must not reach the reply pipeline as
 * `undefined`, which the COMMENT_DETECTED validation would reject anyway.
 *
 * @param {*} job
 * @returns {Object|null}
 */
function toEntry(job) {
  if (!job || typeof job !== 'object') return null;
  const commentId = typeof job.commentId === 'string' ? job.commentId : '';
  const text = typeof job.text === 'string' ? job.text : '';
  if (!commentId || !text) return null;
  return {
    commentId,
    text,
    // The fingerprint may legitimately be absent for an old entry; processJob treats a
    // falsy fingerprint as "not handled", which is the correct default for a fresh job.
    fingerprint: typeof job.fingerprint === 'string' ? job.fingerprint : '',
    enqueuedAt: typeof job.enqueuedAt === 'number' && Number.isFinite(job.enqueuedAt)
      ? job.enqueuedAt
      : Date.now()
  };
}

/**
 * Persist a job that is waiting in the queue.
 *
 * Re-adding the same comment id replaces the existing entry rather than appending a
 * duplicate, so a comment the observer re-reports cannot grow the list.
 *
 * @param {{commentId: string, text: string, fingerprint?: string, enqueuedAt?: number}} job
 * @returns {Promise<boolean>} true when the job is now persisted
 */
export function addPendingJob(job) {
  const entry = toEntry(job);
  if (!entry) return Promise.resolve(false);

  _writeChain = _writeChain
    .then(async () => {
      const entries = await _read();
      const withoutDuplicate = entries.filter((e) => e && e.commentId !== entry.commentId);
      withoutDuplicate.push(entry);
      await _write(withoutDuplicate.slice(-MAX_PERSISTED_JOBS));
    })
    .catch(() => { /* already logged inside _read/_write */ });

  return _writeChain.then(() => true);
}

/**
 * Drop a job that has left the waiting queue.
 *
 * @param {string} commentId
 * @returns {Promise<void>}
 */
export function removePendingJob(commentId) {
  if (typeof commentId !== 'string' || !commentId) return Promise.resolve();
  _writeChain = _writeChain
    .then(async () => {
      const entries = await _read();
      await _write(entries.filter((e) => e && e.commentId !== commentId));
    })
    .catch(() => { /* already logged inside _read/_write */ });
  return _writeChain.then(() => undefined);
}

/**
 * Read the jobs that are still worth recovering.
 *
 * Filters, in order: malformed entries dropped, jobs older than
 * MAX_RECOVERABLE_AGE_MS dropped, everything after the newest MAX_PERSISTED_JOBS
 * dropped. Returns the survivors oldest-first so they re-enter the queue in their
 * original order.
 *
 * @param {number} [now] — ms epoch, injectable for tests
 * @returns {Promise<Array>} recoverable entries
 */
export async function loadPendingJobs(now = Date.now()) {
  const entries = await _read();
  const usable = entries
    .map(toEntry)
    .filter(Boolean)
    .filter((e) => now - e.enqueuedAt <= MAX_RECOVERABLE_AGE_MS)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return usable.slice(-MAX_PERSISTED_JOBS);
}

/**
 * How many jobs are currently persisted, ignoring age.
 *
 * @returns {Promise<number>}
 */
export async function countPendingJobs() {
  const entries = await _read();
  return entries.filter((e) => e && typeof e.commentId === 'string').length;
}

/**
 * Delete every persisted job.
 *
 * @returns {Promise<boolean>}
 */
export async function clearPendingJobs() {
  _writeChain = _writeChain.catch(() => {});
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    return true;
  } catch (err) {
    logError('pending job clear error:', err.message);
    return false;
  }
}

export { STORAGE_KEY as PENDING_JOBS_STORAGE_KEY };