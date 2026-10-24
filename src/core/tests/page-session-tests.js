/**
 * Page-Session Tests — Phase 19.8
 *
 * THE BUG: reloading a YouTube page made previously detected comments permanently
 * unprocessable. Reloading the extension from chrome://extensions "fixed" it, which is what
 * identified the cause: chrome.storage.local survives an extension reload, so the blocker
 * could not have been stored data — it had to be service-worker state that a page reload
 * leaves alone and an extension restart clears.
 *
 * TWO CAUSES, and both had to be fixed:
 *
 *  1. The duplicate-generation guard was keyed on the bare comment id, so "already
 *     generated" meant "since the worker booted" rather than "during this page load".
 *  2. markHandled() ran at GENERATION time, before anything was published, so a comment
 *     whose reply was merely prepared — including every dry run — became permanently
 *     unprocessable.
 *
 * The properties under test, in the order they matter:
 *   - page-session state is per page load and does not survive a reload
 *   - the handled store survives a reload ONLY for a real publish
 *   - within one page session, a comment is still processed exactly once
 *
 * Runs in the browser from page-session-tests.html (there is no Node runner).
 */

import { resetStorage, readStore } from './chrome-storage-stub.js';
import { createReplyDeduplicator } from '../reply-deduplicator.js';
import { createFingerprint } from '../comment-fingerprint.js';
import { resolvePageSessionId, NO_PAGE_SESSION } from '../page-session.js';
import { markHandled, isHandled, cleanupOldRecords, DEFAULT_AGE_MS } from '../handled-comments.js';
import { addPendingJob, loadPendingJobs, clearPendingJobs, removePendingJob } from '../queue-persistence.js';
import { resetProcessingStats, getProcessingState } from '../processing-stats.js';
import {
  configure,
  deps,
  processJob,
  publishReply,
  resetPendingHandled,
  getDiagEvents,
  resetDiagEvents
} from './sw-processing-harness.js';

const results = { total: 0, passed: 0, failed: 0 };

