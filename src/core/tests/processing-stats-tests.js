/**
 * Processing Status Tests
 *
 * Two layers:
 *
 *  1. The pure state model (processing-stats.js) — counter arithmetic, stage
 *     validation, and the safe snapshot the Popup consumes.
 *  2. The wiring (sw-processing-harness.js) — that each real processing point in the
 *     background/content sequence lands on the right counter and the right stage:
 *     NO_MATCH, MATCH → generation, generation failure/timeout, dry run, a successful
 *     submission, and skips/duplicates.
 *
 * Runs in the browser from processing-stats-tests.html (there is no Node runner).
 */

import {
  STAGE,
  STAGE_LABELS,
  OUTCOME,
  getProcessingState,
  resetProcessingStats,
  recordCommentDetected,
  recordStage,
  recordMatched,
  recordGenerated,
  recordSubmitted,
  recordFailedOrSkipped,
  recordKnowledgeHit,
  recordKnowledgeAnswerable,
  recordKnowledgeSkip,
  recordKnowledgeSkipSample,
  MAX_KNOWLEDGE_SKIP_SAMPLES,
  SKIP_REASON_LABELS,
  handOffToContent,
  finishProcessing,
  hasActiveProcessing,
  hasHandoff
} from '../processing-stats.js';

import { KNOWLEDGE_ERROR } from '../knowledge-schema.js';

import {
  configure,
  deps,
  processJob,
  handleMessage,
  publishReply,
  resetPendingHandled,
  resetDiagEvents
} from './sw-processing-harness.js';

const results = { total: 0, passed: 0, failed: 0 };

