/**
 * Answered Follow-up Store — Phase 22
 *
 * The list of comments the creator has already answered, shown in the side panel.
 *
 * NOT A SETTING. Like `pendingJobs`, `handledComments` and `activityLogs`, this is runtime
 * state and must never be added to DEFAULT_CONFIG or to the getSettings() key list: it is
 * deep-merged into a fresh settings object on every queue iteration, and a list of comment
 * texts does not belong there.
 *
 * ── Why this is bounded and short-lived ─────────────────────────────────────────
 *
 * It is a NOTICE BOARD, not a record. Its whole job is to answer "what did I already reply
 * to that I might want to follow up on?" while the creator is looking at this video. Once
 * they have acted, the entry is dropped — carrying it for 30 days like `handledComments`
 * would grow a storage key without limit for no benefit, and a stale entry points at a
 * comment the creator scrolled past days ago.
 *
 * Writes are swallowed rather than thrown, unlike knowledge-store.js. This sits beside the
 * reply path and a full disk must never stop the extension from replying to customers.
 */

import { logError } from './debug.js';

/** Storage key. Read directly; deliberately absent from DEFAULT_CONFIG. */
const STORAGE_KEY = 'answeredFollowups';

/**
 * How many entries are kept.
 *
 * Bounded because the scan runs on every mutation batch and a busy video can carry
 * hundreds of answered threads. The creator reviews a handful; the rest are noise.
 */
export const MAX_ANSWERED_FOLLOWUPS = 50;

/** Entries older than this are dropped on read. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest comment text kept for display. */
const MAX_TEXT_CHARS = 1500;

/** Longest single reply text kept for display. */
const MAX_REPLY_CHARS = 400;

function safeString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function clamp(value, max) {
  const text = safeString(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

async function readRaw() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value = result && result[STORAGE_KEY];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return {};
  } catch (error) {
    logError('answered-followup read error:', error);
    return {};
  }
}

async function writeRaw(records) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  } catch (error) {
    logError('answered-followup write error:', error);
  }
}

/**
 * Record a thread the creator has answered.
 *
 * KEYED BY FINGERPRINT, not by comment id. The comment id is frequently a per-page-load
 * counter (`comment-N`, regenerated on every reload), so keying on it would fill the store
 * with the same thread repeatedly and never match across a reload.
 *
 * Re-recording a thread REFRESHES its timestamp rather than resetting its state, so a
 * comment the creator has already dismissed does not reappear every time the page
 * re-renders — which, on a busy video, is continuously.
 *
 * @param {Object} input
 * @param {string} input.fingerprint
 * @param {Object} input.comment - {id, author, text}
 * @param {Array<{author?: string, text?: string, isOwner?: boolean}>} input.replies
 * @param {string} [input.videoId]
 * @returns {Promise<Object|null>} the stored entry, or null when it was rejected
 */
export async function recordAnsweredComment(input) {
  const fingerprint = safeString(input?.fingerprint).trim();
  const text = clamp(input?.comment?.text, MAX_TEXT_CHARS);
  if (!fingerprint || !text) return null;

  const replies = (Array.isArray(input?.replies) ? input.replies : [])
    .filter((r) => r && safeString(r.text).trim())
    .slice(0, 10)
    .map((r) => ({
      author: clamp(r.author, 80),
      text: clamp(r.text, MAX_REPLY_CHARS),
      isOwner: r.isOwner === true
    }));

  // No owner reply means this thread does not belong on the board at all. Re-checked here
  // rather than trusted from the caller, because this store is the one place the rule can
  // still be enforced cheaply.
  if (!replies.some((r) => r.isOwner)) return null;

  const records = await readRaw();
  const previous = records[fingerprint];

  records[fingerprint] = {
    id: safeString(input?.comment?.id),
    author: clamp(input?.comment?.author, 80),
    text,
    replies,
    videoId: safeString(input?.videoId),
    // Preserved, not reset: a draft the creator has not acted on stays on the board across
    // the page re-renders that happen while they read it.
    draft: previous && typeof previous.draft === 'string' ? previous.draft : '',
    reason: previous && typeof previous.reason === 'string' ? previous.reason : '',
    // Refreshed on every sighting so an entry the creator is actively looking at does not
    // age out from under them.
    firstSeenAt: previous && typeof previous.firstSeenAt === 'number' ? previous.firstSeenAt : Date.now(),
    timestamp: Date.now()
  };

  await prune(records);
  await writeRaw(records);
  return records[fingerprint];
}

/**
 * Drop entries past the age limit and past the count limit, oldest first.
 *
 * Done as part of the write rather than on a timer: an MV3 worker sleeps, so a scheduled
 * cleanup would rarely run, and this way the store cannot grow unbounded even if it is
 * never opened again.
 */
async function prune(records) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [key, entry] of Object.entries(records)) {
    const stamp = entry && typeof entry.timestamp === 'number' ? entry.timestamp : 0;
    if (stamp < cutoff) delete records[key];
  }

  const keys = Object.keys(records);
  if (keys.length <= MAX_ANSWERED_FOLLOWUPS) return;
  keys
    .sort((a, b) => (records[a].timestamp || 0) - (records[b].timestamp || 0))
    .slice(0, keys.length - MAX_ANSWERED_FOLLOWUPS)
    .forEach((key) => delete records[key]);
}

/**
 * Every entry still on the board, newest first.
 * @returns {Promise<Array<Object>>}
 */
export async function listAnsweredComments() {
  const records = await readRaw();
  const cutoff = Date.now() - MAX_AGE_MS;
  return Object.entries(records)
    .filter(([key, entry]) => {
      const stamp = entry && typeof entry.timestamp === 'number' ? entry.timestamp : 0;
      return stamp >= cutoff;
    })
    .map(([fingerprint, entry]) => Object.assign({ fingerprint }, entry))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Read one entry back.
 * @param {string} fingerprint
 * @returns {Promise<Object|null>}
 */
export async function getAnsweredComment(fingerprint) {
  const records = await readRaw();
  const entry = records[safeString(fingerprint).trim()];
  return entry ? Object.assign({ fingerprint }, entry) : null;
}

/**
 * Attach a draft to an entry, so the panel does not lose it on its next poll.
 * @param {string} fingerprint
 * @param {{draft?: string, reason?: string}} patch
 * @returns {Promise<Object|null>}
 */
export async function setAnsweredDraft(fingerprint, patch) {
  const key = safeString(fingerprint).trim();
  if (!key) return null;
  const records = await readRaw();
  if (!records[key]) return null;
  records[key].draft = clamp(patch?.draft, MAX_TEXT_CHARS);
  records[key].reason = clamp(patch?.reason, 300);
  await writeRaw(records);
  return records[key];
}

/**
 * Drop one entry — called when the creator has acted on it.
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function dismissAnsweredComment(fingerprint) {
  const key = safeString(fingerprint).trim();
  if (!key) return false;
  const records = await readRaw();
  if (!records[key]) return false;
  delete records[key];
  await writeRaw(records);
  return true;
}

/** Clear the whole board. Exposed for the panel's "clear" control. */
export async function clearAnsweredComments() {
  await writeRaw({});
  return true;
}
