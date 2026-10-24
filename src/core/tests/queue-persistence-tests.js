/**
 * Pending Job Persistence Tests — Phase 19.3
 *
 * Queue recovery only earns trust if it is precise about what it brings back. These
 * cases pin the contract: what is persisted, what is deliberately dropped (stale and
 * malformed entries), ordering, the duplicate rule, and the fact that a missing or
 * corrupt store fails safe instead of throwing.
 *
 * Runs in the browser from queue-persistence-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * queue-persistence.js is evaluated.
 */

import { resetStorage, readStore, store as liveStore } from './chrome-storage-stub.js';
import {
  addPendingJob,
  removePendingJob,
  loadPendingJobs,
  countPendingJobs,
  clearPendingJobs,
  MAX_RECOVERABLE_AGE_MS,
  MAX_PERSISTED_JOBS,
  PENDING_JOBS_STORAGE_KEY
} from '../queue-persistence.js';

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

const job = (id, text = `نص ${id}`, extra = {}) => ({ commentId: id, text, ...extra });

async function testPersistsTheFieldsRecoveryNeeds() {
  resetStorage();
  await addPendingJob(job('c1', 'بكام المنتج', { fingerprint: 'fp-1' }));
  const stored = readStore()[PENDING_JOBS_STORAGE_KEY];
  if (!Array.isArray(stored) || stored.length !== 1) return 'Expected one persisted entry';
  const entry = stored[0];
  if (entry.commentId !== 'c1') return 'commentId was not persisted';
  if (entry.text !== 'بكام المنتج') return 'text was not persisted';
  if (entry.fingerprint !== 'fp-1') return 'fingerprint was not persisted';
  if (typeof entry.enqueuedAt !== 'number') return 'enqueuedAt was not persisted';
  return true;
}

async function testResponderIsNeverPersisted() {
  resetStorage();
  await addPendingJob(job('c1'));
  const entry = readStore()[PENDING_JOBS_STORAGE_KEY][0];
  if ('respondOnce' in entry) return 'The message-channel closure must never reach storage';
  if (Object.keys(entry).some((k) => typeof entry[k] === 'function')) return 'No function may be persisted';
  return true;
}

async function testRejectsUnusableInput() {
  resetStorage();
  if (await addPendingJob(null) !== false) return 'null must be rejected';
  if (await addPendingJob({}) !== false) return 'An entry with no id must be rejected';
  if (await addPendingJob({ commentId: 'c1' }) !== false) return 'An entry with no text must be rejected';
  if (countPendingJobs && (await countPendingJobs()) !== 0) return 'Nothing should have been written';
  return true;
}

async function testFingerprintDefaultsToEmptyString() {
  resetStorage();
  await addPendingJob({ commentId: 'c1', text: 'hello' });
  const entry = readStore()[PENDING_JOBS_STORAGE_KEY][0];
  if (entry.fingerprint !== '') return 'A missing fingerprint should normalize to an empty string';
  return true;
}

async function testSameCommentDoesNotDuplicate() {
  resetStorage();
  await addPendingJob(job('c1', 'first sighting'));
  await addPendingJob(job('c1', 'second sighting'));
  const stored = readStore()[PENDING_JOBS_STORAGE_KEY];
  if (stored.length !== 1) return `Expected 1 entry, got ${stored.length}`;
  if (stored[0].text !== 'second sighting') return 'The newest sighting should win';
  return true;
}

async function testRemovalIsByCommentId() {
  resetStorage();
  await addPendingJob(job('c1'));
  await addPendingJob(job('c2'));
  await addPendingJob(job('c3'));
  await removePendingJob('c2');
  const ids = readStore()[PENDING_JOBS_STORAGE_KEY].map((e) => e.commentId);
  if (ids.length !== 2) return `Expected 2 remaining, got ${ids.length}`;
  if (ids.includes('c2')) return 'The removed job is still stored';
  if (!ids.includes('c1') || !ids.includes('c3')) return 'The wrong entries were removed';
  return true;
}

async function testRemovalOfUnknownIdChangesNothing() {
  resetStorage();
  await addPendingJob(job('c1'));
  await removePendingJob('never-existed');
  await removePendingJob('');
  await removePendingJob(undefined);
  if ((await countPendingJobs()) !== 1) return 'An unknown or empty id must be a no-op';
  return true;
}

async function testFreshJobsComeBackOldestFirst() {
  resetStorage();
  const base = Date.now();
  await addPendingJob({ commentId: 'c1', text: 'a', enqueuedAt: base - 3000 });
  await addPendingJob({ commentId: 'c2', text: 'b', enqueuedAt: base - 2000 });
  await addPendingJob({ commentId: 'c3', text: 'c', enqueuedAt: base - 1000 });
  const jobs = await loadPendingJobs(base);
  if (jobs.length !== 3) return `Expected 3 recoverable jobs, got ${jobs.length}`;
  if (jobs.map((j) => j.commentId).join(',') !== 'c1,c2,c3') {
    return `Expected original order, got ${jobs.map((j) => j.commentId).join(',')}`;
  }
  return true;
}

