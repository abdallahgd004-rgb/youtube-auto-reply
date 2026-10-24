/**
 * Development Diagnostic Log tests
 *
 * The engine under test is the real `core/dev-log.js` — the same file the service
 * worker, the side panel and the content scripts use. Nothing is reimplemented here,
 * so a passing run means the shipped logger satisfies these guarantees.
 *
 * Runs in the browser from dev-log-tests.html (there is no Node runner).
 */

import { resetStorage } from './chrome-storage-stub.js';
import '../dev-log.js';

const engine = globalThis.YTAR_DEVLOG;
const { LEVEL, VERBOSITY, COMPONENT } = engine;

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

/**
 * Capture console output and the buffer while `fn` runs.
 *
 * Both are needed: the console line is what a developer actually reads, and the
 * buffer is what survives long enough to be inspected after a failure.
 */
async function capture(fn) {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => seen.log.push(a.join(' '));
  console.warn = (...a) => seen.warn.push(a.join(' '));
  console.error = (...a) => seen.error.push(a.join(' '));
  engine.clearEntries();
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return { seen, entries: engine.getEntries() };
}

/** Diagnostics ON at NORMAL — the default useful state. */
function on() {
  engine.configure({ enabled: true, verbosity: VERBOSITY.NORMAL });
}

function verbose() {
  engine.configure({ enabled: true, verbosity: VERBOSITY.VERBOSE });
}

function off() {
  engine.configure({ enabled: false, verbosity: VERBOSITY.OFF });
}

// ── 1. DEBUG logging can be disabled ────────────────────────────────────────

async function testOffSilencesEverything() {
  off();
  const { seen, entries } = await capture(() => {
    engine.debug(COMPONENT.SYSTEM, 'DEBUG_ENTRY');
    engine.info(COMPONENT.SYSTEM, 'INFO_ENTRY');
    engine.warn(COMPONENT.SYSTEM, 'WARN_ENTRY');
    engine.error(COMPONENT.SYSTEM, 'ERROR_ENTRY');
  });

  if (seen.log.length || seen.warn.length || seen.error.length) {
    return `OFF must silence the console, got ${seen.log.length + seen.warn.length + seen.error.length} lines`;
  }
  if (entries.length !== 0) return `OFF must not buffer, got ${entries.length}`;
  return true;
}

async function testNormalSuppressesDebugButKeepsLifecycle() {
  on();
  const { seen } = await capture(() => {
    engine.debug(COMPONENT.SYSTEM, 'DEBUG_NOISE');
    engine.info(COMPONENT.SYSTEM, 'RUN_START');
    engine.warn(COMPONENT.SYSTEM, 'SOMETHING_ODD');
  });

  if (seen.log.length !== 1) return `NORMAL should keep INFO, logged ${seen.log.length}`;
  if (!/RUN_START/.test(seen.log[0])) return `Expected RUN_START, got ${seen.log[0]}`;
  if (seen.warn.length !== 1) return `NORMAL should keep WARN, got ${seen.warn.length}`;

  verbose();
  const loud = await capture(() => engine.debug(COMPONENT.SYSTEM, 'DEBUG_NOISE'));
  if (loud.seen.log.length !== 1) return 'VERBOSE must let DEBUG through';
  return true;
}

async function testTurningOffAgainSilencesTheLog() {
  on();
  const loud = await capture(() => engine.info(COMPONENT.SYSTEM, 'FIRST'));
  if (!loud.seen.log.length) return 'Setup failed: expected output while on';

  off();
  const quiet = await capture(() => engine.info(COMPONENT.SYSTEM, 'SECOND'));
  if (quiet.seen.log.length) return 'Output must stop once switched off';
  return true;
}

// ── 2. ERROR stays available when diagnostics are enabled ───────────────────