async function runTest(name, fn) {
  results.total++;
  try {
    const outcome = await fn();
    if (outcome === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: ${outcome}`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

/** A trigger that matches everything, so only the surrounding flow is under test. */
function matchAllRule(overrides = {}) {
  return {
    id: 'rule-test',
    enabled: true,
    phrases: ['بكام'],
    matchMode: 'contains',
    caseSensitive: false,
    ...overrides
  };
}

/** Reset both the state model and the harness stubs. */
function fresh(overrides = {}) {
  resetProcessingStats();
  resetPendingHandled();
  resetDiagEvents();
  configure({
    enabled: true,
    dryRun: false,
    triggers: [],
    // Phase 19.8 — the handled store is a fingerprint-keyed Map (like the real
    // handled-comments.js), and in-flight handoffs are cleared between cases.
    handled: new Map(),
    hasGeneration: () => false,
    markHandledCalls: [],
    generate: async () => ({ text: 'السعر fifty جنيه' }),
    validate: { valid: true, reply: 'السعر fifty جنيه' },
    // Restored explicitly because `fresh()` must not inherit a previous test's
    // deliberate LM Studio failure.
    complete: matchFirstTrigger,
    ...overrides
  });
}

/**
 * Default stand-in for LM Studio: answers MATCH naming the first trigger it was asked
 * about. The triggers reach it as the real matcher built them, so the phrase returned
 * is one the rule-lookup in the harness can resolve.
 */
async function matchFirstTrigger(messages) {
  const user = messages.find((m) => m.role === 'user');
  const phrase = /^- (.+)$/m.exec(user ? user.content : '');
  return {
    text: JSON.stringify({ matched: true, trigger: phrase ? phrase[1] : '' }),
    reasoning: ''
  };
}

// ── Layer 1: the state model ────────────────────────────────────────────────

async function testFreshStateIsZeroAndIdle() {
  fresh();
  const s = getProcessingState();

  if (s.commentsDetected !== 0 || s.matched !== 0 || s.repliesGenerated !== 0 ||
      s.repliesSubmitted !== 0 || s.failedSkipped !== 0) {
    return `Expected all counters at 0, got ${JSON.stringify(s)}`;
  }
  if (s.stage !== STAGE.IDLE) return `Expected stage idle, got ${s.stage}`;
  if (s.stageLabel !== 'Idle') return `Expected label "Idle", got ${s.stageLabel}`;
  if (s.active !== false) return 'Expected active=false on a fresh state';
  return true;
}

async function testEveryStageHasALabel() {
  const expected = [
    'Reading comments', 'Checking for matches', 'Semantic matching',
    'Preparing reply', 'Waiting for LM Studio', 'Opening reply box',
    'Inserting reply', 'Submitting reply', 'Completed', 'Idle', 'Error'
  ];
  const labels = Object.values(STAGE).map((s) => STAGE_LABELS[s]);
  const missing = expected.filter((label) => !labels.includes(label));
  if (missing.length > 0) return `Missing labels: ${missing.join(', ')}`;
  return true;
}

async function testUnknownStageIsRejected() {
  fresh();
  recordStage(STAGE.CHECKING_MATCHES);
  if (recordStage('not-a-real-stage') !== false) return 'Expected recordStage to reject an unknown stage';
  if (recordStage(undefined) !== false) return 'Expected recordStage to reject undefined';
  const s = getProcessingState();
  if (s.stage !== STAGE.CHECKING_MATCHES) return `Stage changed to ${s.stage}`;
  return true;
}

async function testCountersAreIndependent() {
  fresh();
  recordCommentDetected();
  recordMatched();
  recordGenerated();
  const s = getProcessingState();

  if (s.commentsDetected !== 1) return `detected=${s.commentsDetected}`;
  if (s.matched !== 1) return `matched=${s.matched}`;
  if (s.repliesGenerated !== 1) return `generated=${s.repliesGenerated}`;
  if (s.repliesSubmitted !== 0) return `A generation must not count as a submission (got ${s.repliesSubmitted})`;
  if (s.failedSkipped !== 0) return `failedSkipped=${s.failedSkipped}`;
  return true;
}

async function testSnapshotDegradesHostileInput() {
  fresh();
  // A malformed report or a corrupted stage must never reach the Popup as NaN or an
  // unlabelled value. The counters have no public writer, so the guards are asserted
  // where they actually bite: an unknown stage is refused, and the snapshot that comes
  // back is always label-bearing and non-negative.
  recordStage('bogus-stage');
  recordStage(null);
  recordStage(12345);

  const s = getProcessingState();
  const counters = [s.commentsDetected, s.matched, s.repliesGenerated, s.repliesSubmitted, s.failedSkipped];
  if (counters.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
    return `Counters must be finite non-negative numbers, got ${JSON.stringify(counters)}`;
  }
  if (!Number.isInteger(s.commentsDetected)) return 'Counters must be integers';
  if (typeof s.stageLabel !== 'string' || s.stageLabel === '') return 'stageLabel must be a non-empty string';
  if (!Object.values(STAGE).includes(s.stage)) return `stage=${s.stage} is not a known stage`;
  return true;
}

async function testHandoffKeepsAttemptActive() {
  fresh();
  recordCommentDetected();
  handOffToContent('c1');
  if (!hasHandoff()) return 'Expected a handoff lease';
  if (!hasActiveProcessing()) return 'Attempt must stay active while the content script posts';

  finishProcessing('c1');
  if (hasHandoff()) return 'Handoff lease should be released';
  return true;
}

async function testTerminalStagesSurviveFinish() {
  fresh();
  recordCommentDetected();
  recordStage(STAGE.COMPLETED);
  finishProcessing();
  if (getProcessingState().stage !== STAGE.COMPLETED) {
    return 'Completed should stay readable after the run ends';
  }

  fresh();
  recordCommentDetected();
  recordStage(STAGE.ERROR);
  finishProcessing();
  if (getProcessingState().stage !== STAGE.ERROR) {
    return 'Error should stay readable after the run ends';
  }
  return true;
}

async function testNonTerminalStageFallsBackToIdle() {
  fresh();
  recordCommentDetected();
  recordStage(STAGE.INSERTING_REPLY);
  finishProcessing();
  if (getProcessingState().stage !== STAGE.IDLE) {
    return 'A mid-pipeline stage must fall back to idle when the attempt ends';
  }
  return true;
}

// ── Layer 2: real processing flows ──────────────────────────────────────────

async function testNoMatchComment() {
  fresh({ triggers: [] });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'hello', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (s.commentsDetected !== 1) return `detected=${s.commentsDetected}`;
  if (s.matched !== 0) return `A NO_MATCH must not count as matched (got ${s.matched})`;
  if (s.repliesGenerated !== 0) return `generated=${s.repliesGenerated}`;
  if (s.failedSkipped !== 0) return `A NO_MATCH is not a failure or a skip (got ${s.failedSkipped})`;
  if (s.stage !== STAGE.IDLE) return `Expected idle after NO_MATCH, got ${s.stage}`;
  if (s.active !== false) return 'The attempt should be closed after NO_MATCH';
  return true;
}

async function testMatchThenGenerationSuccess() {
  fresh({ triggers: [matchAllRule()] });
  recordCommentDetected();
  const verdict = await processJob({ id: 'c1', text: 'بكام الكتاب', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'MATCH') return `verdict=${verdict.result}`;
  if (s.matched !== 1) return `matched=${s.matched}`;
  if (s.repliesGenerated !== 1) return `generated=${s.repliesGenerated}`;
  if (s.repliesSubmitted !== 0) return 'Generation must not count as submitted';
  if (s.stage !== STAGE.WAITING_FOR_LM) return `Expected the stage to hold at waiting_for_lm, got ${s.stage}`;
  if (s.active !== true) return 'The attempt must stay active for the posting steps';
  if (!hasHandoff()) return 'Expected a handoff lease after generation';
  return true;
}

async function testGenerationFailure() {
  fresh({
    triggers: [matchAllRule()],
    generate: async () => { throw new Error('LM Studio did not respond in time'); }
  });
  recordCommentDetected();
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.success !== false) return 'Expected a failure verdict';
  if (s.matched !== 1) return 'A failed generation still matched';
  if (s.repliesGenerated !== 0) return `generated=${s.repliesGenerated}, expected 0`;
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.stage !== STAGE.ERROR) return `stage=${s.stage}, expected error`;
  if (s.active !== false) return 'The attempt must be closed after a failure';
  return true;
}

async function testGenerationTimeout() {
  // The adapter turns an abort into this exact message; the counter path is the same
  // as any other generation failure, so what matters is that nothing was counted as
  // generated and the error is not mislabelled as a match problem.
  fresh({
    triggers: [matchAllRule()],
    generate: async () => {
      const err = new Error('LM Studio did not respond in time, so no reply was sent. Check that the model is loaded, then try again.');
      err.isTimeout = true;
      throw err;
    }
  });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (s.repliesGenerated !== 0) return 'A timeout must not count as a generated reply';
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.stage !== STAGE.ERROR) return `stage=${s.stage}, expected error`;
  return true;
}

async function testInvalidGeneratedReply() {
  fresh({
    triggers: [matchAllRule()],
    validate: { valid: false, reason: 'EMPTY', reply: undefined }
  });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (s.repliesGenerated !== 0) return 'An invalid reply must not count as generated';
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.stage !== STAGE.ERROR) return `stage=${s.stage}, expected error`;
  return true;
}

async function testSuccessfulSubmission() {
  fresh({ triggers: [matchAllRule()] });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  await publishReply({ id: 'c1' });

  const s = getProcessingState();
  if (s.commentsDetected !== 1) return `detected=${s.commentsDetected}`;
  if (s.matched !== 1) return `matched=${s.matched}`;
  if (s.repliesGenerated !== 1) return `generated=${s.repliesGenerated}`;
  if (s.repliesSubmitted !== 1) return `submitted=${s.repliesSubmitted}, expected 1`;
  if (s.failedSkipped !== 0) return `failedSkipped=${s.failedSkipped}, expected 0`;
  if (s.stage !== STAGE.COMPLETED) return `stage=${s.stage}, expected completed`;
  if (s.active !== false) return 'The attempt should be closed after submission';
  if (hasHandoff()) return 'The handoff lease should be released';
  return true;
}

async function testDryRunNeverSubmits() {
  fresh({ triggers: [matchAllRule()], dryRun: true });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  await publishReply({ id: 'c1', dryRun: true });

  const s = getProcessingState();
  if (s.repliesSubmitted !== 0) return `Dry run must not count a submission (got ${s.repliesSubmitted})`;
  if (s.repliesGenerated !== 1) return `generated=${s.repliesGenerated}, expected 1`;
  if (s.failedSkipped !== 1) return `Dry run ends as a skip (got ${s.failedSkipped}, expected 1)`;
  if (s.stage !== STAGE.IDLE) return `stage=${s.stage}, expected idle`;
  if (s.active !== false) return 'The attempt should be closed after a dry run';
  return true;
}

async function testSkippedAlreadyHandled() {
  // Phase 19.8 — the persistent store is keyed by fingerprint, like the real one in
  // handled-comments.js. It was a Set here, which cannot express "which comment".
  fresh({ handled: new Map([['fp1', { timestamp: Date.now() }]]) });
  recordCommentDetected();
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'SKIP_ALREADY_HANDLED') return `result=${verdict.result}`;
  if (s.matched !== 0) return 'A handled comment must not be matched again';
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.active !== false) return 'The attempt should be closed';
  return true;
}

async function testSkippedDuplicateGeneration() {
  fresh({ triggers: [matchAllRule()], hasGeneration: () => true });
  recordCommentDetected();
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'SKIP_SESSION_DUPLICATE') return `result=${verdict.result}`;
  if (s.matched !== 1) return 'It still matched';
  if (s.repliesGenerated !== 0) return `generated=${s.repliesGenerated}, expected 0`;
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.active !== false) return 'The attempt should be closed';
  return true;
}

async function testExtensionOffCountsAsSkipped() {
  fresh({ enabled: false });
  recordCommentDetected();
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'DISABLED') return `result=${verdict.result}`;
  if (s.commentsDetected !== 1) return 'The comment was still received, so it is still detected';
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  if (s.repliesGenerated !== 0) return 'Nothing should be generated while off';
  return true;
}

async function testStageSequenceDuringPosting() {
  fresh({ triggers: [matchAllRule()] });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });

  // Record what stage is live at each real posting point, by pausing the sequence
  // where the content script would pause. This asserts the stage the Popup would show
  // mid-flight, not just the final value.
  const live = [];
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.PREPARING_REPLY, outcome: '', commentId: 'c1' });
  live.push(getProcessingState().stage);
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.OPENING_REPLY_BOX, outcome: '', commentId: 'c1' });
  live.push(getProcessingState().stage);
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.INSERTING_REPLY, outcome: '', commentId: 'c1' });
  live.push(getProcessingState().stage);
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.SUBMITTING_REPLY, outcome: '', commentId: 'c1' });
  live.push(getProcessingState().stage);

  const expected = [
    STAGE.PREPARING_REPLY, STAGE.OPENING_REPLY_BOX, STAGE.INSERTING_REPLY, STAGE.SUBMITTING_REPLY
  ];
  if (live.join('>') !== expected.join('>')) return `Live stage order was ${live.join(' > ')}`;

  // A mid-flight stage report must NOT close the attempt.
  if (getProcessingState().active !== true) return 'A stage-only report must leave the attempt open';

  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.COMPLETED, outcome: OUTCOME.SUBMITTED, commentId: 'c1' });
  if (getProcessingState().stage !== STAGE.COMPLETED) return 'Final stage should be completed';
  if (getProcessingState().active !== false) return 'The terminal outcome must close the attempt';
  return true;
}

async function testPopupReceivesCurrentState() {
  // The model matches "بكام" and rejects "مرحبا": one comment matches and gets
  // published, one does not. The stub stands in for LM Studio's judgement here.
  fresh({
    triggers: [matchAllRule()],
    complete: async (messages) => {
      const user = messages.find((m) => m.role === 'user');
      const asked = user && user.content.includes('بكام');
      const comment = asked && /Comment:\n([^\n]+)/.exec(user.content);
      const matches = comment ? comment[1].includes('بكام') : false;
      return {
        text: JSON.stringify(matches ? { matched: true, trigger: 'بكام' } : { matched: false }),
        reasoning: ''
      };
    },
  });

  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  recordCommentDetected();
  await processJob({ id: 'c2', text: 'مرحبا', fingerprint: 'fp2' });
  await publishReply({ id: 'c1' });

  const res = handleMessage({ action: 'GET_PROCESSING_STATE' });
  const s = res.state;

  if (res.success !== true) return 'GET_PROCESSING_STATE should succeed';
  if (s.commentsDetected !== 2) return `detected=${s.commentsDetected}, expected 2`;
  if (s.matched !== 1) return `matched=${s.matched}, expected 1`;
  if (s.repliesGenerated !== 1) return `generated=${s.repliesGenerated}, expected 1`;
  if (s.repliesSubmitted !== 1) return `submitted=${s.repliesSubmitted}, expected 1`;
  if (typeof s.stageLabel !== 'string' || !s.stageLabel) return 'stageLabel must be a non-empty string';
  // Everything must survive the structured clone that sendMessage performs.
  try {
    const cloned = JSON.parse(JSON.stringify(s));
    if (cloned.stage !== s.stage) return 'Snapshot is not JSON-safe';
  } catch (e) {
    return `Snapshot is not serializable: ${e.message}`;
  }
  return true;
}

async function testStateResetsAfterServiceWorkerStartup() {
  fresh({ triggers: [matchAllRule()] });
  recordCommentDetected();
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  await publishReply({ id: 'c1' });

  // A restart gives the module fresh state — this is what resetProcessingStats()
  // stands in for, and what the popup shows when it asks a freshly woken worker.
  resetProcessingStats();
  const res = handleMessage({ action: 'GET_PROCESSING_STATE' });
  const s = res.state;

  if (s.commentsDetected !== 0 || s.matched !== 0 || s.repliesGenerated !== 0 ||
      s.repliesSubmitted !== 0 || s.failedSkipped !== 0) {
    return `Expected zeros after restart, got ${JSON.stringify(s)}`;
  }
  if (s.stage !== STAGE.IDLE) return `stage=${s.stage}, expected idle`;
  if (s.stageLabel !== 'Idle') return `label=${s.stageLabel}`;
  if (s.active !== false) return 'active should be false after a restart';
  return true;
}

async function testStateActionSurvivesGarbageInput() {
  fresh();
  // A malformed report must not throw and must not move the stage.
  recordStage(STAGE.CHECKING_MATCHES);
  let threw = false;
  try {
    handleMessage({ action: 'REPORT_PROCESSING_STAGE' });
    handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: 42, outcome: 'not-real' });
    handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.IDLE, outcome: 'made-up' });
  } catch (_) {
    threw = true;
  }
  if (threw) return 'A malformed report must not throw';
  const s = getProcessingState();
  if (s.commentsDetected !== 0) return 'A malformed report must not move any counter';
  return true;
}

// ── Layer 3: LM Studio semantic matching ─────────────────────────────────────
//
// These assert the SAFETY contract of the semantic stage: every ambiguous or broken
// outcome resolves to "no match, no reply", and one failure never stops the queue.

/** Stub that returns exactly the raw text given, to exercise the parser. */
function rawResponse(text) {
  return async () => ({ text, reasoning: '' });
}

async function testSemanticMatchOnParaphrase() {
  fresh({
    triggers: [{
      id: 'rule-price',
      enabled: true,
      phrases: ['بكام'],
      matchMode: 'contains',
      caseSensitive: false
    }],
    // "كام سعره؟" shares no substring with "بكام" — only a semantic pass can match it.
    complete: rawResponse(JSON.stringify({ matched: true, trigger: 'بكام' })),
  });

  recordCommentDetected('c1');
  const verdict = await processJob({ id: 'c1', text: 'كام سعره؟', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'MATCH') return `Expected MATCH on the paraphrase, got ${verdict.result}`;
  if (s.matched !== 1) return `matched=${s.matched}`;
  if (verdict.ruleId !== 'rule-price') return `Expected the owning rule id, got ${verdict.ruleId}`;
  return true;
}

async function testSemanticNoMatchOnUnrelatedComment() {
  fresh({
    triggers: [{
      id: 'rule-price',
      enabled: true,
      phrases: ['بكام'],
      matchMode: 'contains',
      caseSensitive: false
    }],
    complete: rawResponse(JSON.stringify({ matched: false })),
  });

  recordCommentDetected('c1');
  const verdict = await processJob({ id: 'c1', text: 'الفيديو جميل جداً', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.result !== 'NO_MATCH') return `Expected NO_MATCH, got ${verdict.result}`;
  if (s.matched !== 0) return `An unrelated comment must not count as matched (got ${s.matched})`;
  if (s.repliesGenerated !== 0) return `No reply may be generated (got ${s.repliesGenerated})`;
  if (s.failedSkipped !== 0) return 'A legitimate NO_MATCH is neither a failure nor a skip';
  return true;
}

/**
 * The semantic call must be classification only. If the matcher ever asked for a reply,
 * the generated reply could still be sitting in the completion function's answer.
 */
async function testSemanticMatchDoesNotGenerateAReply() {
  let prompt = '';

  let semanticCalls = 0;
  let generateCalls = 0;
  fresh({
    triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
    complete: async (messages) => {
      semanticCalls++;
      prompt = messages.map((m) => m.content).join('\n');
      return { text: JSON.stringify({ matched: true, trigger: 'بكام' }), reasoning: '' };
    },
    generate: async () => { generateCalls++; return { text: 'السعر 50 جنيه' }; },
  });

  recordCommentDetected('c1');
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });

  if (prompt === '') return 'The matcher never called the model';
  if (!/JSON only/i.test(prompt)) return 'The classification prompt must demand JSON only';
  if (/write a reply|generate a reply|respond to the comment/i.test(prompt)) {
    return 'The classification prompt must not ask for a reply';
  }

  // The two LM Studio calls are separate: exactly one classification call, and the
  // reply comes from the generation step that runs after the match — never from the
  // classification response itself.
  if (semanticCalls !== 1) return `Expected exactly one classification call, got ${semanticCalls}`;
  if (generateCalls !== 1) return `Expected generation to run separately, got ${generateCalls} calls`;
  return true;
}

async function testInvalidJsonIsNotAMatch() {
  for (const bad of [
    'not json at all',
    '{"matched": tru}',
    '{"matched": "true", "trigger": "بكام"}',
    '{"match": true}',
    '[{"matched":true}]',
    '```json\n{"matched":\n```',
    ''
  ]) {
    fresh({
      triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
      complete: rawResponse(bad),
    });

    recordCommentDetected('c1');
    const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
    const s = getProcessingState();

    if (verdict.matched === true || verdict.reply) {
      return `Malformed output ${JSON.stringify(bad)} produced a reply`;
    }
    if (s.matched !== 0) return `Malformed output ${JSON.stringify(bad)} counted as matched`;
    if (s.repliesGenerated !== 0) return `Malformed output ${JSON.stringify(bad)} generated a reply`;
  }
  return true;
}

/** A thrown transport error must fail safe and be recorded, not crash the loop. */
async function testLMStudioFailureIsContained() {
  fresh({
    triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
    complete: async () => { throw new Error('Cannot connect to LM Studio.'); },
  });

  recordCommentDetected('c1');
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  const s = getProcessingState();

  if (verdict.success !== false) return 'A failed match must be reported as unsuccessful';
  if (verdict.reply) return 'A failed match must never carry a reply';
  if (s.failedSkipped !== 1) return `Expected the failure to be counted, got ${s.failedSkipped}`;
  if (s.stage !== STAGE.ERROR) return `Expected stage error, got ${s.stage}`;
  if (s.active !== false) return 'The attempt must be closed so the run can end';
  return true;
}

/**
 * One comment failing must not stop the next. This is the requirement that matters
 * most operationally: an offline LM Studio must not wedge the queue.
 */
async function testQueueContinuesAfterAMatchingFailure() {
  let call = 0;
  fresh({
    triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
    complete: async (messages) => {
      call++;
      if (call === 1) throw new Error('Cannot connect to LM Studio.');
      const user = messages.find((m) => m.role === 'user');
      const phrase = /^- (.+)$/m.exec(user ? user.content : '');
      return { text: JSON.stringify({ matched: true, trigger: phrase ? phrase[1] : '' }), reasoning: '' };
    },
  });

  recordCommentDetected('c1');
  const first = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  recordCommentDetected('c2');
  const second = await processJob({ id: 'c2', text: 'بكام', fingerprint: 'fp2' });
  const s = getProcessingState();

  if (first.success !== false) return 'The first comment should have failed';
  if (second.result !== 'MATCH') return `The second comment must still be processed, got ${second.result}`;
  if (s.commentsDetected !== 2) return `detected=${s.commentsDetected}`;
  if (s.failedSkipped !== 1) return `Expected exactly one failure, got ${s.failedSkipped}`;
  if (s.matched !== 1) return `The second comment should have matched, matched=${s.matched}`;
  if (s.repliesGenerated !== 1) return `Expected one generated reply, got ${s.repliesGenerated}`;
  return true;
}

// ── Layer 4: the run timer ──────────────────────────────────────────────────

/** Advance the monotonic clock by `ms` and let the timer observe it. */
async function advanceClock(ms) {
  const start = performance.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  // Assert the pause was real rather than a no-op, so a test cannot pass on a clock
  // that never moved.
  if (performance.now() - start < ms * 0.5) {
    throw new Error('clock did not advance');
  }
}

async function testTimerStartsWithTheFirstCommentOfARun() {
  fresh();
  const before = getProcessingState();
  if (before.timerRunning !== false) return 'The timer must not run before any comment';
  if (before.elapsedMs !== 0) return `Expected 0 before a run, got ${before.elapsedMs}`;

  recordCommentDetected('c1');
  const started = getProcessingState();
  if (started.timerRunning !== true) return 'The timer must start at the first detected comment';
  if (started.elapsedMs < 0) return 'Elapsed time must never be negative';

  await advanceClock(60);
  const grew = getProcessingState().elapsedMs;
  if (grew < 40) return `Expected elapsed time to grow while running, got ${grew}ms`;
  return true;
}

/** Matching alone must not end the run — generation and posting are still to come. */
async function testTimerDoesNotStopAfterMatchingAlone() {
  fresh({
    triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
  });

  recordCommentDetected('c1');
  const verdict = await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  await advanceClock(50);
  const s = getProcessingState();

  if (verdict.result !== 'MATCH') return 'Setup failed: expected a match';
  if (s.timerRunning !== true) return 'The timer must keep running while the reply is handed off';
  // Matching is over but the run is not: the reply is in the content script's hands.
  if (s.elapsedMs < 30) return `Elapsed time should still be accumulating, got ${s.elapsedMs}ms`;
  return true;
}

/** The run ends only when the last comment reaches a terminal state. */
async function testTimerStopsAfterTheFinalCommentFinishes() {
  fresh({
    triggers: [{ id: 'r1', enabled: true, phrases: ['بكام'], matchMode: 'contains', caseSensitive: false }],
  });

  recordCommentDetected('c1');
  await processJob({ id: 'c1', text: 'بكام', fingerprint: 'fp1' });
  // Real generation and posting take seconds, so let measurable time pass before the
  // terminal report. Without this the run could finish inside the same millisecond and
  // the total would legitimately round to 0.
  await advanceClock(50);
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.COMPLETED, outcome: OUTCOME.SUBMITTED, commentId: 'c1' });

  const done = getProcessingState();
  if (done.timerRunning !== false) return 'The timer must stop once the last comment finished';
  const finalMs = done.elapsedMs;
  if (finalMs <= 0) return `Expected a positive final duration, got ${finalMs}`;

  // The frozen total must not keep climbing after the run ended.
  await advanceClock(50);
  const later = getProcessingState().elapsedMs;
  if (later !== finalMs) return `The final duration must stay frozen (${finalMs} -> ${later})`;
  return true;
}

/** A NO_MATCH is terminal for that comment, so a run of only NO_MATCHs still ends. */
async function testTimerStopsAfterANoMatchRun() {
  fresh({ triggers: [] });
  recordCommentDetected('c1');
  await processJob({ id: 'c1', text: 'hello', fingerprint: 'fp1' });

  const s = getProcessingState();
  if (s.timerRunning !== false) return 'A finished NO_MATCH must finalize the timer';
  return true;
}

/** A new run must start from zero, never blended with the previous total. */
async function testNewRunResetsTheTimer() {
  fresh();
  recordCommentDetected('c1');
  await advanceClock(60);
  finishProcessing('c1');

  const firstRun = getProcessingState();
  if (firstRun.timerRunning !== false) return 'Setup failed: the first run should have ended';
  const firstMs = firstRun.elapsedMs;
  if (firstMs < 40) return `Setup failed: expected a measurable first run, got ${firstMs}`;

  // Let the wall clock move on, so a non-resetting timer would obviously blend.
  await advanceClock(80);

  recordCommentDetected('c2');
  const second = getProcessingState();
  if (second.timerRunning !== true) return 'A new comment must start a new run';
  if (second.elapsedMs >= firstMs) {
    return `A new run must reset the timer (elapsed ${second.elapsedMs} >= previous ${firstMs})`;
  }
  // The timer resets; the tallies are cumulative for the worker session and are not
  // expected to. Only the measurement must be per-run.
  if (second.commentsDetected !== 2) return `Comments detected should carry over, got ${second.commentsDetected}`;
  return true;
}

/** The final duration has to survive the structured clone to reach the Popup. */
async function testTimerIsExposedToThePopup() {
  fresh();
  recordCommentDetected('c1');
  await advanceClock(50);
  finishProcessing('c1');

  const res = handleMessage({ action: 'GET_PROCESSING_STATE' });
  const s = res.state;

  if (typeof s.elapsedMs !== 'number') return 'elapsedMs must be a number';
  if (typeof s.timerRunning !== 'boolean') return 'timerRunning must be a boolean';
  if (!Number.isFinite(s.elapsedMs) || s.elapsedMs < 0) return `elapsedMs=${s.elapsedMs}`;
  if (s.elapsedMs < 40) return `Expected the measured duration to reach the Popup, got ${s.elapsedMs}`;

  // It must survive the JSON hop the way it really travels.
  const cloned = JSON.parse(JSON.stringify(s));
  if (cloned.elapsedMs !== s.elapsedMs) return 'elapsedMs must survive serialisation';
  return true;
}

/** Re-reporting the same comment must not inflate the detected tally. */
async function testDuplicateDetectionDoesNotInflateTheCount() {
  fresh({ triggers: [] });

  recordCommentDetected('comment-1');
  recordCommentDetected('comment-1');
  recordCommentDetected('comment-1');
  recordCommentDetected('comment-2');

  const s = getProcessingState();
  if (s.commentsDetected !== 2) return `Expected 2 unique comments, got ${s.commentsDetected}`;

  // The critical invariant: a duplicate must not leave the run permanently busy,
  // because only one finish is ever reported for it.
  if (s.active !== true) return 'active must reflect one live comment, not four';
  finishProcessing('comment-1');
  finishProcessing('comment-2');
  const done = getProcessingState();
  if (done.timerRunning !== false) return 'A duplicate must not keep the timer running forever';
  return true;
}

async function runAllTests() {
  console.log('\n=== Processing Status Tests ===\n');

  await runTest('Fresh state is zeros and Idle', testFreshStateIsZeroAndIdle);
  await runTest('Every stage has a human-readable label', testEveryStageHasALabel);
  await runTest('Unknown stage values are rejected', testUnknownStageIsRejected);
  await runTest('Counters are independent', testCountersAreIndependent);
  await runTest('Snapshot degrades hostile input safely', testSnapshotDegradesHostileInput);
  await runTest('Handoff keeps the attempt active', testHandoffKeepsAttemptActive);
  await runTest('Completed/Error survive the attempt ending', testTerminalStagesSurviveFinish);
  await runTest('Mid-pipeline stages fall back to Idle', testNonTerminalStageFallsBackToIdle);

  await runTest('NO_MATCH comment', testNoMatchComment);
  await runTest('MATCH then generation success', testMatchThenGenerationSuccess);
  await runTest('Generation failure', testGenerationFailure);
  await runTest('Generation timeout', testGenerationTimeout);
  await runTest('Invalid generated reply', testInvalidGeneratedReply);
  await runTest('Successful reply submission', testSuccessfulSubmission);
  await runTest('Dry run never counts a submission', testDryRunNeverSubmits);
  await runTest('Skipped: already handled', testSkippedAlreadyHandled);
  await runTest('Skipped: duplicate generation', testSkippedDuplicateGeneration);
  await runTest('Extension off counts as a skip', testExtensionOffCountsAsSkipped);
  await runTest('Posting stage sequence', testStageSequenceDuringPosting);
  await runTest('Popup action returns the current state', testPopupReceivesCurrentState);
  await runTest('State resets after service-worker startup', testStateResetsAfterServiceWorkerStartup);
  await runTest('Malformed stage reports are ignored', testStateActionSurvivesGarbageInput);

  console.log('\n--- LM Studio semantic matching ---');
  await runTest('Semantic match on an Arabic paraphrase', testSemanticMatchOnParaphrase);
  await runTest('Semantic NO_MATCH on an unrelated comment', testSemanticNoMatchOnUnrelatedComment);
  await runTest('Semantic matching never generates a reply', testSemanticMatchDoesNotGenerateAReply);
  await runTest('Invalid LM Studio JSON is never a match', testInvalidJsonIsNotAMatch);
  await runTest('LM Studio failure is contained', testLMStudioFailureIsContained);
  await runTest('Queue continues after a matching failure', testQueueContinuesAfterAMatchingFailure);

  console.log('\n--- Processing run timer ---');
  await runTest('Timer starts with the first comment of a run', testTimerStartsWithTheFirstCommentOfARun);
  await runTest('Timer does not stop after matching alone', testTimerDoesNotStopAfterMatchingAlone);
  await runTest('Timer stops after the final comment finishes', testTimerStopsAfterTheFinalCommentFinishes);
  await runTest('Timer finalizes after a NO_MATCH run', testTimerStopsAfterANoMatchRun);
  await runTest('A new run resets the timer', testNewRunResetsTheTimer);
  await runTest('Final duration reaches the Popup', testTimerIsExposedToThePopup);
  await runTest('Duplicate detection does not inflate the count', testDuplicateDetectionDoesNotInflateTheCount);

  console.log('\n--- Phase 20.18: Knowledge processing UI ---');
  await runTest('Knowledge stages are accepted and labelled', testKnowledgeStagesAreAccepted);
  await runTest('Stage labels are distinct', testKnowledgeStageLabelsAreDistinct);
  await runTest('Knowledge counters accumulate', testKnowledgeCountersAccumulate);
  await runTest('An expected skip stays out of the failure tally', testExpectedSkipStaysOutOfTheFailureTally);
  await runTest('A fault skip counts as both', testFaultSkipCountsAsBothAFailureAndAReason);
  await runTest('Skip reasons carry count, label and flag', testSkipReasonsCarryCountLabelAndExpectedFlag);
  await runTest('An unknown skip code is rejected', testUnknownSkipCodeIsRejected);
  await runTest('Every knowledge code has a label', testEveryKnowledgeCodeHasALabelAndABucket);
  await runTest('The snapshot is sanitized and serializable', testSnapshotIsSanitizedAndSerializable);
  await runTest('Reset clears the skip reasons', testCorruptSkipReasonsAreCoercedAway);

  console.log('\n--- Why the last one declined (22.1) ---');
  await runTest('A skip keeps its reason and files', testASkipKeepsItsReasonAndFiles);
  await runTest('Repeated filenames are collapsed', testRepeatedFilenamesAreCollapsed);
  await runTest('The sample buffer is bounded', testTheSampleBufferIsBounded);
  await runTest('The file list is bounded', testTheFileListIsBounded);
  await runTest('Hostile sample detail is bounded and does not throw', testHostileSampleDetailIsBoundedAndDoesNotThrow);
  await runTest('The sample carries retrieved / offered / dropped counts', testTheSampleCarriesRetrievedOfferedAndDroppedCounts);
  await runTest('An unreported count is distinguishable from zero', testAnUnreportedCountIsDistinguishableFromZero);
  await runTest('Junk counts become unreported, not zeroes', testJunkCountsBecomeUnreportedNotZeroes);
  await runTest('The sample carries the offered shortlist', testTheSampleCarriesTheOfferedShortlist);
  await runTest('The shortlist is bounded', testTheShortlistIsBounded);
  await runTest('A junk shortlist is dropped, not thrown', testAJunkShortlistIsDroppedNotThrown);
  await runTest('Junk sample input is rejected, not recorded', testJunkSampleInputIsRejectedNotRecorded);
  await runTest('A sample with no detail is still recorded', testASampleWithNoDetailIsStillRecorded);
  await runTest('Samples are serializable', testSamplesAreSerializable);
  await runTest('Reset clears the samples', testResetClearsTheSamples);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

/** ── Phase 20.18: the Knowledge numbers ───────────────────────────────────── */

async function testKnowledgeStagesAreAccepted() {
  fresh();

  const knowledgeStages = [
    STAGE.KNOWLEDGE_INDEX,
    STAGE.KNOWLEDGE_INTENT,
    STAGE.KNOWLEDGE_RETRIEVAL,
    STAGE.KNOWLEDGE_ANSWERABILITY,
    STAGE.KNOWLEDGE_GENERATION
  ];

  for (const stage of knowledgeStages) {
    if (!recordStage(stage)) return `recordStage(${stage}) must be accepted`;
    const s = getProcessingState();
    if (s.stage !== stage) return `stage=${s.stage}, expected ${stage}`;
    // A label is what the Panel actually shows; a stage with an empty one is invisible.
    if (typeof s.stageLabel !== 'string' || !s.stageLabel) return `stage ${stage} has no label`;
  }
  return true;
}

async function testKnowledgeStageLabelsAreDistinct() {
  // Two stages sharing a label make the stage line useless for the one question it
  // exists to answer — which model call is taking the time.
  const labels = Object.values(STAGE_LABELS);
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  return dupes.length === 0 || `duplicate stage labels: ${dupes.join(', ')}`;
}

async function testKnowledgeCountersAccumulate() {
  fresh();
  recordCommentDetected('c1');
  recordKnowledgeHit();
  recordKnowledgeHit();
  recordKnowledgeHit();
  recordKnowledgeAnswerable();
  recordKnowledgeAnswerable();

  const s = getProcessingState();
  if (s.knowledgeHits !== 3) return `knowledgeHits=${s.knowledgeHits}, expected 3`;
  if (s.knowledgeAnswerable !== 2) return `knowledgeAnswerable=${s.knowledgeAnswerable}, expected 2`;

  // A hit is NOT an answer: retrieval finding something says nothing about whether the
  // base supports a reply, and conflating them would hide a base that matches but does
  // not cover.
  if (s.knowledgeAnswerable > s.knowledgeHits) return 'answerable must never exceed hits';

  // And a Knowledge reply is not a trigger match, so `matched` must stay at zero.
  if (s.matched !== 0) return `matched=${s.matched}, expected 0 for a knowledge-only run`;
  return true;
}

async function testExpectedSkipStaysOutOfTheFailureTally() {
  fresh();
  recordCommentDetected('c1');
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');

  const s = getProcessingState();
  if (s.knowledgeSkipped !== 3) return `knowledgeSkipped=${s.knowledgeSkipped}, expected 3`;
  // The defining property: a base that correctly declines is not failing.
  if (s.failedSkipped !== 0) return `failedSkipped=${s.failedSkipped}, expected 0 for expected skips`;
  return true;
}

async function testFaultSkipCountsAsBothAFailureAndAReason() {
  fresh();
  recordCommentDetected('c1');
  recordKnowledgeSkip('GROUNDING_VALIDATION_FAILED');

  const s = getProcessingState();
  // Counted as a failure, because the user CAN act on it — that is the whole difference
  // between this code and NO_SUPPORTED_ANSWER.
  if (s.failedSkipped !== 1) return `failedSkipped=${s.failedSkipped}, expected 1`;
  // NOT as an expected decline, or the panel would say "the base knew and declined"
  // about a reply that asserted something unsupported.
  if (s.knowledgeSkipped !== 0) return `knowledgeSkipped=${s.knowledgeSkipped}, expected 0`;
  if (!s.knowledgeSkipReasons.GROUNDING_VALIDATION_FAILED) return 'the reason must be recorded';
  return true;
}

async function testSkipReasonsCarryCountLabelAndExpectedFlag() {
  fresh();
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkip('CONFLICTING_KNOWLEDGE');

  const s = getProcessingState();
  const expected = s.knowledgeSkipReasons.NO_SUPPORTED_ANSWER;
  const fault = s.knowledgeSkipReasons.CONFLICTING_KNOWLEDGE;
  if (!expected || !fault) return 'both reasons must be present';

  if (expected.count !== 1) return `count=${expected.count}`;
  if (expected.expected !== true) return 'NO_SUPPORTED_ANSWER must be flagged expected';
  if (fault.expected !== false) return 'CONFLICTING_KNOWLEDGE must not be flagged expected';
  // The Panel is a classic script: it cannot import the module, so the label has to
  // travel with the count or the row renders blank.
  for (const [code, entry] of Object.entries(s.knowledgeSkipReasons)) {
    if (typeof entry.label !== 'string' || !entry.label) return `${code} has no label`;
  }
  return true;
}

async function testUnknownSkipCodeIsRejected() {
  fresh();
  recordCommentDetected('c1');

  if (recordKnowledgeSkip('NOT_A_REAL_CODE') !== false) return 'an unknown code must return false';
  if (recordKnowledgeSkip('') !== false) return 'an empty code must return false';
  if (recordKnowledgeSkip(undefined) !== false) return 'a missing code must return false';

  const s = getProcessingState();
  // Rejecting rather than inventing a row: the Panel has no label for a code outside the
  // closed vocabulary, so accepting it would hide a programming error behind a blank line.
  if (s.failedSkipped !== 0) return 'an unknown code must not touch the counters';
  if (s.knowledgeSkipped !== 0) return 'an unknown code must not touch the counters';
  return true;
}

async function testEveryKnowledgeCodeHasALabelAndABucket() {
  // The Panel's whole skip list is built from SKIP_REASON_LABELS, so a new §32 code with
  // no label is a code the user can never be shown the reason for.
  const codes = Object.values(KNOWLEDGE_ERROR);
  const missing = codes.filter((c) => !SKIP_REASON_LABELS[c]);
  return missing.length === 0 || `codes with no label: ${missing.join(', ')}`;
}

async function testSnapshotIsSanitizedAndSerializable() {
  fresh();
  recordKnowledgeHit();
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkip('GROUNDING_CHECK_FAILED');

  const s = getProcessingState();
  const cloned = JSON.parse(JSON.stringify(s));

  // Only known codes may leave the module, and only as {count, label, expected}.
  for (const [code, entry] of Object.entries(cloned.knowledgeSkipReasons)) {
    if (!SKIP_REASON_LABELS[code]) return `unknown code ${code} reached the snapshot`;
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'count,expected,label') return `entry shape for ${code} is ${keys}`;
    if (!Number.isFinite(entry.count) || entry.count < 0) return `bad count for ${code}`;
    if (typeof entry.expected !== 'boolean') return `expected must be boolean for ${code}`;
  }
  for (const key of ['knowledgeHits', 'knowledgeAnswerable', 'knowledgeSkipped']) {
    if (typeof cloned[key] !== 'number' || cloned[key] < 0) return `${key} must be a non-negative number`;
  }
  return true;
}

async function testCorruptSkipReasonsAreCoercedAway() {
  fresh();
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  // Nothing should be able to put junk in here, but the snapshot must not become an
  // `NaN` on screen if something does.
  const s = getProcessingState();
  if (s.knowledgeSkipReasons.NO_SUPPORTED_ANSWER.count !== 2) return 'the real count must survive';

  // A fresh state with nothing recorded must expose an EMPTY map, never a stale one.
  fresh();
  const cleared = getProcessingState();
  const keys = Object.keys(cleared.knowledgeSkipReasons);
  return keys.length === 0 || `reset left stale reasons: ${keys.join(', ')}`;
}

// ── Phase 22.1: why the last one declined ─────────────────────────────────────

/**
 * The counter answers "how often". These answer "why did THIS one", which is the question
 * a user actually opens the panel with — and before this existed there was nowhere to look.
 */
async function testASkipKeepsItsReasonAndFiles() {
  fresh();
  recordKnowledgeSkip('NO_SUPPORTED_ANSWER');
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', {
    reason: 'the section does not state a price for this book',
    commentText: 'بكام كتاب الكيمياء؟',
    filenames: [{ filename: 'books/chemistry.md' }]
  });

  const samples = getProcessingState().knowledgeSkipSamples;
  if (!Array.isArray(samples) || samples.length !== 1) return `expected one sample, got ${samples && samples.length}`;

  const s = samples[0];
  if (s.code !== 'NO_SUPPORTED_ANSWER') return `the wrong code: ${s.code}`;
  if (s.label !== SKIP_REASON_LABELS.NO_SUPPORTED_ANSWER) return 'the label is not the shared vocabulary';
  if (!/does not state a price/.test(s.reason)) return `the reason was lost: ${s.reason}`;
  if (s.commentPreview !== 'بكام كتاب الكيمياء؟') return `the comment preview was lost: ${s.commentPreview}`;
  if (s.filenames.length !== 1 || s.filenames[0] !== 'books/chemistry.md') {
    return `the filenames were lost: ${JSON.stringify(s.filenames)}`;
  }
  return true;
}

/**
 * Five sections of ONE file is one file. Without this, a price question about one book
 * reports "a.md, a.md, a.md, a.md, a.md" and reads as five documents.
 */
async function testRepeatedFilenamesAreCollapsed() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', {
    reason: 'r',
    filenames: [
      { filename: 'books/chemistry.md' },
      { filename: 'books/chemistry.md' },
      { filename: 'books/chemistry.md' },
      'books/chemistry.md'
    ]
  });
  const samples = getProcessingState().knowledgeSkipSamples;
  if (samples[0].filenames.length !== 1) return `expected one file, got ${JSON.stringify(samples[0].filenames)}`;
  return true;
}

async function testTheSampleBufferIsBounded() {
  fresh();
  for (let i = 0; i < MAX_KNOWLEDGE_SKIP_SAMPLES + 8; i++) {
    recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', { reason: `reason ${i}` });
  }
  const samples = getProcessingState().knowledgeSkipSamples;
  if (samples.length > MAX_KNOWLEDGE_SKIP_SAMPLES) return `${samples.length} samples survived the cap`;
  // The newest is what the Panel shows, so it must be the one kept.
  const newest = samples[samples.length - 1];
  if (newest.reason !== `reason ${MAX_KNOWLEDGE_SKIP_SAMPLES + 7}`) return `the newest sample was dropped: ${newest.reason}`;
  return true;
}

async function testTheFileListIsBounded() {
  fresh();
  const filenames = Array.from({ length: 30 }, (_, i) => ({ filename: `file-${i}.md` }));
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', { reason: 'r', filenames });
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.filenames.length > 6) return `${s.filenames.length} filenames were kept`;
  return true;
}

/**
 * Model output and a viewer's comment are both unbounded, and this runs inside the counter
 * update that records the skip — a throw here would lose the skip itself.
 */
async function testHostileSampleDetailIsBoundedAndDoesNotThrow() {
  fresh();
  const hostile = {
    reason: 'x'.repeat(5000),
    commentText: 'y'.repeat(5000),
    filenames: [{ filename: 'z'.repeat(500) }, null, 42, undefined, {}, { filename: 'ok.md' }]
  };
  let threw = false;
  try {
    recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', hostile);
  } catch (_) {
    threw = true;
  }
  if (threw) return 'hostile detail threw from inside the counter update';

  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.reason.length > 320) return `the reason ran to ${s.reason.length} chars`;
  if (s.commentPreview.length > 320) return `the preview ran to ${s.commentPreview.length} chars`;
  // The tail is kept, because the tail of a path is what identifies it.
  if (!s.filenames.some((f) => f.endsWith('z'))) return `a long filename lost its tail: ${JSON.stringify(s.filenames)}`;
  if (s.filenames.some((f) => f === '42' || f === 'null')) return `junk became a filename: ${JSON.stringify(s.filenames)}`;
  return true;
}

/**
 * THE THREE COUNTS. They are the whole diagnosis for "my price is in the file and it still
 * said no": retrieval drops overflow past its candidate limits and the gate drops any
 * section over its character limit, so an answer buried in a long chapter never reaches the
 * prompt and the gate's honest verdict reads as a fact about the user's Markdown.
 */
async function testTheSampleCarriesRetrievedOfferedAndDroppedCounts() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', {
    reason: 'the sections do not mention a price',
    retrievedCount: 9,
    offeredCount: 2,
    droppedCount: 7
  });
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.retrievedCount !== 9) return `retrievedCount was ${s.retrievedCount}`;
  if (s.offeredCount !== 2) return `offeredCount was ${s.offeredCount}`;
  if (s.droppedCount !== 7) return `droppedCount was ${s.droppedCount}`;
  return true;
}

/** A real zero is a zero. Only "not reported" is −1, and the Panel must be able to tell. */
async function testAnUnreportedCountIsDistinguishableFromZero() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', { reason: 'r', offeredCount: 0 });
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.offeredCount !== 0) return `a real zero became ${s.offeredCount}`;
  if (s.droppedCount !== -1) return `an unreported count became ${s.droppedCount}, not -1`;
  return true;
}

async function testJunkCountsBecomeUnreportedNotZeroes() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', {
    reason: 'r',
    retrievedCount: 'many',
    offeredCount: NaN,
    droppedCount: -8
  });
  const s = getProcessingState().knowledgeSkipSamples[0];
  for (const key of ['retrievedCount', 'offeredCount', 'droppedCount']) {
    if (s[key] !== -1) return `${key} became ${s[key]} instead of -1`;
  }
  return true;
}

/**
 * THE SHORTLIST. The decisive fact for "the model found nothing relevant": either the
 * section holding the answer was never offered, or it was and the model read it as not
 * answering. Nothing else distinguishes those two.
 */
async function testTheSampleCarriesTheOfferedShortlist() {
  fresh();
  recordKnowledgeSkipSample('NO_RELEVANT_KNOWLEDGE', {
    reason: 'the model found no relevant section in the shortlist',
    retrievedCount: 0,
    offeredCount: 0,
    shortlist: [
      { filename: 'books/chemistry.md', heading: 'Chapter 1', chars: 120 },
      { filename: 'books/chemistry.md', heading: 'الأسعار', chars: 90 }
    ]
  });
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (!Array.isArray(s.shortlist) || s.shortlist.length !== 2) return 'the shortlist was lost';
  if (s.shortlist[0].chars !== 120) return `the character count was lost: ${s.shortlist[0].chars}`;
  if (s.shortlist[1].heading !== 'الأسعار') return 'the heading was lost';
  return true;
}

/** Bounded, because this rides the one-second poll. */
async function testTheShortlistIsBounded() {
  fresh();
  const shortlist = Array.from({ length: 40 }, (_, i) => ({
    filename: `f${i}.md`, heading: `h${i}`, chars: 10
  }));
  recordKnowledgeSkipSample('NO_RELEVANT_KNOWLEDGE', { reason: 'r', shortlist });
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.shortlist.length > 8) return `${s.shortlist.length} sections were kept`;
  return true;
}

async function testAJunkShortlistIsDroppedNotThrown() {
  fresh();
  let threw = false;
  try {
    recordKnowledgeSkipSample('NO_RELEVANT_KNOWLEDGE', {
      reason: 'r',
      shortlist: [null, 'nope', 42, { filename: 'ok.md', heading: 'H', chars: 5 }]
    });
  } catch (_) {
    threw = true;
  }
  if (threw) return 'a junk shortlist threw';
  const s = getProcessingState().knowledgeSkipSamples[0];
  if (s.shortlist.length !== 1 || s.shortlist[0].filename !== 'ok.md') {
    return `junk was not dropped: ${JSON.stringify(s.shortlist)}`;
  }
  return true;
}

async function testJunkSampleInputIsRejectedNotRecorded() {
  fresh();
  for (const code of [null, undefined, 42, 'NOT_A_CODE', '']) {
    if (recordKnowledgeSkipSample(code, { reason: 'r' })) return `${String(code)} was accepted as a code`;
  }
  if (getProcessingState().knowledgeSkipSamples.length !== 0) return 'something was recorded anyway';
  return true;
}

/** A sample with nothing but a code is still valid — the panel shows the label. */
async function testASampleWithNoDetailIsStillRecorded() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER');
  const samples = getProcessingState().knowledgeSkipSamples;
  if (samples.length !== 1) return 'a bare sample was dropped';
  if (samples[0].reason !== '' || samples[0].filenames.length !== 0) return 'a bare sample grew fields';
  return true;
}

/** Serialized on every one-second poll, so it must survive the message boundary. */
async function testSamplesAreSerializable() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', {
    reason: 'r', commentText: 'c', filenames: ['a.md']
  });
  const round = JSON.parse(JSON.stringify(getProcessingState().knowledgeSkipSamples));
  if (!Array.isArray(round) || round.length !== 1) return 'the samples did not survive serialization';
  if (round[0].reason !== 'r') return 'the reason did not survive';
  return true;
}

/** A reset must not leave a decline on screen explaining a run that has ended. */
async function testResetClearsTheSamples() {
  fresh();
  recordKnowledgeSkipSample('NO_SUPPORTED_ANSWER', { reason: 'r' });
  fresh();
  const samples = getProcessingState().knowledgeSkipSamples;
  if (!Array.isArray(samples) || samples.length !== 0) return `reset left ${samples && samples.length} samples`;
  return true;
}

export default runAllTests;
export { deps };