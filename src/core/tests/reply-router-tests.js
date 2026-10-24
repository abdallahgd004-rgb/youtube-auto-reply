/**
 * Hybrid Mode Tests — Phase 20.15
 *
 * §26 has six rules and the tests are written as one per rule, because the ordering and the
 * fixed-reply protection are the whole milestone.
 *
 * The central test is NEGATIVE: that `runKnowledge` is never CALLED after a trigger match.
 * Asserting on the outcome alone would pass even if knowledge ran and its answer were then
 * discarded — which is the bug shape this milestone exists to make impossible. So the spies
 * count invocations, not just results.
 *
 * §38 Test 7 (fallback) and Test 8 (no answer) are the acceptance cases, used verbatim.
 *
 * Runs in the browser from reply-router-tests.html. No chrome stub, no model: both paths are
 * injected, which is what lets the ordering be tested at all.
 */

import {
  routeComment,
  ROUTE_SOURCE,
  ROUTE_REASON,
  ROUTE
} from '../reply-router.js';

import { REPLY_MODE, describeReplyMode } from '../reply-modes.js';

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

/** A trigger implementation that reports the given verdict, counting calls. */
function matcher(verdict) {
  const spy = { calls: 0 };
  spy.fn = async () => {
    spy.calls++;
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
  return spy;
}

/** A knowledge implementation that reports the given outcome, counting calls. */
function knowledgeRun(outcome) {
  const spy = { calls: 0 };
  spy.fn = async () => {
    spy.calls++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return spy;
}

const MATCHED = { ok: true, matched: true, ruleId: 'r1', reply: 'trigger reply' };
const NO_MATCH = { ok: true, matched: false, reason: 'no_match' };
const FAILED = { ok: false, matched: false, reason: 'LM Studio call failed' };

const ANSWERED = { reply: 'knowledge reply', status: 'PUBLISHABLE' };
const NO_ANSWER = { reply: '', status: 'NO_SUPPORTED_ANSWER', code: 'NO_SUPPORTED_ANSWER', reason: 'no duration' };

// ── §38 Test 7 — hybrid fallback ──────────────────────────────────────────────

async function testHybridFallsBackToKnowledge() {
  // Test 7: no trigger match, answerable from knowledge.
  const trigger = matcher(NO_MATCH);
  const knowledge = knowledgeRun(ANSWERED);

  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: trigger.fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.KNOWLEDGE) return `route was ${outcome.route}: ${outcome.reason}`;
  if (outcome.reply !== 'knowledge reply') return `reply was ${outcome.reply}`;
  if (outcome.reason !== ROUTE_REASON.KNOWLEDGE_FALLBACK) return `reason was ${outcome.reason}`;
  if (trigger.calls !== 1) return `the trigger ran ${trigger.calls} times`;
  if (knowledge.calls !== 1) return `knowledge ran ${knowledge.calls} times`;
  return true;
}

async function testHybridSkipsWhenKnowledgeCannotAnswer() {
  // Test 8: no trigger match, knowledge cannot support an answer.
  const knowledge = knowledgeRun(NO_ANSWER);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  if (outcome.reply !== '') return 'a reply survived a skip';
  if (outcome.reason !== ROUTE_REASON.KNOWLEDGE_NO_ANSWER) return `reason was ${outcome.reason}`;
  // §31's distinction: the pipeline's own code and reason are carried through, so the UI can
  // tell "the knowledge has no answer" from "the model failed".
  if (outcome.knowledge?.code !== 'NO_SUPPORTED_ANSWER') return `the code was lost: ${JSON.stringify(outcome.knowledge)}`;
  if (outcome.knowledge?.reason !== 'no duration') return 'the pipeline reason was lost';
  return true;
}

// ── §26 rules 1, 4 and 5 — a match ends it ────────────────────────────────────

async function testAMatchStopsEverything() {
  // Rule 1. And the CENTRAL assertion of this file: knowledge is not merely unused, it is
  // never called. Asserting on the outcome alone would pass even if it ran and its answer were
  // discarded afterwards.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(MATCHED).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.TRIGGER) return `route was ${outcome.route}`;
  if (outcome.reply !== 'trigger reply') return `reply was ${outcome.reply}`;
  if (knowledge.calls !== 0) return `the knowledge pipeline ran ${knowledge.calls} time(s) after a trigger match`;
  if (outcome.knowledgeEntered) return 'knowledgeEntered is true after a trigger match';
  return true;
}

async function testKnowledgeCannotOverrideAFixedReply() {
  // Rules 4 and 5. A fixed reply is the one the user wrote out by hand, so it must survive
  // even a perfectly good knowledge answer. There is no priority comparison here that could
  // get this wrong: knowledge is never reached.
  for (const ruleId of ['fixed-1', 'fixed-2']) {
    const knowledge = knowledgeRun(ANSWERED);
    const outcome = await routeComment({
      mode: REPLY_MODE.HYBRID,
      matchTrigger: matcher({ ok: true, matched: true, ruleId, isFixed: true, reply: 'FIXED REPLY' }).fn,
      runKnowledge: knowledge.fn
    });

    if (outcome.reply !== 'FIXED REPLY') return `the reply became "${outcome.reply}"`;
    if (outcome.route !== ROUTE_SOURCE.TRIGGER) return `route was ${outcome.route}`;
    if (knowledge.calls !== 0) return 'knowledge ran alongside a fixed reply';
  }
  return true;
}

async function testTheTriggerVerdictIsPassedThroughUnchanged() {
  // §26 rule 6: the existing implementation owns matching and the precedence between
  // multiple matches, so this module must not reshape or reconstruct its verdict.
  const knowledge = knowledgeRun(ANSWERED);
  const verdict = { ok: true, matched: true, ruleId: 'r9', reply: 'x', priority: 3, extra: { kept: true } };
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(verdict).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.trigger !== verdict) return 'the verdict was replaced rather than forwarded';
  if (outcome.trigger.extra?.kept !== true) return 'fields were dropped from the verdict';
  return true;
}