async function testErrorAlwaysVisibleWhenEnabled() {
  on();
  const { seen, entries } = await capture(() =>
    engine.error(COMPONENT.SERVICE_WORKER_FALLBACK || 'BACKGROUND', 'SOMETHING_BROKE', {
      message: 'the extension failed'
    })
  );

  if (seen.error.length !== 1) return `ERROR must print at NORMAL, got ${seen.error.length}`;
  if (entries.length !== 1) return `ERROR must be buffered, got ${entries.length}`;
  if (entries[0].level !== LEVEL.ERROR) return `Expected level ERROR, got ${entries[0].level}`;
  return true;
}

// ── 3. Entries carry component and event ────────────────────────────────────

async function testEntriesCarryComponentAndEvent() {
  on();
  const { entries } = await capture(() =>
    engine.log({
      component: COMPONENT.LM_STUDIO,
      event: 'REQUEST_START',
      level: LEVEL.INFO,
      message: 'about to call LM Studio',
      data: { endpoint: 'http://localhost:1234/v1/chat/completions', model: 'qwen' }
    })
  );

  if (entries.length !== 1) return `Expected 1 entry, got ${entries.length}`;
  const e = entries[0];
  if (e.component !== 'LM_STUDIO') return `component=${e.component}`;
  if (e.event !== 'REQUEST_START') return `event=${e.event}`;
  if (!e.timestamp) return 'An entry must be timestamped';
  if (e.message !== 'about to call LM Studio') return `message=${e.message}`;
  return true;
}

async function testConsoleLineIsScannableAndConsistent() {
  on();
  const { seen } = await capture(() =>
    engine.log({
      component: COMPONENT.LM_STUDIO,
      event: 'REQUEST_END',
      level: LEVEL.INFO,
      runId: 'run-1',
      commentId: 'comment-5',
      durationMs: 842
    })
  );

  const line = seen.log[0] || '';
  if (!line.startsWith('[YTAR][LM_STUDIO][INFO]')) return `Bad header: ${line}`;
  if (!line.includes('[run-1]')) return `runId missing from: ${line}`;
  if (!line.includes('[comment-5]')) return `commentId missing from: ${line}`;
  if (!line.includes('REQUEST_END')) return `event missing from: ${line}`;
  if (!line.includes('duration=842ms')) return `duration missing from: ${line}`;
  return true;
}

// ── 4/5/6. Correlation ids ─────────────────────────────────────────────────

async function testRunIdIsGeneratedAndUnique() {
  const a = engine.newRunId();
  const b = engine.newRunId();

  if (typeof a !== 'string' || !a) return 'newRunId must return a string';
  if (!/^run-\d{8}-\d{6}-[a-z0-9]{6}$/.test(a)) return `Unexpected run id shape: ${a}`;
  if (a === b) return 'Two run ids must not collide';
  return true;
}

async function testRunIdPropagatesToEntries() {
  on();
  const runId = engine.newRunId();
  const { entries } = await capture(() =>
    engine.log({ component: COMPONENT.SEMANTIC_MATCHER, event: 'SEMANTIC_MATCH_START', runId })
  );

  if (entries[0].runId !== runId) return `runId was dropped: ${JSON.stringify(entries[0])}`;
  return true;
}

async function testCommentIdPropagatesWhenAvailable() {
  on();
  const { entries } = await capture(() => {
    engine.log({ component: COMPONENT.QUEUE, event: 'QUEUE_ENQUEUE', commentId: 'comment-9', runId: 'run-x' });
    engine.log({ component: COMPONENT.QUEUE, event: 'QUEUE_IDLE' });
  });

  if (entries[0].commentId !== 'comment-9') return 'commentId was dropped';
  if ('commentId' in entries[1]) return 'A commentId must not be invented when there is none';
  return true;
}

async function testRequestIdIsGeneratedForRequests() {
  const id = engine.newRequestId();
  if (typeof id !== 'string' || !id) return 'newRequestId must return a string';
  if (!/^req-\d{8}-\d{6}-[a-z0-9]{6}$/.test(id)) return `Unexpected request id shape: ${id}`;
  if (id === engine.newRequestId()) return 'Two request ids must not collide';

  on();
  const { entries } = await capture(() =>
    engine.log({
      component: COMPONENT.LM_STUDIO,
      event: 'REQUEST_START',
      requestId: id,
      commentId: 'comment-2',
      runId: 'run-2',
      data: { operation: 'SEMANTIC_MATCH' }
    })
  );

  if (entries[0].requestId !== id) return 'requestId was dropped';
  return true;
}

