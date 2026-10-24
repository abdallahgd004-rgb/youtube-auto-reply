/**
 * Queue, Pause Control & Rate Limit Tests (Phase 20.22)
 *
 * §20.22 asks for "Queue tests" as a category. When 20.22 ran, three shipped modules had
 * NO test importing them at all:
 *
 *   - `queue.js`               the FIFO the worker drains
 *   - `queue-control.js`       the pause flag that gates the whole loop
 *   - `reply-rate-limiter.js`  the rolling hourly cap
 *
 * Those three are the safety envelope. Everything else in this codebase decides WHETHER a
 * reply is generated; these decide whether it is posted once, in order, at most N times an
 * hour, and not while the user has paused it.
 *
 * WHY THE GAP SURVIVED SO LONG. `sw-processing-harness.js` re-implements the worker's
 * processing flow rather than importing the queue, so a suite that drives "the harness"
 * never touches `createQueue()` at all — AGENTS.md records that the harness MIRRORS the
 * worker, and this is the sharpest instance of it: the mirror omitted the very modules
 * under test. `queue-persistence-tests.html` covers the restart-recovery layer next to the
 * queue, which is adjacent but not the queue.
 *
 * The ordering guarantees in `createQueue()` are still asserted here because the worker
 * relies on them absolutely — FIFO order is what makes the inter-comment delay, the hourly
 * cap and the reply-box sequence predictable.
 *
 * Runs in the browser from queue-rate-limit-tests.html (there is no Node runner).
 */

import { createQueue } from '../queue.js';
import { isQueuePaused, setQueuePaused, toggleQueuePaused } from '../queue-control.js';
import {
  countRecentReplies,
  isLimitReached,
  recordReply,
  DEFAULT_WINDOW_MS
} from '../reply-rate-limiter.js';

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

/** A minimal in-memory `chrome.storage.local` with a controllable failure switch. */
function installStore(initial) {
  const data = Object.assign({}, initial || {});
  const calls = { get: 0, set: 0 };
  let failGet = false;
  let failSet = false;

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          calls.get++;
          if (failGet) throw new Error('read failed');
          const wanted = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(data));
          const out = {};
          for (const key of wanted) if (key in data) out[key] = data[key];
          return out;
        },
        set: async (patch) => {
          calls.set++;
          if (failSet) throw new Error('write failed');
          for (const [k, v] of Object.entries(patch || {})) data[k] = v;
        }
      }
    }
  };

  return {
    data,
    calls,
    failGet: (on) => { failGet = on; },
    failSet: (on) => { failSet = on; },
    uninstall: () => { delete globalThis.chrome; }
  };
}

// ─── The FIFO ───────────────────────────────────────────────────────────────────

async function testQueueIsFifo() {
  const queue = createQueue();
  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');

  // Order is the whole point: the inter-comment delay and the reply-box sequence are both
  // built on the assumption that the comment detected first is answered first.
  if (queue.dequeue() !== 'first') return 'the first item out was not the first in';
  if (queue.dequeue() !== 'second') return 'the second item out was not the second in';
  if (queue.dequeue() !== 'third') return 'the third item out was not the third in';
  return true;
}

async function testDequeueOnAnEmptyQueueIsUndefined() {
  const queue = createQueue();
  // `undefined` rather than a sentinel or a throw: a sentinel like "__EMPTY__" collides
  // with real data, and throwing would force every caller into a try/catch.
  if (queue.dequeue() !== undefined) return `dequeue returned ${JSON.stringify(queue.dequeue())}`;
  return true;
}

async function testPeekDoesNotMutate() {
  const queue = createQueue();
  queue.enqueue('a');
  queue.enqueue('b');

  if (queue.peek() !== 'a') return `peek=${queue.peek()}`;
  if (queue.size() !== 2) return `peek consumed an item: size=${queue.size()}`;
  return true;
}

async function testPeekAndDequeueOnAnEmptyQueueAreUndefined() {
  const queue = createQueue();
  if (queue.peek() !== undefined) return `peek on empty returned ${queue.peek()}`;
  if (queue.size() !== 0) return `size=${queue.size()}`;
  if (queue.isEmpty() !== true) return 'isEmpty must be true';
  return true;
}

async function testQueueAcceptsFalsyItems() {
  const queue = createQueue();
  // The job objects are always objects today, but the structure documents that any value
  // is legal — and a queue that silently dropped `null` would be a lurking trap.
  for (const value of [null, 0, '', false, NaN]) queue.enqueue(value);
  if (queue.size() !== 5) return `size=${queue.size()}, expected 5`;
  if (queue.dequeue() !== null) return 'a null item did not survive';
  if (queue.size() !== 4) return `size=${queue.size} after dequeue`;
  return true;
}

async function testClearEmptiesTheQueue() {
  const queue = createQueue();
  queue.enqueue('a');
  queue.enqueue('b');
  queue.clear();
  if (queue.size() !== 0) return `size=${queue.size} after clear`;
  if (queue.isEmpty() !== true) return 'isEmpty must be true after clear';
  if (queue.dequeue() !== undefined) return 'clear must discard, not hide';
  return true;
}

