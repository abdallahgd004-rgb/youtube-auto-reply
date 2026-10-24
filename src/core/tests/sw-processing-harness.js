// Service Worker Processing-Status Harness
//
// Test double for src/background/service-worker.js. It is deliberately NOT the real
// service worker: this harness reproduces the same call sequence with every dependency
// stubbed, so the counters and stages can be asserted deterministically without a
// browser extension, LM Studio or YouTube.
//
// What is verified here is the wiring — that each real processing point increments the
// right counter and sets the right stage. The pure state model itself is tested in
// processing-stats-tests.js.

import {
  STAGE,
  OUTCOME,
  getProcessingState,
  recordCommentDetected,
  recordStage,
  recordMatched,
  recordGenerated,
  recordSubmitted,
  recordFailedOrSkipped,
  handOffToContent,
  finishProcessing
} from '../processing-stats.js';
// The REAL semantic matcher, not an inlined imitation. The harness stubs the model
// call underneath it, so the production prompt-building and response-parsing are the
// code under test here — exactly as they run in the service worker.
import { semanticMatchTriggers, flattenTriggerPhrases } from '../semantic-matcher.js';
// Phase 19.6 — the REAL reply-mode resolver, so the harness decides fixed vs AI with the
// same code the service worker runs.
import { REPLY_MODES, resolveReplySource } from '../fixed-reply.js';
// Phase 19.7 — the REAL validator, so a test can exercise the actual repeat/blacklist
// rules rather than asserting against a stub's opinion of them.
import { validateReply } from '../reply-validator.js';

/**
 * Phase 19.8 — commentId → { fingerprint, dryRun } for a reply handed off but not finished.
 *
 * The service worker keeps the equivalent in `handoffFingerprints` so the content script's
 * terminal report can mark the comment handled on a real publish. It is reproduced here
 * because publishReply() is what plays the part of that report.
 */
const pendingHandled = new Map();

/** Stubbed dependencies, replaced per test case. */
const deps = {
  enabled: true,
  dryRun: false,
  triggers: [],
  // Phase 19.8 — the persistent handled store is a Map<id, record> here rather than the
  // Set it was, because it now has to carry the fingerprint that gets marked. This is the
  // store that is SUPPOSED to survive a page reload.
  handled: new Map(),
  hasGeneration: () => false,
  generate: async () => ({ text: 'reply' }),
  validate: { valid: true, reply: 'reply' },
  // Phase 19.7 — when true, run the REAL validateReply() with the same options the worker
  // builds, instead of trusting the `validate` stub above. The stub stays the default
  // because the existing processing-status suites assert pipeline wiring, not validation
  // rules, and switching them over would change what they are testing. Tests that are
  // ABOUT validation set this so the repeat/blacklist rules are the real ones.
  useRealValidator: false,
  recentReplies: [],
  blacklist: null,
  // Phase 19.8 — the in-memory handled-comment store, stubbed. `markHandled` is called by
  // the worker's publish-confirmation path, which this harness does not drive, so the
  // harness records the calls itself in publishReply().
  handled: new Map(),
  markHandledCalls: [],
  // Whether the last publishReply() should count as a real publish. Mirrors dry-run: the
  // worker's dryRun flag is carried on the handoff record.
  publishSucceeds: true,
  // Phase 19.6 — set by a test to prove that no AI generation call happened. The default
  // never throws, so a test that forgets to install a spy still passes the fixed-reply
  // cases and fails the AI ones loudly rather than silently.
  onGenerate: null,
  // Stands in for LM Studio's chatCompletion. Receives the real messages the real
  // matcher builds, and returns whatever raw text a test wants the parser to face.
  // The default answers MATCH on the first trigger phrase; individual tests override
  // it to produce NO_MATCH, malformed JSON, or a thrown error.
  complete: async (messages) => {
    const user = messages.find((m) => m.role === 'user');
    const phrase = /^- (.+)$/m.exec(user ? user.content : '');
    return {
      text: JSON.stringify({ matched: true, trigger: phrase ? phrase[1] : '' }),
      reasoning: ''
    };
  },
};

export function configure(next) {
  Object.assign(deps, next);
}

/** Forget in-flight handoffs. Called between test cases. */
export function resetPendingHandled() {
  pendingHandled.clear();
}

/**
 * Phase 19.6 — fixed-reply events, collected in the harness rather than printed.
 *
 * A test asserts on these, which is the point: the real worker emits them through
 * YTAR_DEVLOG, and the events exist to be read by a human debugging a "why did it not ask
 * the model?" question. Recording them here proves the branch emits them without a
 * console dependency.
 */
const diagEvents = [];

function diagLog(event, commentId, data) {
  diagEvents.push({ event, commentId, data });
}