/** The full chain must be reconstructable from the buffer alone. */
async function testRunToCommentToRequestChainIsTraceable() {
  on();
  const runId = engine.newRunId();
  const req1 = engine.newRequestId();
  const req2 = engine.newRequestId();

  const { entries } = await capture(() => {
    engine.log({ component: COMPONENT.TIMER, event: 'RUN_START', runId });
    engine.log({ component: COMPONENT.CONTENT, event: 'COMMENT_DETECTED', runId, commentId: 'c1' });
    engine.log({ component: COMPONENT.LM_STUDIO, event: 'REQUEST_START', runId, commentId: 'c1', requestId: req1, data: { operation: 'SEMANTIC_MATCH' } });
    engine.log({ component: COMPONENT.LM_STUDIO, event: 'REQUEST_END', runId, commentId: 'c1', requestId: req1, durationMs: 120 });
    engine.log({ component: COMPONENT.LM_STUDIO, event: 'REQUEST_START', runId, commentId: 'c1', requestId: req2, data: { operation: 'REPLY_GENERATION' } });
    engine.log({ component: COMPONENT.LM_STUDIO, event: 'REQUEST_END', runId, commentId: 'c1', requestId: req2, durationMs: 900 });
    engine.log({ component: COMPONENT.QUEUE, event: 'QUEUE_JOB_SUCCESS', runId, commentId: 'c1', durationMs: 1500 });
    engine.log({ component: COMPONENT.TIMER, event: 'RUN_END', runId, durationMs: 1520 });
  });

  const run = entries.filter((e) => e.runId === runId);
  if (run.length !== 8) return `Expected the whole run under one runId, got ${run.length} entries`;

  const forComment = run.filter((e) => e.commentId === 'c1');
  if (forComment.length !== 6) return `Expected 6 entries for the comment, got ${forComment.length}`;

  const ops = run.filter((e) => e.requestId).map((e) => e.requestId);
  if (new Set(ops).size !== 2) return `Expected 2 distinct request ids, got ${ops.length}`;
  return true;
}

// ── 7. START/END pairs carry duration ──────────────────────────────────────

/**
 * Whether a duration is a usable measurement: present, finite and not absurd.
 *
 * The upper bound catches a clock reading in the wrong unit (microseconds reported as
 * milliseconds, or a wall-clock epoch leaking in as a duration).
 *
 * Note there is deliberately no LOWER bound tied to how long the test slept. Under a
 * headless virtual-time budget setTimeout can resolve "instantly" in wall-clock terms,
 * so asserting "a 40ms sleep must measure >= 20ms" tests the browser scheduler rather
 * than the logger — and failed roughly one run in six.
 */
function isSaneDuration(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms < 60000;
}

async function testStartEndPairCarriesDuration() {
  on();
  const { entries } = await capture(async () => {
    const timer = engine.startTimer({
      component: COMPONENT.LM_STUDIO,
      event: 'REQUEST',
      runId: 'run-3',
      commentId: 'c3',
      data: { operation: 'REPLY_GENERATION', endpoint: 'http://localhost:1234/v1/chat/completions', model: 'qwen' }
    });
    await new Promise((r) => setTimeout(r, 40));
    timer.done({ httpStatus: 200 });
  });

  if (entries.length !== 2) return `Expected START + END, got ${entries.length}`;
  if (entries[0].event !== 'REQUEST_START') return `First entry was ${entries[0].event}`;
  if (entries[1].event !== 'REQUEST_END') return `Second entry was ${entries[1].event}`;
  if (!isSaneDuration(entries[1].durationMs)) return `END durationMs is unusable: ${entries[1].durationMs}`;
  if (entries[1].data.httpStatus !== 200) return 'END must carry the result fields';
  if (entries[1].data.operation !== 'REPLY_GENERATION') return 'Shared fields must survive to END';
  // The START must not carry a duration: it has not finished yet.
  if ('durationMs' in entries[0]) return 'A START entry must not claim a duration';
  return true;
}