async function testTriggerModeNeverReachesKnowledge() {
  // §25: Trigger Mode is the existing system, unchanged.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.TRIGGER,
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  if (outcome.reason !== ROUTE_REASON.NO_TRIGGER_MATCH) return `reason was ${outcome.reason}`;
  if (knowledge.calls !== 0) return 'the knowledge pipeline ran in Trigger Mode';
  return true;
}

async function testKnowledgeModeNeverRunsTheTrigger() {
  const trigger = matcher(MATCHED);
  const outcome = await routeComment({
    mode: REPLY_MODE.KNOWLEDGE,
    matchTrigger: trigger.fn,
    runKnowledge: knowledgeRun(ANSWERED).fn
  });

  if (trigger.calls !== 0) return `the trigger ran ${trigger.calls} time(s) in Knowledge Mode`;
  if (outcome.route !== ROUTE_SOURCE.KNOWLEDGE) return `route was ${outcome.route}`;
  return true;
}

// ── A failed classification is not a miss ──────────────────────────────────────

async function testAFailedTriggerDoesNotFallThrough() {
  // The dangerous alternative: treating `ok:false` as "no trigger matched" would send every
  // comment to the knowledge base, so an unreachable LM Studio would silently change the
  // extension's whole behaviour.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(FAILED).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  if (outcome.reason !== ROUTE_REASON.TRIGGER_FAILED) return `reason was ${outcome.reason}`;
  if (knowledge.calls !== 0) return 'a failed classification fell through to knowledge';
  return true;
}

async function testAThrownMatcherDoesNotFallThrough() {
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(new Error('boom')).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  if (outcome.reason !== ROUTE_REASON.TRIGGER_FAILED) return `reason was ${outcome.reason}`;
  if (knowledge.calls !== 0) return 'a thrown matcher fell through to knowledge';
  return true;
}

async function testAGenuineNoMatchDoesFallThrough() {
  // The distinction from the two tests above: only a real NO_MATCH may reach knowledge.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledge.fn
  });
  if (knowledge.calls !== 1) return 'a genuine no-match did not reach knowledge';
  if (outcome.route !== ROUTE_SOURCE.KNOWLEDGE) return `route was ${outcome.route}`;
  return true;
}

async function testAVerdictIsNeverReadAsAMatch() {
  // `matched: true` with `ok: false` is a contradictory verdict. Reading the match out of it
  // would let a failed classification produce a reply, which is the failure mode
  // `parseSemanticMatchResult` already guards against on the parsing side.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher({ ok: false, matched: true, reply: 'should not be used' }).fn,
    runKnowledge: knowledge.fn
  });

  if (outcome.route === ROUTE_SOURCE.TRIGGER) return 'a failed verdict produced a trigger reply';
  if (outcome.reply === 'should not be used') return 'a failed verdict\'s reply was used';
  return true;
}

// ── Robustness ────────────────────────────────────────────────────────────────