/** Every fixed-reply diagnostic recorded since the last reset, oldest first. */
export function getDiagEvents() {
  return diagEvents.slice();
}

/** Forget recorded events. Called between test cases. */
export function resetDiagEvents() {
  diagEvents.length = 0;
}

/**
 * Process one COMMENT_DETECTED job, mirroring processJob() in service-worker.js
 * branch for branch.
 *
 * Returns the same `verdict`-shaped result the real worker sends to the content script.
 */
/**
 * Mark a comment handled — the persistent half of deduplication.
 *
 * Phase 19.8 — the store is keyed by FINGERPRINT, not by comment id, because that is what
 * survives a page reload in the real extension (see src/core/handled-comments.js).
 */
function markHandledStub(fingerprint) {
  deps.handled.set(fingerprint, { timestamp: Date.now() });
  deps.markHandledCalls.push(fingerprint);
}

export async function processJob({ id, text, fingerprint, pageSessionId = 'session-1' }) {
  if (!deps.enabled) {
    recordFailedOrSkipped();
    finishProcessing();
    return { success: true, id, result: 'DISABLED' };
  }

  if (deps.handled.has(fingerprint)) {
    recordFailedOrSkipped();
    finishProcessing();
    // Mirrors the worker's SKIP_ALREADY_HANDLED entry, so a test can prove the log
    // explains why a comment was skipped rather than just that it was.
    diagLog('SKIP_ALREADY_HANDLED', id, {
      reason: 'a reply was published for this comment in an earlier session',
      fingerprint
    });
    return { success: true, id, result: 'SKIP_ALREADY_HANDLED' };
  }

  // ── LM Studio decides the match (mirrors service-worker.js) ───────────────
  recordStage(STAGE.SEMANTIC_MATCHING);

  const verdict = { success: true, id };
  const { phrases, ruleIdByPhrase } = flattenTriggerPhrases(deps.triggers);

  if (phrases.length === 0) {
    verdict.result = 'NO_MATCH';
  } else {
    const decision = await semanticMatchTriggers({
      commentText: text,
      phrases,
      complete: deps.complete,
    });

    if (!decision.ok) {
      // Fail safe: no match, no reply, recorded as a failure. Mirrors the real
      // worker's error branch, which is what keeps one bad classification from
      // taking down the queue.
      recordStage(STAGE.ERROR);
      recordFailedOrSkipped();
      finishProcessing();
      return { success: false, id, error: `Semantic matching failed: ${decision.reason}` };
    }

    if (decision.matched) {
      verdict.result = 'MATCH';
      verdict.matchedPhrase = decision.trigger;
      verdict.ruleId = ruleIdByPhrase.get(decision.trigger) || '';
      // Phase 19.6 — the rule object travels with the verdict, exactly as it does in the
      // real worker, so the reply step reads replyMode/fixedReply off the matched rule.
      verdict.rule = deps.triggers.find((t) => t && t.id === verdict.ruleId) || null;
      recordMatched();
    } else {
      verdict.result = 'NO_MATCH';
    }
  }

  if (verdict.result === 'MATCH') {
    recordStage(STAGE.PREPARING_REPLY);

    // Phase 19.8 — scoped to the page session, mirroring service-worker.js. Keying on the bare
    // comment id is what made a page reload skip a comment the worker merely remembered.
    if (deps.hasGeneration(id, pageSessionId)) {
      recordFailedOrSkipped();
      finishProcessing();
      return { success: true, id, result: 'SKIP_SESSION_DUPLICATE' };
    }

    // Phase 19.6 — one decision, one effect: a fixed reply replaces the generation call
    // and nothing else. Validation, counters and the handoff below are shared.
    const replySource = resolveReplySource(verdict.rule);
    const isFixedReply = replySource.mode === REPLY_MODES.FIXED;

    try {
      let result;
      if (isFixedReply) {
        result = { text: replySource.text, reasoning: '' };
        diagLog('REPLY_MODE_FIXED', id, { replyMode: REPLY_MODES.FIXED, triggerId: verdict.ruleId || null, replyLength: result.text.length });
        diagLog('AI_REPLY_GENERATION_SKIPPED', id, { reason: 'the matched trigger uses a fixed reply', triggerId: verdict.ruleId || null });
      } else {
        recordStage(STAGE.WAITING_FOR_LM);
        if (typeof deps.onGenerate === 'function') deps.onGenerate();
        result = await deps.generate();
      }

      // Phase 19.7 — mirror the worker's validation call. The `allowRepeat` exemption is
      // driven by `isFixedReply`, the same flag the generation branch above decided, so a
      // fixed reply is exempt from the repeat check and an AI reply is not.
      const validation = deps.useRealValidator
        ? validateReply(
            { text: result.text, reasoning: result.reasoning },
            {
              blacklist: deps.blacklist ?? undefined,
              recentReplies: deps.recentReplies,
              allowRepeat: isFixedReply
            }
          )
        : deps.validate;

      if (!validation.valid) {
        recordStage(STAGE.ERROR);
        recordFailedOrSkipped();
        finishProcessing();
        return { success: false, id, error: `Invalid reply: ${validation.reason}` };
      }

      // Mirrors the worker: a fixed reply keeps its exact text, an AI reply takes the
      // validator's normalized value.
      verdict.reply = isFixedReply ? result.text : (validation.reply || result.text);
      recordGenerated();
      handOffToContent(id);

      // Phase 19.8 — remember the fingerprint for the publish-confirmation path instead of
      // marking handled here. Mirrors the worker's handoffFingerprints.
      if (verdict.reply) {
        pendingHandled.set(id, { fingerprint, dryRun: deps.dryRun === true });
      }
    } catch (_) {
      recordStage(STAGE.ERROR);
      recordFailedOrSkipped();
      finishProcessing();
      return { success: false, error: 'Generation failed' };
    }
  }

  if (verdict.result !== 'MATCH' || !verdict.reply) {
    finishProcessing();
  }
  return verdict;
}