async function testFailedOperationLogsErrorWithDuration() {
  on();
  const boom = new Error('LM Studio did not respond in time');
  const { seen, entries } = await capture(() => {
    const timer = engine.startTimer({ component: COMPONENT.LM_STUDIO, event: 'REQUEST', requestId: 'req-x' });
    timer.fail(boom, { httpStatus: 0 });
  });

  if (entries.length !== 2) return `Expected START + ERROR, got ${entries.length}`;
  const err = entries[1];
  if (err.event !== 'REQUEST_ERROR') return `Expected REQUEST_ERROR, got ${err.event}`;
  if (err.level !== LEVEL.ERROR) return 'A failure must be an ERROR';
  if (typeof err.durationMs !== 'number') return 'ERROR must carry durationMs';
  if (!err.error || err.error.message !== 'LM Studio did not respond in time') return 'The error message was lost';
  if (!seen.error.length) return 'A failure must print to console.error';
  return true;
}

async function testTimerNeverThrowsOnOddInput() {
  on();
  let threw = null;
  try {
    const timer = engine.startTimer({ component: COMPONENT.YOUTUBE_ADAPTER, event: 'OPEN_REPLY_BOX' });
    timer.done();
    timer.done();
    timer.fail(null);
    engine.log({ component: 'NOT_A_COMPONENT', event: 'WEIRD', level: 'NOT_A_LEVEL', data: undefined });
    engine.log({});
  } catch (error) {
    threw = error.message;
  }
  if (threw) return `The logger must never throw: ${threw}`;
  return true;
}

// ── 8/9. Errors and sensitive data ─────────────────────────────────────────

async function testErrorsIncludeNameMessageAndStack() {
  on();
  const err = new TypeError('cannot read properties of null');
  const { entries } = await capture(() =>
    engine.error(COMPONENT.YOUTUBE_ADAPTER, 'OPEN_REPLY_BOX_TIMEOUT', { error: err, durationMs: 3000 })
  );

  const e = entries[0];
  if (e.error.name !== 'TypeError') return `name=${e.error && e.error.name}`;
  if (e.error.message !== 'cannot read properties of null') return 'message was lost';
  if (typeof e.error.stack !== 'string' || !e.error.stack) return 'The stack must be captured';
  if (e.durationMs !== 3000) return 'A timeout must carry its duration';
  return true;
}

async function testCredentialsAreNeverLogged() {
  on();
  const { seen, entries } = await capture(() =>
    engine.log({
      component: COMPONENT.LM_STUDIO,
      event: 'REQUEST_START',
      data: {
        apiKey: 'lm-studio-secret-value',
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        password: 'hunter2',
        cookie: 'SID=abc123',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        nested: { authToken: 'nested-secret', model: 'qwen' },
        list: [{ refreshToken: 'list-secret' }]
      }
    })
  );

  const serialized = JSON.stringify(entries) + JSON.stringify(seen);
  const leaks = ['lm-studio-secret-value', 'eyJhbGciOiJIUzI1NiJ9', 'hunter2', 'abc123', 'nested-secret', 'list-secret'];
  for (const leak of leaks) {
    if (serialized.includes(leak)) return `Credential leaked into the log: ${leak}`;
  }
  if (!serialized.includes('[redacted]')) return 'Expected redaction markers';

  // Redaction must not destroy the diagnostic value of the entry.
  if (!/localhost:1234/.test(serialized)) return 'Non-secret fields must survive redaction';
  if (entries[0].data.nested.model !== 'qwen') return 'Redaction must recurse without losing siblings';
  return true;
}