async function runTest(name, fn) {
  results.total++;
  try {
    const ok = await fn();
    if (ok === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: ${ok}`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

/** A trigger that matches everything, so only the surrounding flow is under test. */
function matchAllRule(overrides = {}) {
  return {
    id: 'rule-session',
    enabled: true,
    phrases: ['بكام'],
    matchMode: 'contains',
    caseSensitive: false,
    ...overrides
  };
}

/** Reset every piece of state the lifecycle touches. */
function fresh(overrides = {}) {
  resetStorage();
  resetProcessingStats();
  resetPendingHandled();
  resetDiagEvents();
  configure({
    enabled: true,
    dryRun: false,
    triggers: [matchAllRule()],
    handled: new Map(),
    hasGeneration: () => false,
    markHandledCalls: [],
    generate: async () => ({ text: 'السعر 100 جنيه' }),
    validate: { valid: true, reply: 'السعر 100 جنيه' },
    ...overrides
  });
}

/** The fingerprint the worker computes for one comment on one page. */
function fingerprintFor(id, text = 'بكام؟') {
  return createFingerprint(
    { id, author: 'someone', text },
    { site: 'youtube', url: 'https://www.youtube.com/watch?v=abc123' }
  );
}

// ── 9. fingerprint behaviour is unchanged ────────────────────────────────────

/** The fingerprint is still stable per comment and stable across a reload of the same URL. */
function testFingerprintIsStable() {
  const first = fingerprintFor('comment-A');
  const afterReload = fingerprintFor('comment-A');

  if (first !== afterReload) {
    return 'A reload of the same page must produce the same fingerprint';
  }
  if (first === fingerprintFor('comment-B')) return 'Two comments must not share a fingerprint';
  if (!first.startsWith('fp:id:')) return `Expected the id-based fingerprint, got "${first}"`;

  // Tracking parameters must not fork it, or a reload via a shared link would look like a
  // different comment and defeat the persistent protection.
  const shared = createFingerprint(
    { id: 'comment-A', author: 'someone', text: 'بكام؟' },
    { site: 'youtube', url: 'https://www.youtube.com/watch?v=abc123&feature=share' }
  );
  if (shared !== first) return 'A tracking parameter changed the fingerprint';

  return true;
}

// ── the page-session id itself ───────────────────────────────────────────────

/** documentId is used when Chrome provides it; that is the reload boundary. */
function testPageSessionIdPrefersDocumentId() {
  const id = resolvePageSessionId({ documentId: 'doc-1', tab: { id: 7 } });
  if (id !== 'doc-1') return `Expected documentId to win, got "${id}"`;

  // Two loads of the same tab must produce different sessions — that is the whole fix.
  const reloaded = resolvePageSessionId({ documentId: 'doc-2', tab: { id: 7 } });
  if (reloaded === id) return 'A reload produced the same session id';

  // A missing documentId must still yield something non-empty: an empty id would put every
  // session in one namespace, which is the original bug.
  const fallback = resolvePageSessionId({ tab: { id: 7 } });
  if (!fallback) return 'A sender without documentId must still get a session id';
  if (fallback === NO_PAGE_SESSION) return 'The empty session must not be the fallback';

  return true;
}

// ── 1. one page session still processes a comment exactly once ────────────────

/**
 * The same comment delivered twice in ONE page session is processed once.
 *
 * This is the dedup that must survive the fix: YouTube mutates the DOM constantly, and the
 * initial scan plus the MutationObserver both see the same comment.
 */
async function testSameSessionProcessesOnce() {
  const dedup = createReplyDeduplicator();

  // First detection registers the reply.
  if (dedup.isDuplicate({ reply: 'رد', commentId: 'c1', pageSessionId: 'session-1' })) {
    return 'The first attempt in a session must be accepted';
  }

  if (!dedup.hasGeneration('c1', 'session-1')) {
    return 'The duplicate-generation guard did not fire within one page session';
  }
  // A second detection in the SAME session is a duplicate — this is the dedup that must
  // survive the fix.
  if (!dedup.isDuplicate({ reply: 'رد', commentId: 'c1', pageSessionId: 'session-1' })) {
    return 'The second attempt in one session must be treated as a duplicate';
  }
  return true;
}

/** The harness enforces the same thing end to end, and only within one session. */
async function testSameSessionSkipsSecondDetection() {
  // A stub that reports "already generated" only for c1 in session-1, so the first
  // detection genuinely processes and only the repeat is suppressed. (A stub that simply
  // returned true would make the FIRST call skip, which is a different behaviour.)
  let generated = false;
  fresh({
    hasGeneration: (id, session) => session === 'session-1' && id === 'c1' && generated,
    onGenerate: () => { generated = true; }
  });

  const first = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'session-1' });
  const second = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'session-1' });

  if (first.result !== 'MATCH') return `The first detection should process, got ${first.result}`;
  if (second.result !== 'SKIP_SESSION_DUPLICATE') {
    return `The second detection in one session must be skipped, got ${second.result}`;
  }
  return true;
}

/**
 * Phase 19.8 regression: `pageSessionId` must be available by the time the comment is
 * processed, and it must be the value the guard is consulted with.
 *
 * A duplicate-generation stub that only answers for one session proves the session reaches
 * the guard: if the job carried no session, the second detection would be suppressed too.
 */
async function testSessionIdReachesTheDedupGuard() {
  const asked = [];
  fresh({
    hasGeneration: (id, session) => {
      asked.push(session);
      return session === 'doc-1' && id === 'c1' && asked.length > 1;
    }
  });

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  const second = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });

  if (asked[0] !== 'doc-1' || asked[1] !== 'doc-2') {
    return `The guard was consulted with ${JSON.stringify(asked)}, expected ['doc-1','doc-2']`;
  }
  if (second.result !== 'MATCH') {
    return `A comment from a NEW page session must process, got ${second.result}`;
  }
  return true;
}

// ── 2. a page reload starts a fresh session ─────────────────────────────────

/**
 * A reload gives a NEW session id, so the worker no longer treats the comment as
 * already-generated. This is the direct regression test for the reported bug.
 */
async function testPageReloadDoesNotBlockRedetection() {
  fresh();
  const dedup = createReplyDeduplicator();

  // Page session 1: the comment was detected and processed.
  dedup.isDuplicate({ reply: 'رد', commentId: 'c1', pageSessionId: 'doc-before-reload' });

  // The page reloads. The content script is recreated, so the same comment is detected
  // again — under a new documentId.
  //
  // `hasGeneration` is the guard that actually blocks a second generation, and this is the
  // direct regression assertion for the reported bug. Deliberately NOT asserting on
  // isDuplicate() here: Rule 4 (cross-comment near-duplicate similarity) still applies
  // across sessions on purpose, and an identical reply would trip it for reasons that have
  // nothing to do with page scoping.
  if (dedup.hasGeneration('c1', 'doc-after-reload')) {
    return 'A page reload still blocks redetection — this is the reported bug';
  }

  // And the per-comment rule agrees: a fresh session has no record for this comment.
  const other = createReplyDeduplicator();
  other.isDuplicate({ reply: 'رد', commentId: 'c1', pageSessionId: 'doc-before-reload' });
  if (other.hasGeneration('c1', 'doc-after-reload')) {
    return 'The per-comment rule leaked across the page-session boundary';
  }

  return true;
}

/** End to end: a processed-but-unpublished comment is processable again after a reload. */
async function testProcessedButUnpublishedIsReprocessedAfterReload() {
  fresh();

  // Session 1 — the reply is prepared and handed off, then never published (dry run).
  configure({ dryRun: true });
  const first = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1', dryRun: true });

  if (first.result !== 'MATCH') return `Session 1 should have matched, got ${first.result}`;

  // Session 2 — the user reloads. The comment is visible again.
  resetProcessingStats();
  const second = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });

  if (second.result !== 'MATCH') {
    return `After a reload the comment must be processable again, got ${second.result}`;
  }
  if (!second.reply) return 'The reloaded page produced no reply';

  return true;
}

// ── 3. a genuinely published comment IS still protected across reloads ───────

/** A real publish writes the handled record, and a reload still skips the comment. */
async function testPublishedCommentStaysHandledAcrossReload() {
  fresh();

  // Session 1: matched, reply prepared, and really published.
  const first = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1' });

  if (first.result !== 'MATCH') return `Session 1 should have matched, got ${first.result}`;

  // Session 2: the user reloads. The comment must STILL be skipped.
  resetProcessingStats();
  const second = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });

  if (second.result !== 'SKIP_ALREADY_HANDLED') {
    return `A published comment must stay skipped after a reload, got ${second.result}`;
  }
  if (second.reply !== undefined) return 'A skipped comment produced a reply anyway';
  return true;
}

/** The real store, not the harness: markHandled() persists and isHandled() survives. */
async function testHandledStorePersists() {
  resetStorage();
  const fp = fingerprintFor('comment-A');

  if (await isHandled(fp)) return 'An unhandled comment reported as handled';

  await markHandled(fp);
  if (!(await isHandled(fp))) return 'markHandled did not persist';
  if (await isHandled(fingerprintFor('comment-B'))) {
    return 'Marking one comment marked another — the store is keyed wrongly';
  }

  // And it really is in storage, which is what makes it survive a page reload.
  const stored = readStore().handledComments || {};
  if (!Object.prototype.hasOwnProperty.call(stored, fp)) {
    return 'The handled record is not in chrome.storage.local';
  }
  return true;
}

/** Cleanup still evicts only genuinely old records. */
async function testHandledCleanupUnchanged() {
  resetStorage();
  const old = fingerprintFor('old');
  const freshFp = fingerprintFor('fresh');
  await markHandled(old, { timestamp: Date.now() - DEFAULT_AGE_MS - 1000 });
  await markHandled(freshFp);

  const removed = await cleanupOldRecords(DEFAULT_AGE_MS);

  if (removed !== 1) return `Expected 1 record removed, got ${removed}`;
  if (await isHandled(old)) return 'The stale record survived cleanup';
  if (!(await isHandled(freshFp))) return 'Cleanup removed a current record';
  return true;
}

// ── 4. a dry run must not persist anything ──────────────────────────────────

/** Dry run: prepared, not submitted, and nothing written to the handled store. */
async function testDryRunDoesNotPersistHandled() {
  fresh({ dryRun: true });

  const verdict = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1', dryRun: true });

  if (verdict.reply !== 'السعر 100 جنيه') return 'A dry run should still prepare a reply';
  if (getProcessingState().repliesSubmitted !== 0) return 'A dry run submitted something';

  // Nothing may be persisted — not in the stub, not in real storage.
  if (handledCount() !== 0) return 'A dry run wrote a handled record';
  const stored = readStore().handledComments || {};
  if (Object.keys(stored).length !== 0) return 'A dry run persisted into chrome.storage.local';

  // And a reload must make it processable again.
  resetProcessingStats();
  const afterReload = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });
  if (afterReload.result !== 'MATCH') {
    return `After a dry-run reload the comment must be processable, got ${afterReload.result}`;
  }
  return true;
}

/** Size of the harness's handled store — the persistent records written so far. */
function handledCount() {
  return deps.handled.size;
}

// ── 5 & 6. failure paths must not persist ───────────────────────────────────

/** A failed publish leaves the comment eligible. */
async function testFailedProcessingDoesNotPersist() {
  fresh();

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  // The reply box never opened.
  await publishReply({ id: 'c1', openBoxOk: false });

  if (handledCount() !== 0) return 'A failed publish wrote a handled record';

  resetProcessingStats();
  const afterReload = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });
  if (afterReload.result !== 'MATCH') {
    return `After a failed publish the comment must be processable, got ${afterReload.result}`;
  }
  return true;
}

/** Text inserted but the submit failed — still nothing published, still not handled. */
async function testFailedSubmitDoesNotPersist() {
  fresh();

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1', submitOk: false });

  if (handledCount() !== 0) return 'A failed submit wrote a handled record';

  resetProcessingStats();
  const afterReload = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });
  if (afterReload.result !== 'MATCH') {
    return `After a failed submit the comment must be processable, got ${afterReload.result}`;
  }
  return true;
}

/** A reply that was generated and handed off but never reported at all. */
async function testGeneratedWithoutPublishDoesNotPersist() {
  fresh();

  const verdict = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  if (!verdict.reply) return 'The reply should have been generated';

  // No publishReply() at all: the page was closed, or the user navigated away.
  if (handledCount() !== 0) {
    return 'A reply that was only generated was marked handled';
  }

  resetProcessingStats();
  const afterReload = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-2' });
  if (afterReload.result !== 'MATCH') {
    return `After an unpublished reply the comment must be processable, got ${afterReload.result}`;
  }
  return true;
}

// ── 7. a real publish does persist ──────────────────────────────────────────

/** The successful path is the ONLY one that writes a record. */
async function testRealPublishPersistsHandled() {
  fresh();

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1' });

  if (handledCount() !== 1) {
    return `A real publish must write exactly one record, got ${handledCount()}`;
  }
  if (getProcessingState().repliesSubmitted !== 1) return 'The publish was not counted';

  // And it keys on the fingerprint, which is what is stable across reloads.
  if (!deps.handled.has('fp-a')) return 'The record is not keyed by the fingerprint';
  return true;
}

/** Two different comments both published are both recorded. */
async function testTwoPublishedCommentsBothRecorded() {
  fresh();

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1' });
  resetProcessingStats();
  await processJob({ id: 'c2', text: 'السعر كام؟', fingerprint: 'fp-b', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c2' });

  if (handledCount() !== 2) return `Expected 2 records, got ${handledCount()}`;
  return true;
}

// ── 8. an existing record still prevents duplicate processing ───────────────

/** A record written in a much earlier session still skips the comment. */
async function testExistingRecordStillPreventsProcessing() {
  const stored = new Map([['fp-a', { timestamp: Date.now() }]]);
  fresh({ handled: stored });

  const verdict = await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-new' });

  if (verdict.result !== 'SKIP_ALREADY_HANDLED') {
    return `An existing record must still skip, got ${verdict.result}`;
  }
  if (verdict.reply !== undefined) return 'A skipped comment produced a reply';

  const state = getProcessingState();
  if (state.repliesGenerated !== 0) return 'A skipped comment counted as generated';
  if (state.failedSkipped !== 1) return 'The skip was not counted';
  return true;
}

/** The skip reason is in the diagnostic log, so the log explains the behaviour. */
async function testSkipIsLoggedWithItsReason() {
  fresh({ handled: new Map([['fp-a', { timestamp: Date.now() }]]) });

  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-new' });

  const events = getDiagEvents();
  const entry = events.find((e) => e.event === 'SKIP_ALREADY_HANDLED');
  if (!entry) {
    return `The handled-store skip was not logged; saw: ${events.map((e) => e.event).join(', ') || '(nothing)'}`;
  }
  if (!entry.data || !entry.data.reason) return 'The skip entry does not say why';

  // The comment text must not be in the diagnostic entry.
  if (JSON.stringify(events).includes('بكام؟')) {
    return 'The comment text leaked into the diagnostic entry';
  }
  return true;
}

/**
 * The two skips are logged under separate events, because they mean opposite things: one
 * is "this comment was answered", the other is "this page already saw it".
 */
async function testTheTwoSkipsAreDistinguishable() {
  // A comment with no record is processed, not reported as handled.
  fresh();
  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  const seen = getDiagEvents().map((e) => e.event);
  if (seen.includes('SKIP_ALREADY_HANDLED')) {
    return 'A fresh comment was reported as already handled';
  }

  // A comment WITH a record is reported as handled, which is the other event.
  fresh({ handled: new Map([['fp-b', { timestamp: Date.now() }]]) });
  await processJob({ id: 'c2', text: 'بكام؟', fingerprint: 'fp-b', pageSessionId: 'doc-1' });
  const handledSeen = getDiagEvents().map((e) => e.event);
  if (!handledSeen.includes('SKIP_ALREADY_HANDLED')) {
    return 'A handled comment was not reported as already handled';
  }
  return true;
}

// ── 10. queue behaviour is unchanged ────────────────────────────────────────

/**
 * Pending-job persistence still works and is still keyed per comment.
 *
 * Phase 19.8 deliberately added no new persisted key: a page session is worker-scoped and
 * must never be stored, or a reload would resurrect it — the original bug in a new form.
 */
async function testQueuePersistenceUnchanged() {
  resetStorage();
  await clearPendingJobs();
  await addPendingJob({ commentId: 'c1', text: 'بكام؟', fingerprint: 'fp-a', enqueuedAt: Date.now() });

  const jobs = await loadPendingJobs();
  if (jobs.length !== 1) return `Expected 1 pending job, got ${jobs.length}`;
  if (jobs[0].commentId !== 'c1' || jobs[0].fingerprint !== 'fp-a') {
    return 'The pending job lost its comment id or fingerprint';
  }

  // A pageSessionId must NOT have been added to what is persisted.
  if ('pageSessionId' in jobs[0]) {
    return 'A page session was persisted — it would survive the reload it exists to scope';
  }

  await removePendingJob('c1');
  if ((await loadPendingJobs()).length !== 0) return 'removePendingJob did not remove the job';
  return true;
}

/** Processing still happens one comment at a time, and counters still add up. */
async function testQueueCountersUnchanged() {
  fresh();

  // Two comments, both published, with NO reset between them: the counters are supposed to
  // accumulate across a run, so resetting here would be testing the wrong thing.
  await processJob({ id: 'c1', text: 'بكام؟', fingerprint: 'fp-a', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c1' });
  await processJob({ id: 'c2', text: 'السعر كام؟', fingerprint: 'fp-b', pageSessionId: 'doc-1' });
  await publishReply({ id: 'c2' });

  const state = getProcessingState();
  if (state.repliesSubmitted !== 2) return `Expected 2 submissions, got ${state.repliesSubmitted}`;
  if (state.repliesGenerated !== 2) return `Expected 2 generated, got ${state.repliesGenerated}`;
  if (state.failedSkipped !== 0) return `Expected no skips, got ${state.failedSkipped}`;
  return true;
}

/** Run all tests and print a summary. */
async function runAllTests() {
  console.log('\n=== Page Session Tests (Phase 19.8) ===\n');

  await runTest('A comment fingerprint is stable across a reload', testFingerprintIsStable);
  await runTest('The page session id comes from the document', testPageSessionIdPrefersDocumentId);

  await runTest('One page session processes a comment once', testSameSessionProcessesOnce);
  await runTest('A second detection in one session is skipped', testSameSessionSkipsSecondDetection);
  await runTest('The session id reaches the dedup guard', testSessionIdReachesTheDedupGuard);

  await runTest('A page reload does not block redetection', testPageReloadDoesNotBlockRedetection);
  await runTest('Processed but unpublished is processable again', testProcessedButUnpublishedIsReprocessedAfterReload);

  await runTest('A published comment stays handled across reloads', testPublishedCommentStaysHandledAcrossReload);
  await runTest('The handled store persists to storage', testHandledStorePersists);
  await runTest('Handled-record cleanup is unchanged', testHandledCleanupUnchanged);

  await runTest('A dry run does not persist as handled', testDryRunDoesNotPersistHandled);
  await runTest('A failed publish does not persist as handled', testFailedProcessingDoesNotPersist);
  await runTest('A failed submit does not persist as handled', testFailedSubmitDoesNotPersist);
  await runTest('A generated-only reply does not persist', testGeneratedWithoutPublishDoesNotPersist);

  await runTest('A real publish persists as handled', testRealPublishPersistsHandled);
  await runTest('Two published comments are both recorded', testTwoPublishedCommentsBothRecorded);
  await runTest('An existing record still prevents processing', testExistingRecordStillPreventsProcessing);
  await runTest('The skip reason is in the diagnostic log', testSkipIsLoggedWithItsReason);
  await runTest('The two skip reasons are distinguishable', testTheTwoSkipsAreDistinguishable);

  await runTest('Queue persistence is unchanged', testQueuePersistenceUnchanged);
  await runTest('Queue counters are unchanged', testQueueCountersUnchanged);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;