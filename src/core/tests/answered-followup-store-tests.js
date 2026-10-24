/**
 * Answered Follow-up Store tests — Phase 22
 *
 * The store is the one piece of Phase 22 that writes to chrome.storage, so it is tested
 * against the same stub every other store suite uses rather than being trusted.
 */

import { resetStorage } from './chrome-storage-stub.js';
import {
  recordAnsweredComment,
  listAnsweredComments,
  getAnsweredComment,
  setAnsweredDraft,
  dismissAnsweredComment,
  clearAnsweredComments,
  MAX_ANSWERED_FOLLOWUPS
} from '../answered-followup-store.js';

const results = { total: 0, passed: 0, failed: 0 };
const failures = [];

async function runTest(name, fn) {
  results.total++;
  try {
    const outcome = await fn();
    if (outcome === true) {
      results.passed++;
      console.log('  ✓', name);
    } else {
      results.failed++;
      failures.push({ name, reason: String(outcome) });
      console.log('  ✗', name, '—', outcome);
    }
  } catch (error) {
    results.failed++;
    failures.push({ name, reason: error.message });
    console.log('  ✗', name, '— threw:', error.message);
  }
}

function section(title) {
  console.log('\n' + title);
}

const OWNER_REPLY = [{ author: 'me', text: 'السعر 350 جنيه', isOwner: true }];
const VIEWER_REPLY = [{ author: 'someone', text: 'me too', isOwner: false }];

function entry(overrides = {}) {
  return Object.assign(
    {
      fingerprint: 'fp:id:YouTube|watch?v=abc|comment-1',
      comment: { id: 'comment-1', author: 'أحمد', text: 'بكام الكتاب؟' },
      replies: OWNER_REPLY
    },
    overrides
  );
}

// ── 1. what gets recorded ─────────────────────────────────────────────────────

async function testARecordedThreadIsListed() {
  resetStorage();
  await recordAnsweredComment(entry());
  const list = await listAnsweredComments();
  if (list.length !== 1) return `expected one entry, got ${list.length}`;
  if (list[0].text !== 'بكام الكتاب؟') return `the text was lost: ${list[0].text}`;
  return true;
}

/**
 * THE RULE, enforced at the last possible moment.
 *
 * The content script also decides this, in a different module it cannot share with the
 * store. Two implementations of one rule is one rule too many, so the store re-checks it:
 * a thread with replies but none from the creator never reaches the board.
 */
async function testAThreadWithNoOwnerReplyIsRefused() {
  resetStorage();
  const stored = await recordAnsweredComment(entry({ replies: VIEWER_REPLY }));
  if (stored) return 'a thread nobody replied to was stored';
  const list = await listAnsweredComments();
  if (list.length !== 0) return 'and it reached the list';
  return true;
}

async function testAnEmptyThreadIsRefused() {
  resetStorage();
  if (await recordAnsweredComment(entry({ replies: [] }))) return 'an empty thread was stored';
  return true;
}

async function testJunkIsRefused() {
  resetStorage();
  for (const input of [
    null,
    undefined,
    {},
    { fingerprint: '', comment: { text: 'x' }, replies: OWNER_REPLY },
    { fingerprint: 'fp', comment: { text: '' }, replies: OWNER_REPLY },
    { fingerprint: 'fp', replies: OWNER_REPLY }
  ]) {
    if (await recordAnsweredComment(input)) return `${JSON.stringify(input)} was stored`;
  }
  return true;
}

// ── 2. re-recording ───────────────────────────────────────────────────────────

/**
 * The comment id is frequently a per-page-load counter, so the SAME thread is re-reported
 * on every re-render. It must update one entry, not add another — a board that fills with
 * copies of one thread is one the creator cannot use.
 */
async function testReRecordingTheSameThreadDoesNotDuplicateIt() {
  resetStorage();
  await recordAnsweredComment(entry());
  await recordAnsweredComment(entry());
  await recordAnsweredComment(entry());
  const list = await listAnsweredComments();
  if (list.length !== 1) return `three sightings produced ${list.length} entries`;
  return true;
}

/**
 * And a draft the creator has not acted on survives those re-renders — they are scrolling
 * the page while reading it.
 */
async function testReRecordingPreservesADraft() {
  resetStorage();
  await recordAnsweredComment(entry());
  await setAnsweredDraft('fp:id:YouTube|watch?v=abc|comment-1', { draft: 'الجواب', reason: 'r' });
  await recordAnsweredComment(entry());
  const stored = await getAnsweredComment('fp:id:YouTube|watch?v=abc|comment-1');
  if (stored.draft !== 'الجواب') return `the draft was lost: ${stored.draft}`;
  return true;
}

async function testFirstSeenSurvivesButTimestampRefreshes() {
  resetStorage();
  await recordAnsweredComment(entry());
  const first = await getAnsweredComment('fp:id:YouTube|watch?v=abc|comment-1');
  await new Promise((r) => setTimeout(r, 5));
  await recordAnsweredComment(entry());
  const second = await getAnsweredComment('fp:id:YouTube|watch?v=abc|comment-1');
  if (second.firstSeenAt !== first.firstSeenAt) return 'firstSeenAt was reset';
  if (second.timestamp <= first.timestamp) return 'the timestamp was not refreshed';
  return true;
}

// ── 3. bounds ─────────────────────────────────────────────────────────────────

/**
 * Bounded because the scan runs on every mutation batch, and a busy video can carry
 * hundreds of answered threads. Unbounded, the storage key grows forever for a notice board
 * nobody reads.
 */