async function testStaleJobsAreNotRecovered() {
  resetStorage();
  const now = Date.now();
  await addPendingJob({ commentId: 'fresh', text: 'a', enqueuedAt: now });
  await addPendingJob({ commentId: 'stale', text: 'b', enqueuedAt: now - MAX_RECOVERABLE_AGE_MS - 1 });
  const jobs = await loadPendingJobs(now);
  if (jobs.length !== 1) return `Expected only the fresh job, got ${jobs.length}`;
  if (jobs[0].commentId !== 'fresh') return 'The wrong job survived the age filter';
  return true;
}

async function testJobExactlyAtTheAgeLimitSurvives() {
  resetStorage();
  const now = Date.now();
  await addPendingJob({ commentId: 'edge', text: 'a', enqueuedAt: now - MAX_RECOVERABLE_AGE_MS });
  const jobs = await loadPendingJobs(now);
  if (jobs.length !== 1) return 'The boundary case should still be recoverable';
  return true;
}

async function testMalformedStoredEntriesAreSkipped() {
  resetStorage();
  // Simulate a store written by an older or interrupted version.
  liveStore[PENDING_JOBS_STORAGE_KEY] = [
    null,
    'not an object',
    { commentId: '', text: 'no id', enqueuedAt: Date.now() },
    { commentId: 'no-text', enqueuedAt: Date.now() },
    { commentId: 'good', text: 'ok', enqueuedAt: Date.now() }
  ];
  const jobs = await loadPendingJobs();
  if (jobs.length !== 1) return `Expected 1 usable entry, got ${jobs.length}`;
  if (jobs[0].commentId !== 'good') return 'The wrong entry survived';
  return true;
}

async function testMissingStoreIsAnEmptyList() {
  resetStorage();
  const jobs = await loadPendingJobs();
  if (!Array.isArray(jobs) || jobs.length !== 0) return 'A missing store must read as an empty list';
  return true;
}

async function testStoreIsCapped() {
  resetStorage();
  const base = Date.now();
  for (let i = 0; i < MAX_PERSISTED_JOBS + 5; i++) {
    await addPendingJob({ commentId: `c${i}`, text: `t${i}`, enqueuedAt: base + i });
  }
  const stored = readStore()[PENDING_JOBS_STORAGE_KEY];
  if (stored.length > MAX_PERSISTED_JOBS) return `Store grew past the cap: ${stored.length}`;
  // The newest entries are the ones worth keeping.
  if (stored[stored.length - 1].commentId !== `c${MAX_PERSISTED_JOBS + 4}`) {
    return 'The cap should drop the OLDEST entries';
  }
  return true;
}

async function testClearRemovesEverything() {
  resetStorage();
  await addPendingJob(job('c1'));
  if (await clearPendingJobs() !== true) return 'clear should report success';
  if ((await countPendingJobs()) !== 0) return 'The store should be empty after clear';
  return true;
}

async function testKeyIsNotASetting() {
  resetStorage();
  await addPendingJob(job('c1'));
  const { DEFAULT_CONFIG } = await import('../config.js');
  if (PENDING_JOBS_STORAGE_KEY in DEFAULT_CONFIG) return 'pendingJobs must not be part of DEFAULT_CONFIG';
  return true;
}

async function runAllTests() {
  console.log('\n=== Pending Job Persistence Tests (Phase 19.3) ===\n');

  await runTest('Persists the fields recovery needs', testPersistsTheFieldsRecoveryNeeds);
  await runTest('The message responder is never persisted', testResponderIsNeverPersisted);
  await runTest('Unusable input is rejected', testRejectsUnusableInput);
  await runTest('A missing fingerprint becomes an empty string', testFingerprintDefaultsToEmptyString);
  await runTest('The same comment does not duplicate', testSameCommentDoesNotDuplicate);
  await runTest('Removal is by comment id', testRemovalIsByCommentId);
  await runTest('Removing an unknown id changes nothing', testRemovalOfUnknownIdChangesNothing);
  await runTest('Fresh jobs return oldest first', testFreshJobsComeBackOldestFirst);
  await runTest('Stale jobs are not recovered', testStaleJobsAreNotRecovered);
  await runTest('A job exactly at the age limit survives', testJobExactlyAtTheAgeLimitSurvives);
  await runTest('Malformed stored entries are skipped', testMalformedStoredEntriesAreSkipped);
  await runTest('A missing store reads as empty', testMissingStoreIsAnEmptyList);
  await runTest('The store is capped', testStoreIsCapped);
  await runTest('Clear removes everything', testClearRemovesEverything);
  await runTest('pendingJobs is not a settings key', testKeyIsNotASetting);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;