async function testAMissingKnowledgeRunnerIsAMisconfiguration() {
  for (const mode of [REPLY_MODE.HYBRID, REPLY_MODE.KNOWLEDGE]) {
    const outcome = await routeComment({
      mode,
      matchTrigger: matcher(NO_MATCH).fn
    });
    if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `${mode} → ${outcome.route}`;
    if (outcome.reason !== ROUTE_REASON.MISCONFIGURED) return `${mode} reason was ${outcome.reason}`;
  }
  return true;
}

async function testAMissingMatcherIsAMisconfiguration() {
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: REPLY_MODE.HYBRID,
    runKnowledge: knowledge.fn
  });
  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  if (outcome.reason !== ROUTE_REASON.MISCONFIGURED) return `reason was ${outcome.reason}`;
  if (knowledge.calls !== 0) return 'knowledge ran without a verdict to justify it';
  return true;
}

async function testAThrowingKnowledgeRunnerSkipsRatherThanReplies() {
  // `runKnowledge` is written to be total, but the router promises NEVER to reject and that has
  // to hold for an injected implementation it does not control. A throw becomes a reported
  // skip, and it must not escape as an exception.
  for (const mode of [REPLY_MODE.HYBRID, REPLY_MODE.KNOWLEDGE]) {
    let outcome;
    try {
      outcome = await routeComment({
        mode,
        matchTrigger: matcher(NO_MATCH).fn,
        runKnowledge: knowledgeRun(new Error('boom')).fn
      });
    } catch (error) {
      return `the router rejected for a thrown knowledge call: ${error.message}`;
    }
    if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `${mode} → ${outcome.route}`;
    if (outcome.reply !== '') return `${mode} produced a reply from a thrown call`;
    if (outcome.reason !== ROUTE_REASON.KNOWLEDGE_FAILED) return `${mode} reason was ${outcome.reason}`;
    if (!/threw/.test(outcome.knowledge?.reason || '')) return `${mode} lost the error text`;
  }
  return true;
}

async function testAnUnrecognisedModeBehavesLikeTrigger() {
  // A bad stored mode must not reach knowledge: `trigger` is the recoverable direction, and
  // this router inherits that from `describeReplyMode()`.
  const knowledge = knowledgeRun(ANSWERED);
  const outcome = await routeComment({
    mode: 'knowledge-ish',
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledge.fn
  });
  if (knowledge.calls !== 0) return 'an unrecognised mode reached the knowledge pipeline';
  if (outcome.route !== ROUTE_SOURCE.SKIPPED) return `route was ${outcome.route}`;
  return true;
}

async function testRoutingNeverThrows() {
  for (const args of [
    {},
    { mode: null },
    { mode: REPLY_MODE.HYBRID },
    { mode: REPLY_MODE.HYBRID, matchTrigger: null, runKnowledge: null },
    { mode: REPLY_MODE.HYBRID, matchTrigger: 42, runKnowledge: 42 },
    { mode: REPLY_MODE.KNOWLEDGE, runKnowledge: async () => undefined },
    { mode: REPLY_MODE.KNOWLEDGE, runKnowledge: async () => null },
    { mode: REPLY_MODE.HYBRID, matchTrigger: async () => undefined, runKnowledge: async () => ({ reply: 'x' }) }
  ]) {
    const outcome = await routeComment(args);
    if (!outcome || !outcome.route || !outcome.reason) {
      throw new Error(`${JSON.stringify(args)} → ${JSON.stringify(outcome)}`);
    }
    if (typeof outcome.reply !== 'string') throw new Error('reply is not a string');
    if (typeof outcome.knowledgeEntered !== 'boolean') throw new Error('knowledgeEntered is missing');
  }
  return true;
}

async function testEveryOutcomeHasOneShape() {
  const outcomes = await Promise.all([
    routeComment({ mode: REPLY_MODE.HYBRID, matchTrigger: matcher(MATCHED).fn, runKnowledge: knowledgeRun(ANSWERED).fn }),
    routeComment({ mode: REPLY_MODE.HYBRID, matchTrigger: matcher(NO_MATCH).fn, runKnowledge: knowledgeRun(ANSWERED).fn }),
    routeComment({ mode: REPLY_MODE.HYBRID, matchTrigger: matcher(NO_MATCH).fn, runKnowledge: knowledgeRun(NO_ANSWER).fn }),
    routeComment({ mode: REPLY_MODE.HYBRID, matchTrigger: matcher(FAILED).fn, runKnowledge: knowledgeRun(ANSWERED).fn }),
    routeComment({ mode: REPLY_MODE.TRIGGER, matchTrigger: matcher(NO_MATCH).fn }),
    routeComment({ mode: REPLY_MODE.KNOWLEDGE, runKnowledge: knowledgeRun(ANSWERED).fn })
  ]);

  const shapes = new Set(outcomes.map((o) => Object.keys(o).sort().join(',')));
  if (shapes.size !== 1) throw new Error(`shapes differ: ${[...shapes].join(' | ')}`);

  for (const outcome of outcomes) {
    if (outcome.route !== ROUTE_SOURCE.SKIPPED && outcome.reply === '') {
      throw new Error(`${outcome.route} carries no reply`);
    }
    if (outcome.route === ROUTE_SOURCE.SKIPPED && outcome.reply !== '') {
      throw new Error(`a skip carried the reply "${outcome.reply}"`);
    }
  }
  return true;
}