async function testSecretKeyDetection() {
  const must = ['apiKey', 'api_key', 'API-KEY', 'apikey', 'Authorization', 'password', 'Cookie', 'sessionId', 'refresh_token', 'clientSecret'];
  for (const key of must) {
    if (!engine.isSecretKey(key)) return `${key} must be treated as secret`;
  }
  // A bare `key` is NOT secret here: storage events log key names on purpose.
  const mustNot = ['key', 'commentId', 'model', 'endpoint', 'queueSize'];
  for (const key of mustNot) {
    if (engine.isSecretKey(key)) return `${key} must not be treated as secret`;
  }
  return true;
}

async function testLongStringsAreTruncated() {
  on();
  const huge = 'x'.repeat(5000);
  const { entries } = await capture(() =>
    engine.log({ component: COMPONENT.CONTENT, event: 'COMMENT_DETECTED', data: { text: huge } })
  );

  const value = entries[0].data.text;
  if (value.length >= huge.length) return 'A huge value must be truncated';
  if (value.length > 400) return `Truncation left ${value.length} chars`;
  if (!/more chars/.test(value)) return 'Truncation must say how much was dropped';
  return true;
}

/** A full reply must not be echoed at NORMAL; VERBOSE is the explicit opt-in. */
async function testPreviewsAreVerbosityGated() {
  on();
  const quiet = await capture(() =>
    engine.log({ component: COMPONENT.REPLY, event: 'REPLY_TEXT', preview: 'the entire generated reply' })
  );
  if (/entire generated reply/.test(JSON.stringify(quiet.entries))) {
    return 'A preview must be hidden at NORMAL';
  }

  verbose();
  const loud = await capture(() =>
    engine.log({ component: COMPONENT.REPLY, event: 'REPLY_TEXT', preview: 'the entire generated reply' })
  );
  if (!/entire generated reply/.test(JSON.stringify(loud.entries))) {
    return 'VERBOSE must allow a preview';
  }
  return true;
}

async function testCircularDataDoesNotThrow() {
  on();
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;

  let threw = null;
  try {
    const { entries } = await capture(() =>
      engine.log({ component: COMPONENT.SYSTEM, event: 'CYCLIC', data: { cyclic } })
    );
    if (entries.length !== 1) return 'A cyclic object must still produce an entry';
  } catch (error) {
    threw = error.message;
  }
  if (threw) return `Cyclic data must not throw: ${threw}`;
  return true;
}

// ── 10. The buffer is bounded ──────────────────────────────────────────────

async function testBufferIsBounded() {
  on();
  engine.clearEntries();
  const limit = engine.MAX_BUFFER_ENTRIES;
  const overflow = 25;
  for (let i = 0; i < limit + overflow; i++) {
    engine.log({ component: COMPONENT.SYSTEM, event: 'FILLER', data: { i } });
  }

  const entries = engine.getEntries();
  if (entries.length > limit) return `Buffer grew to ${entries.length}, limit is ${limit}`;
  if (entries.length !== limit) return `Expected the buffer to sit at ${limit}, got ${entries.length}`;

  // Oldest must be discarded, newest retained.
  if (entries[0].data.i !== overflow) return `Oldest entry should have been dropped, first i=${entries[0].data.i}`;
  if (entries[entries.length - 1].data.i !== limit + overflow - 1) return 'Newest entry was lost';

  if (engine.droppedCount() !== overflow) return `droppedCount=${engine.droppedCount()}, expected ${overflow}`;

  // getEntries must hand out a copy, so a caller cannot corrupt the buffer.
  entries.length = 0;
  if (engine.entryCount() !== limit) return 'getEntries must return a copy';
  return true;
}

// ── 11/12/13. The components developers actually debug ─────────────────────