async function testTheBoardIsBounded() {
  resetStorage();
  const count = MAX_ANSWERED_FOLLOWUPS + 15;
  for (let i = 0; i < count; i++) {
    await recordAnsweredComment(
      entry({ fingerprint: `fp:${i}`, comment: { id: `c${i}`, text: `q${i}` } })
    );
  }
  const list = await listAnsweredComments();
  if (list.length > MAX_ANSWERED_FOLLOWUPS) return `${list.length} entries survived the cap`;
  if (list.length === 0) return 'the cap dropped everything';
  return true;
}

async function testTheBoardKeepsTheNewest() {
  resetStorage();
  for (let i = 0; i < MAX_ANSWERED_FOLLOWUPS + 5; i++) {
    await recordAnsweredComment(
      entry({ fingerprint: `fp:${i}`, comment: { id: `c${i}`, text: `q${i}` } })
    );
    await new Promise((r) => setTimeout(r, 1));
  }
  const list = await listAnsweredComments();
  // Newest first.
  if (list[0].text !== `q${MAX_ANSWERED_FOLLOWUPS + 4}`) {
    return `the newest entry was dropped: ${list[0].text}`;
  }
  return true;
}

async function testStoredTextIsBounded() {
  resetStorage();
  await recordAnsweredComment(
    entry({
      comment: { id: 'c', text: 'x'.repeat(5000) },
      replies: [{ author: 'a', text: 'y'.repeat(5000), isOwner: true }]
    })
  );
  const stored = await getAnsweredComment('fp:id:YouTube|watch?v=abc|comment-1');
  if (stored.text.length > 1600) return `the comment was stored at ${stored.text.length} chars`;
  if (stored.replies[0].text.length > 500) return `a reply was stored at ${stored.replies[0].text.length} chars`;
  return true;
}

async function testAnExpiredEntryIsNotListed() {
  resetStorage();
  await recordAnsweredComment(entry());
  const records = (await chrome.storage.local.get('answeredFollowups')).answeredFollowups;
  const key = Object.keys(records)[0];
  records[key].timestamp = Date.now() - (8 * 24 * 60 * 60 * 1000);
  await chrome.storage.local.set({ answeredFollowups: records });
  const list = await listAnsweredComments();
  if (list.length !== 0) return 'an eight-day-old entry was still listed';
  return true;
}

// ── 4. removal ────────────────────────────────────────────────────────────────

async function testDismissRemovesOneEntry() {
  resetStorage();
  await recordAnsweredComment(entry({ fingerprint: 'fp:a', comment: { id: 'a', text: 'a' } }));
  await recordAnsweredComment(entry({ fingerprint: 'fp:b', comment: { id: 'b', text: 'b' } }));
  await dismissAnsweredComment('fp:a');
  const list = await listAnsweredComments();
  if (list.length !== 1) return `expected one survivor, got ${list.length}`;
  if (list[0].fingerprint !== 'fp:b') return 'the wrong entry survived';
  return true;
}

async function testClearEmptiesTheBoard() {
  resetStorage();
  await recordAnsweredComment(entry());
  await recordAnsweredComment(entry({ fingerprint: 'fp:2', comment: { id: '2', text: '2' } }));
  await clearAnsweredComments();
  const list = await listAnsweredComments();
  if (list.length !== 0) return `${list.length} entries survived the clear`;
  return true;
}

async function testDismissAndDraftOnAnUnknownEntryAreNotThrows() {
  resetStorage();
  if (await dismissAnsweredComment('nope')) return 'dismissing nothing reported success';
  if (await dismissAnsweredComment('')) return 'an empty fingerprint reported success';
  if (await setAnsweredDraft('nope', { draft: 'x' })) return 'drafting on nothing returned an entry';
  return true;
}

// ── 5. storage failures ───────────────────────────────────────────────────────

/**
 * Swallowed, deliberately — the opposite of knowledge-store.js.
 *
 * This store sits beside the reply path, and a full disk must never stop the extension
 * replying to customers. The record is lost; the extension keeps working.
 */
async function testAStorageFailureIsNotThrown() {
  resetStorage();
  const original = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  try {
    let threw = false;
    try {
      await recordAnsweredComment(entry());
    } catch (_) {
      threw = true;
    }
    if (threw) return 'a storage failure was thrown to the caller';
  } finally {
    chrome.storage.local.set = original;
  }
  return true;
}

export default async function runAllTests() {
  console.log('=== Answered Follow-up Store Tests (Phase 22) ===');

  section('What gets recorded');
  await runTest('A recorded thread is listed', testARecordedThreadIsListed);
  await runTest('A thread with no owner reply is refused', testAThreadWithNoOwnerReplyIsRefused);
  await runTest('An empty thread is refused', testAnEmptyThreadIsRefused);
  await runTest('Junk is refused', testJunkIsRefused);

  section('Re-recording');
  await runTest('Re-recording the same thread does not duplicate it', testReRecordingTheSameThreadDoesNotDuplicateIt);
  await runTest('Re-recording preserves a draft', testReRecordingPreservesADraft);
  await runTest('firstSeenAt survives but timestamp refreshes', testFirstSeenSurvivesButTimestampRefreshes);

  section('Bounds');
  await runTest('The board is bounded', testTheBoardIsBounded);
  await runTest('The board keeps the newest', testTheBoardKeepsTheNewest);
  await runTest('Stored text is bounded', testStoredTextIsBounded);
  await runTest('An expired entry is not listed', testAnExpiredEntryIsNotListed);

  section('Removal');
  await runTest('Dismiss removes one entry', testDismissRemovesOneEntry);
  await runTest('Clear empties the board', testClearEmptiesTheBoard);
  await runTest('Dismiss and draft on an unknown entry are not throws', testDismissAndDraftOnAnUnknownEntryAreNotThrows);

  section('Storage failures');
  await runTest('A storage failure is not thrown', testAStorageFailureIsNotThrown);

  return results;
}