async function testTheRoutesAgreeWithTheDescriptor() {
  // The router must follow `describeReplyMode()`, not its own idea of each mode — otherwise
  // the descriptor 20.14 publishes stops being the contract.
  const knowledge = knowledgeRun(ANSWERED);
  const described = describeReplyMode(REPLY_MODE.HYBRID);
  if (!described.knowledgeOnlyAfterNoMatch) return 'Hybrid lost its ordering rule';

  const matched = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(MATCHED).fn,
    runKnowledge: knowledgeRun(ANSWERED).fn
  });
  if (matched.route !== ROUTE_SOURCE.TRIGGER) return 'the descriptor and the router disagree on a match';

  const missed = await routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledgeRun(ANSWERED).fn
  });
  if (missed.route !== ROUTE_SOURCE.KNOWLEDGE) return 'the descriptor and the router disagree on a miss';
  return true;
}

async function testRoutingIsDeterministic() {
  const build = () => routeComment({
    mode: REPLY_MODE.HYBRID,
    matchTrigger: matcher(NO_MATCH).fn,
    runKnowledge: knowledgeRun(ANSWERED).fn
  });
  const a = await build();
  const b = await build();
  if (a.route !== b.route || a.reason !== b.reason || a.reply !== b.reply) {
    return 'the same inputs produced different routes';
  }
  return true;
}

async function testTheRouteAliasIsTheSourceVocabulary() {
  // `ROUTE` is exported as an alias; two names for one vocabulary invite a caller to mix them.
  if (ROUTE !== ROUTE_SOURCE) return 'ROUTE and ROUTE_SOURCE are different objects';
  return true;
}

export default async function runAllTests() {
  await runTest('§38 Test 7 — hybrid falls back to knowledge', testHybridFallsBackToKnowledge);
  await runTest('§38 Test 8 — hybrid skips when knowledge cannot answer', testHybridSkipsWhenKnowledgeCannotAnswer);

  await runTest('a trigger match ends it, and knowledge is never called', testAMatchStopsEverything);
  await runTest('knowledge cannot override a fixed reply (§26 rules 4-5)', testKnowledgeCannotOverrideAFixedReply);
  await runTest('the trigger verdict is passed through unchanged (§26 rule 6)', testTheTriggerVerdictIsPassedThroughUnchanged);
  await runTest('Trigger Mode never reaches knowledge', testTriggerModeNeverReachesKnowledge);
  await runTest('Knowledge Mode never runs the trigger', testKnowledgeModeNeverRunsTheTrigger);

  await runTest('a failed trigger does not fall through', testAFailedTriggerDoesNotFallThrough);
  await runTest('a thrown matcher does not fall through', testAThrownMatcherDoesNotFallThrough);
  await runTest('a genuine no-match does fall through', testAGenuineNoMatchDoesFallThrough);
  await runTest('a verdict is never read as a match', testAVerdictIsNeverReadAsAMatch);

  await runTest('a missing knowledge runner is a misconfiguration', testAMissingKnowledgeRunnerIsAMisconfiguration);
  await runTest('a missing matcher is a misconfiguration', testAMissingMatcherIsAMisconfiguration);
  await runTest('a throwing knowledge runner skips rather than replies', testAThrowingKnowledgeRunnerSkipsRatherThanReplies);
  await runTest('an unrecognised mode behaves like Trigger', testAnUnrecognisedModeBehavesLikeTrigger);

  await runTest('routing never throws', testRoutingNeverThrows);
  await runTest('every outcome has one shape', testEveryOutcomeHasOneShape);
  await runTest('the routes agree with the descriptor', testTheRoutesAgreeWithTheDescriptor);
  await runTest('routing is deterministic', testRoutingIsDeterministic);
  await runTest('the route alias is the source vocabulary', testTheRouteAliasIsTheSourceVocabulary);

  return results;
}