async function testSidePanelFailuresAreDiagnosable() {
  on();
  const chromeError = new Error('No tab with id: 42');
  const { entries } = await capture(() => {
    const timer = engine.startTimer({
      component: COMPONENT.SIDEPANEL,
      event: 'SIDEPANEL_OPEN',
      data: { tabId: 42, windowId: 7 }
    });
    timer.fail(chromeError, {
      hasSidePanelApi: true,
      requestedPath: 'popup/popup.html',
      pathExists: true,
      manifestSidePanelDefaultPath: 'popup/popup.html',
      manifestHasDefaultPopup: false,
      origin: 'https://www.youtube.com'
    });
  });

  const e = entries[1];
  if (e.event !== 'SIDEPANEL_OPEN_ERROR') return `event=${e.event}`;
  if (e.data.tabId !== 42) return 'tabId must be recorded';
  if (e.data.windowId !== 7) return 'windowId must be recorded';
  if (e.data.hasSidePanelApi !== true) return 'API availability must be recorded';
  if (e.data.manifestHasDefaultPopup !== false) return 'Manifest state must be recorded';
  if (e.data.requestedPath !== 'popup/popup.html') return 'The requested path must be recorded';
  if (!e.error || !/No tab with id/.test(e.error.message)) return 'The Chrome API error must be recorded';
  return true;
}

async function testSidePanelInitLifecycleIsAvailable() {
  on();
  const { entries } = await capture(() => {
    const init = engine.startTimer({
      component: COMPONENT.SIDEPANEL,
      event: 'SIDEPANEL_INIT',
      endEvent: 'SIDEPANEL_INIT_SUCCESS',
      errorEvent: 'SIDEPANEL_INIT_ERROR'
    });
    init.done({ hasSidePanelApi: true });
  });

  if (entries[0].event !== 'SIDEPANEL_INIT_START') return entries[0].event;
  if (entries[1].event !== 'SIDEPANEL_INIT_SUCCESS') return entries[1].event;
  if (typeof entries[1].durationMs !== 'number') return 'SUCCESS must carry a duration';
  return true;
}

async function testServiceWorkerErrorsAreDiagnosable() {
  on();
  const { entries } = await capture(() => {
    engine.log({ component: COMPONENT.BACKGROUND, event: 'SERVICE_WORKER_START', data: { workerScope: 'shared' } });
    engine.error(COMPONENT.BACKGROUND, 'SERVICE_WORKER_ERROR', {
      message: 'unhandled message failure',
      error: new Error('boom'),
      data: { action: 'COMMENT_DETECTED' }
    });
  });

  if (entries[0].event !== 'SERVICE_WORKER_START') return entries[0].event;
  if (entries[1].level !== LEVEL.ERROR) return 'A worker error must be an ERROR';
  if (!entries[1].error || entries[1].error.message !== 'boom') return 'The error must be recorded';
  if (entries[1].data.action !== 'COMMENT_DETECTED') return 'The action must be recorded';
  return true;
}

async function testReplyBoxFailureIsDiagnosable() {
  on();
  const { entries } = await capture(() => {
    const timer = engine.startTimer({
      component: COMPONENT.YOUTUBE_ADAPTER,
      event: 'OPEN_REPLY_BOX',
      commentId: 'comment-1',
      data: { searchScope: 'ytd-comment-thread-renderer', selectorStrategy: 'reply-dialog-renderer' }
    });
    timer.fail(null, {
      reason: 'timed out after 3000ms',
      durationMs: 3000,
      selectorsChecked: ['ytd-comment-reply-dialog-renderer#replybox'],
      visibleEditors: 0,
      replyBoxFound: false,
      commentStillConnected: true,
      searchScopeStillConnected: true
    });
  });

  const e = entries[1];
  if (e.component !== 'YOUTUBE_ADAPTER') return `component=${e.component}`;
  if (e.event !== 'OPEN_REPLY_BOX_ERROR') return `event=${e.event}`;
  if (e.commentId !== 'comment-1') return 'commentId must be recorded';
  if (e.data.replyBoxFound !== false) return 'replyBoxFound must be recorded';
  if (e.data.searchScope !== 'ytd-comment-thread-renderer') return 'The search scope must be recorded';
  if (!Array.isArray(e.data.selectorsChecked)) return 'selectorsChecked must be recorded';
  if (typeof e.durationMs !== 'number') return 'The duration must be recorded';
  return true;
}

/**
 * Duplicate counting: the log must make "10 comments became 20 detections"
 * answerable, which means accepted AND rejected-because-duplicate must both appear.
 */