/**
 * Handle one background message, mirroring the two processing-status actions in
 * handleMessage(). Returns the response object.
 */
export function handleMessage(message) {
  if (message.action === 'GET_PROCESSING_STATE') {
    return { success: true, state: getProcessingState() };
  }

  if (message.action === 'REPORT_PROCESSING_STAGE') {
    const { stage, outcome, commentId } = message;
    if (stage) {
      recordStage(stage);
    }
    if (outcome === OUTCOME.SUBMITTED) {
      recordSubmitted();
    } else if (outcome === OUTCOME.FAILED || outcome === OUTCOME.SKIPPED) {
      recordFailedOrSkipped();
    }
    if (outcome) {
      finishProcessing(commentId);
    }
    return { success: true };
  }

  return { status: 'ok' };
}

/**
 * Run the content script's posting steps for a generated reply, mirroring
 * handleMatchReply() in content/content.js, and report each stage to the harness
 * handler exactly as the content script sends it to the background.
 *
 * @param {Object} options
 * @param {string} options.id
 * @param {boolean} [options.dryRun]     - submitReply() returns false in dry-run
 * @param {boolean} [options.submitOk]   - submitReply() found and clicked the button
 * @param {boolean} [options.setTextOk]  - setReplyText() succeeded
 * @param {boolean} [options.openBoxOk]  - openReplyBox() returned an editor
 */
export async function publishReply({ id, dryRun = false, submitOk = true, setTextOk = true, openBoxOk = true }) {
  let finished = false;
  const finish = (stage, outcome) => {
    if (finished) return;
    finished = true;
    handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage, outcome, commentId: id });
  };

  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.PREPARING_REPLY, outcome: '', commentId: id });

  if (!openBoxOk) {
    finish(STAGE.ERROR, OUTCOME.FAILED);
    return;
  }
  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.OPENING_REPLY_BOX, outcome: '', commentId: id });

  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.INSERTING_REPLY, outcome: '', commentId: id });
  if (!setTextOk) {
    // Phase 19.8 — nothing was published, so nothing is marked handled. The comment stays
    // eligible for processing on the next page load.
    pendingHandled.delete(id);
    finish(STAGE.ERROR, OUTCOME.FAILED);
    return;
  }

  handleMessage({ action: 'REPORT_PROCESSING_STAGE', stage: STAGE.SUBMITTING_REPLY, outcome: '', commentId: id });

  // submitReply() returns false in dry-run without clicking anything, and also when the
  // submit button cannot be found. Both mean nothing was posted.
  const submitted = !dryRun && submitOk;
  if (!submitted) {
    // Phase 19.8 — a dry run or a failed submit must NOT persist the comment as handled.
    // This is the whole point of moving markHandled() off the generation path.
    pendingHandled.delete(id);
    finish(STAGE.IDLE, OUTCOME.SKIPPED);
    return;
  }

  // ── Phase 19.8: the ONLY path that marks a comment handled ──────────────────
  // A real submit. Mirrors markHandledIfPublished(): the entry is consumed whether or not
  // it leads to a record, and a dry run explicitly does not write one.
  const entry = pendingHandled.get(id);
  pendingHandled.delete(id);
  if (entry && entry.fingerprint && !entry.dryRun) {
    markHandledStub(entry.fingerprint);
  }

  finish(STAGE.COMPLETED, OUTCOME.SUBMITTED);
}

export { deps };