async function testTwoQueuesAreIndependent() {
  // `createQueue()` closing over its own array: a shared backing store would let one
  // extension context's queue drain another's.
  const a = createQueue();
  const b = createQueue();
  a.enqueue('only-in-a');

  if (b.size() !== 0) return `the second queue saw ${b.size()} item(s)`;
  if (a.size() !== 1) return `a.size=${a.size()}`;
  b.enqueue('only-in-b');
  if (a.size() !== 1) return `a grew to ${a.size()} when b was written to`;
  return true;
}

// ─── Pause control ──────────────────────────────────────────────────────────────

async function testPauseRoundTrips() {
  const store = installStore();
  try {
    if (await isQueuePaused() !== false) return 'a fresh install must not be paused';

    if (await setQueuePaused(true) !== true) return 'setQueuePaused(true) must report true';
    if (await isQueuePaused() !== true) return 'the pause did not persist';

    await setQueuePaused(false);
    if (await isQueuePaused() !== false) return 'the resume did not persist';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testPauseSurvivesAWorkerRestart() {
  const store = installStore({ queuePaused: true });
  try {
    // The flag lives in storage precisely because an MV3 worker is torn down when idle; an
    // in-memory flag would silently un-pause itself and start posting again unasked.
    if (await isQueuePaused() !== true) return 'a stored pause must be honoured by a new worker';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testOnlyStrictTruePauses() {
  const store = installStore();
  try {
    // Anything else writes `false`, so a malformed stored value can never leave the queue
    // stuck paused with no way for the user to recover.
    for (const value of ['true', 1, {}, [], 'yes', 0, null, undefined]) {
      await setQueuePaused(value);
      if (await isQueuePaused() !== false) return `setQueuePaused(${JSON.stringify(value)}) paused the queue`;
    }
    return true;
  } finally {
    store.uninstall();
  }
}

async function testToggleFlipsBothWays() {
  const store = installStore();
  try {
    if (await toggleQueuePaused() !== true) return 'the first toggle must pause';
    if (await isQueuePaused() !== true) return 'the toggle did not persist';
    if (await toggleQueuePaused() !== false) return 'the second toggle must resume';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testAnUnreadablePauseStoreResumesRatherThanFreezing() {
  const store = installStore();
  try {
    await setQueuePaused(true);
    store.failGet(true);
    // Deliberate direction: failing CLOSED here would mean an unreadable store freezes the
    // queue forever, and the Pause button reads the same key — the user would have no way
    // out. Failing open risks posting while paused, which is the lesser harm.
    if (await isQueuePaused() !== false) return 'an unreadable pause key must resolve to NOT paused';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testAFailedPauseWriteDoesNotThrow() {
  const store = installStore();
  try {
    store.failSet(true);
    if (await setQueuePaused(true) !== true) return 'the written value must still be reported';
    if (await isQueuePaused() !== false) return 'nothing should have been stored';
    return true;
  } finally {
    store.uninstall();
  }
}

// ─── The hourly cap ─────────────────────────────────────────────────────────────

async function testCountStartsAtZero() {
  const store = installStore();
  try {
    if (await countRecentReplies() !== 0) return 'a fresh install counted replies';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testRecordReplyIncrementsTheCount() {
  const store = installStore();
  try {
    await recordReply();
    if (await countRecentReplies() !== 1) return 'count after one reply was not 1';
    await recordReply();
    if (await countRecentReplies() !== 2) return 'count after two replies was not 2';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testExpiredEntriesFallOutOfTheWindow() {
  const store = installStore();
  try {
    const hour = 60 * 60 * 1000;
    // One just inside the window, one long outside it.
    store.data.recentReplyTimestamps = [Date.now() - hour - 1000, Date.now() - 1000];

    const count = await countRecentReplies();
    if (count !== 1) return `count=${count}, expected the expired entry to be dropped`;
    // And the pruning must PERSIST, or the stored array grows forever.
    if (store.data.recentReplyTimestamps.length !== 1) {
      return `the pruned entry was not written back: ${store.data.recentReplyTimestamps.length} stored`;
    }
    return true;
  } finally {
    store.uninstall();
  }
}

async function testTheBoundaryIsExclusive() {
  const store = installStore();
  try {
    // `t > cutoff`, not `>=`. A reply exactly on the boundary is outside the window; being
    // off by one here would either block a legitimate reply or exceed the configured cap.
    const now = Date.now();
    store.data.recentReplyTimestamps = [now];
    const count = await countRecentReplies(DEFAULT_WINDOW_MS - now + now);
    // Ask for a window that ends exactly now, so `now > now` is false.
    const tight = await countRecentReplies(0);
    if (tight !== 0) return `an entry exactly at the cutoff counted: ${tight}`;
    return true;
  } finally {
    store.uninstall();
  }
}

async function testLimitIsReachedAtTheCap() {
  const store = installStore();
  try {
    store.data.recentReplyTimestamps = [Date.now(), Date.now()];

    if (await isLimitReached(3) !== false) return 'two replies must not hit a cap of three';
    if (await isLimitReached(2) !== true) return 'two replies must hit a cap of two';
    // One over the cap must also be "reached": the job is held, not counted down.
    if (await isLimitReached(1) !== true) return 'a cap below the count must be reached';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testANonPositiveOrInvalidLimitMeansNoLimit() {
  const store = installStore();
  try {
    store.data.recentReplyTimestamps = [Date.now(), Date.now(), Date.now()];
    // "Unlimited" is expressed as 0, and a corrupted setting must never freeze the queue.
    for (const limit of [0, -1, NaN, Infinity, '10', null, undefined, {}]) {
      if (await isLimitReached(limit) !== false) {
        return `isLimitReached(${JSON.stringify(limit)}) capped the queue`;
      }
    }
    return true;
  } finally {
    store.uninstall();
  }
}

async function testRecordReplyDropsExpiredEntriesFirst() {
  const store = installStore();
  try {
    store.data.recentReplyTimestamps = [Date.now() - DEFAULT_WINDOW_MS - 5000];
    await recordReply();

    const stored = store.data.recentReplyTimestamps;
    if (stored.length !== 1) return `stored=${stored.length}, expected the expired entry to be replaced`;
    if (Date.now() - stored[0] > 5000) return 'the recorded timestamp is not recent';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testCorruptTimestampsAreIgnored() {
  const store = installStore();
  try {
    // A hand-edited or half-written store must not take the queue down, and a string in the
    // array must not count as a reply.
    store.data.recentReplyTimestamps = [Date.now(), 'yesterday', null, {}, NaN, undefined];
    const count = await countRecentReplies();
    if (count !== 1) return `count=${count}, expected only the one real timestamp`;
    return true;
  } finally {
    store.uninstall();
  }
}

async function testAnUnreadableRateStoreCountsZero() {
  const store = installStore();
  try {
    store.data.recentReplyTimestamps = [Date.now(), Date.now()];
    store.failGet(true);
    // The same deliberate direction as the pause flag: failing closed would silently stop
    // replying forever. Over-running the cap by a few replies beats never replying again.
    if (await countRecentReplies() !== 0) return 'an unreadable store must count zero';
    if (await isLimitReached(1) !== false) return 'an unreadable store must not cap the queue';
    return true;
  } finally {
    store.uninstall();
  }
}

async function testAFailedRateWriteDoesNotThrow() {
  const store = installStore();
  try {
    store.failSet(true);
    // Resolving is the point: this sits on the reply path, and a throw here would surface as
    // a failed generation for a reply that was perfectly fine.
    await recordReply();
    if (await countRecentReplies() !== 0) return 'nothing should have been written';
    return true;
  } finally {
    store.uninstall();
  }
}

export default async function runAllTests() {
  console.log('\n--- The FIFO ---');
  await runTest('The queue is FIFO', testQueueIsFifo);
  await runTest('Dequeue on an empty queue is undefined', testDequeueOnAnEmptyQueueIsUndefined);
  await runTest('Peek does not mutate', testPeekDoesNotMutate);
  await runTest('Peek and size on an empty queue', testPeekAndDequeueOnAnEmptyQueueAreUndefined);
  await runTest('Falsy items are queued', testQueueAcceptsFalsyItems);
  await runTest('Clear discards everything', testClearEmptiesTheQueue);
  await runTest('Two queues are independent', testTwoQueuesAreIndependent);

  console.log('\n--- Pause control ---');
  await runTest('Pause round-trips', testPauseRoundTrips);
  await runTest('A pause survives a worker restart', testPauseSurvivesAWorkerRestart);
  await runTest('Only a strict true pauses', testOnlyStrictTruePauses);
  await runTest('Toggle flips both ways', testToggleFlipsBothWays);
  await runTest('An unreadable pause key resumes', testAnUnreadablePauseStoreResumesRatherThanFreezing);
  await runTest('A failed pause write does not throw', testAFailedPauseWriteDoesNotThrow);

  console.log('\n--- The hourly cap ---');
  await runTest('The count starts at zero', testCountStartsAtZero);
  await runTest('Recording a reply increments the count', testRecordReplyIncrementsTheCount);
  await runTest('Expired entries fall out of the window', testExpiredEntriesFallOutOfTheWindow);
  await runTest('The window boundary is exclusive', testTheBoundaryIsExclusive);
  await runTest('The limit is reached at the cap', testLimitIsReachedAtTheCap);
  await runTest('An invalid limit means no limit', testANonPositiveOrInvalidLimitMeansNoLimit);
  await runTest('Recording drops expired entries first', testRecordReplyDropsExpiredEntriesFirst);
  await runTest('Corrupt timestamps are ignored', testCorruptTimestampsAreIgnored);
  await runTest('An unreadable rate store counts zero', testAnUnreadableRateStoreCountsZero);
  await runTest('A failed rate write does not throw', testAFailedRateWriteDoesNotThrow);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}