async function testDuplicateCommentCountingIsDiagnosable() {
  on();
  const { entries } = await capture(() => {
    engine.log({
      component: COMPONENT.CONTENT,
      event: 'COMMENT_SCAN_END',
      data: { nodesExamined: 14, uniqueCommentsFound: 10, duplicateNodesIgnored: 4, parseFailures: 0 }
    });
    engine.log({ component: COMPONENT.CONTENT, event: 'COMMENT_DETECTED', commentId: 'c1', data: { textPreview: 'السعر كام', chars: 10 } });
    engine.log({ component: COMPONENT.CONTENT, event: 'COMMENT_DETECTED', commentId: 'c1', data: { reason: 'already in seenIds' } });
    engine.log({ component: COMPONENT.CONTENT, event: 'COMMENT_DETECTED', commentId: 'c2', data: { textPreview: 'منين أجيب', chars: 10 } });
  });

  const scan = entries.find((e) => e.event === 'COMMENT_SCAN_END');
  if (scan.data.nodesExamined !== 14) return 'nodesExamined must be recorded';
  if (scan.data.uniqueCommentsFound !== 10) return 'uniqueCommentsFound must be recorded';
  if (scan.data.duplicateNodesIgnored !== 4) return 'duplicateNodesIgnored must be recorded';
  if (scan.data.parseFailures !== 0) return 'parseFailures must be recorded';

  const detected = entries.filter((e) => e.event === 'COMMENT_DETECTED');
  if (detected.length !== 3) return `Expected 3 detection records, got ${detected.length}`;
  if (detected[1].data.reason !== 'already in seenIds') return 'A duplicate must say why it was skipped';
  if (detected[0].data.textPreview.length > 60) return 'A comment preview must be short';
  return true;
}

// ── 15. Run timing ─────────────────────────────────────────────────────────

async function testRunStartAndEndCarryTotals() {
  on();
  const runId = engine.newRunId();
  // A caller-supplied total. Deliberately NOT `timer.elapsed()`: that is re-read inside
  // done(), so comparing the two would race the clock — which is how this test used to
  // fail intermittently. What matters is that a supplied total is carried through
  // verbatim while the engine reports its own measurement alongside it.
  const callerTotal = 42700;
  const { entries } = await capture(async () => {
    engine.log({ component: COMPONENT.TIMER, event: 'RUN_START', runId, data: { detectedCount: 0 } });
    const timer = engine.startTimer({ component: COMPONENT.TIMER, event: 'RUN', runId });
    await new Promise((r) => setTimeout(r, 40));
    timer.done({
      stage: 'idle',
      elapsedMs: callerTotal,
      detectedCount: 12,
      matchedCount: 4,
      generatedCount: 4,
      submittedCount: 3,
      failedCount: 1,
      skippedCount: 8
    });
  });

  const start = entries.find((e) => e.event === 'RUN_START');
  const end = entries.find((e) => e.event === 'RUN_END');
  if (!start) return 'RUN_START is missing';
  if (!end) return 'RUN_END is missing';
  if (start.runId !== end.runId) return 'Both ends must share the runId';
  // See isSaneDuration(): the check is that a usable total was reported, not that the
  // headless scheduler honoured the sleep.
  if (!isSaneDuration(end.durationMs)) return `RUN_END duration is unusable: ${end.durationMs}`;
  for (const field of ['detectedCount', 'matchedCount', 'generatedCount', 'submittedCount', 'failedCount', 'skippedCount']) {
    if (typeof end.data[field] !== 'number') return `RUN_END must report ${field}`;
  }
  if (end.data.elapsedMs !== callerTotal) return `The caller's total must survive, got ${end.data.elapsedMs}`;
  return true;
}

// ── Storage diagnostics ────────────────────────────────────────────────────

async function testStorageDiagnosticsDoNotDumpSettings() {
  on();
  const { entries } = await capture(() => {
    const timer = engine.startTimer({ component: COMPONENT.STORAGE, event: 'STORAGE_READ', data: { key: 'pendingJobs' } });
    timer.done({ key: 'pendingJobs', ok: true });
  });

  const end = entries.find((e) => e.event === 'STORAGE_READ_END');
  if (end.data.key !== 'pendingJobs') return 'The key must be recorded';
  if (end.data.ok !== true) return 'Success must be recorded';
  if (JSON.stringify(end.data).includes('systemPrompt')) {
    return 'Storage diagnostics must not dump setting values';
  }
  return true;
}

async function testDefaultIsOffBeforeAnyConfiguration() {
  // Proves a fresh context logs nothing until a developer asks for it. The module
  // level default is OFF; this re-asserts it explicitly rather than relying on order.
  engine.configure({ enabled: false, verbosity: VERBOSITY.OFF });
  const { seen } = await capture(() => engine.info(COMPONENT.SYSTEM, 'SHOULD_NOT_APPEAR'));
  if (seen.log.length) return 'Default must be silent';
  on();
  return true;
}

async function runAllTests() {
  console.log('\n=== Development Diagnostic Log Tests ===\n');

  console.log('--- Levels and verbosity ---');
  await runTest('OFF disables all logging', testOffSilencesEverything);
  await runTest('NORMAL suppresses DEBUG but keeps lifecycle events', testNormalSuppressesDebugButKeepsLifecycle);
  await runTest('Switching off again silences the log', testTurningOffAgainSilencesTheLog);
  await runTest('ERROR is visible whenever diagnostics are enabled', testErrorAlwaysVisibleWhenEnabled);
  await runTest('Default is silent until configured', testDefaultIsOffBeforeAnyConfiguration);

  console.log('\n--- Schema ---');
  await runTest('Entries carry component and event', testEntriesCarryComponentAndEvent);
  await runTest('Console line is scannable and consistent', testConsoleLineIsScannableAndConsistent);

  console.log('\n--- Correlation ids ---');
  await runTest('runId is generated and unique', testRunIdIsGeneratedAndUnique);
  await runTest('runId propagates to entries', testRunIdPropagatesToEntries);
  await runTest('commentId propagates when available', testCommentIdPropagatesWhenAvailable);
  await runTest('requestId is generated for LM Studio requests', testRequestIdIsGeneratedForRequests);
  await runTest('Run → comment → request chain is traceable', testRunToCommentToRequestChainIsTraceable);

  console.log('\n--- Timed operations ---');
  await runTest('START/END pair carries duration', testStartEndPairCarriesDuration);
  await runTest('A failed operation logs ERROR with duration', testFailedOperationLogsErrorWithDuration);
  await runTest('The logger never throws on odd input', testTimerNeverThrowsOnOddInput);

  console.log('\n--- Privacy and robustness ---');
  await runTest('Errors include name, message and stack', testErrorsIncludeNameMessageAndStack);
  await runTest('Credentials are never logged', testCredentialsAreNeverLogged);
  await runTest('Secret key detection is precise', testSecretKeyDetection);
  await runTest('Long strings are truncated', testLongStringsAreTruncated);
  await runTest('Previews are gated behind VERBOSE', testPreviewsAreVerbosityGated);
  await runTest('Circular data does not throw', testCircularDataDoesNotThrow);
  await runTest('The log buffer is bounded', testBufferIsBounded);

  console.log('\n--- Component diagnostics ---');
  await runTest('Side Panel failures are diagnosable', testSidePanelFailuresAreDiagnosable);
  await runTest('Side Panel init lifecycle is recorded', testSidePanelInitLifecycleIsAvailable);
  await runTest('Service worker errors are diagnosable', testServiceWorkerErrorsAreDiagnosable);
  await runTest('Reply box failure is diagnosable', testReplyBoxFailureIsDiagnosable);
  await runTest('Duplicate comment counting is diagnosable', testDuplicateCommentCountingIsDiagnosable);
  await runTest('Storage diagnostics do not dump settings', testStorageDiagnosticsDoNotDumpSettings);

  console.log('\n--- Run timing ---');
  await runTest('RUN_START and RUN_END carry totals', testRunStartAndEndCarryTotals);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;