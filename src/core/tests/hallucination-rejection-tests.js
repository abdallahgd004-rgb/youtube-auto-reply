/**
 * Hallucination Rejection Tests — Phase 20.11
 *
 * §17 is a small milestone with one hard requirement — "Never allow an endless retry loop" —
 * and one behaviour that is easy to get subtly wrong. So the tests are mostly about the BOUND:
 * that it cannot be raised, that it stops early when retrying cannot help, that only grounding
 * rejections are retried at all, and that every exhausted path reports §17's skip rather than
 * a reply someone might post by accident.
 *
 * The fake model is scripted so a rejection can be made to persist, which is what makes the
 * bound observable rather than theoretical.
 *
 * Runs in the browser from hallucination-rejection-tests.html. No chrome stub, no network:
 * `complete` is injected.
 */

import {
  generateAndValidateGrounded,
  buildCorrectionNotes,
  evidenceForRetry,
  REPLY_STATUS,
  HARD_MAX_ATTEMPTS,
  REGENERATION_DEFAULTS
} from '../hallucination-rejection.js';

import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip, categorizeKnowledgeError, ERROR_CATEGORY } from '../knowledge-schema.js';
import { GROUNDING_STATUS } from '../grounding-validator.js';

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

const COMMENT = 'هو تمن كتاب الكيمياء إيه؟';

function approved() {
  return [
    { evidenceId: 'KNOWLEDGE-PRICE', documentId: 'doc-a', filename: 'books/chemistry.md', headingPath: ['السعر'], content: 'السعر الحالي: 350 جنيه.' },
    { evidenceId: 'KNOWLEDGE-COVERAGE', documentId: 'doc-a', filename: 'books/chemistry.md', headingPath: ['التغطية'], content: 'يغطي التفوق الدوال والتفاعلات.' }
  ];
}

const shape = (reply, evidence = []) => JSON.stringify({ reply, evidence });

/**
 * A completion function driven by a script of replies.
 *
 * `validators` answers the grounding CHECK call; `generations` answers the generation call.
 * Both are scripted so a rejection can be made to persist across attempts, which is what makes
 * the bound observable rather than theoretical.
 */
function scripted({ generations, validators }) {
  const calls = { generation: 0, validation: 0 };
  const prompts = { generations: [], validators: [] };

  const complete = async (messages, options) => {
    const operation = options && options.operation;
    const text = messages.map((m) => m.content).join('\n');

    if (operation === 'GROUNDING_CHECK') {
      calls.validation++;
      prompts.validators.push(text);
      return { text: validators.shift() ?? '{"supported":true}' };
    }

    calls.generation++;
    prompts.generations.push(text);
    const reply = generations.shift();
    if (reply === undefined) throw new Error('the scripted model ran out of replies');
    return { text: shape(reply, evidenceFor(text)) };
  };

  // Cite the section whose heading appears in the prompt, so narrowing is exercised.
  const evidenceFor = (text) => {
    const ids = [];
    for (const section of approved()) {
      const heading = section.headingPath.join('');
      if (text.includes(heading)) ids.push(section.evidenceId);
    }
    return ids;
  };

  return { complete, calls, prompts };
}

// ─── §17's happy path ─────────────────────────────────────────────────────────

async function testAGroundedReplyIsReturnedOnTheFirstAttempt() {
  const model = scripted({ generations: ['الكتاب بـ350 جنيه.'], validators: ['{"supported":true}'] });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.PUBLISHABLE) return `status ${outcome.status}: ${outcome.reason}`;
  if (outcome.reply !== 'الكتاب بـ350 جنيه.') return `reply was ${outcome.reply}`;
  if (outcome.attempts !== 1) return `attempts was ${outcome.attempts}`;
  if (outcome.code) return 'a publishable reply carried an error code';
  return true;
}

async function testARejectedReplyIsRegeneratedAndCanSucceed() {
  // §17: first generation → validation failed → regenerate → validate again.
  // Only ONE scripted model verdict. The first attempt is rejected by the DETERMINISTIC layer
  // before the model is ever asked, so scripting a model rejection there would leave it
  // unconsumed and the retry would read it as its own verdict.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه والشحن خلال يومين.', 'الكتاب بـ350 جنيه.'],
    validators: ['{"supported":true}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.PUBLISHABLE) return `status ${outcome.status}: ${outcome.reason}`;
  if (outcome.reply !== 'الكتاب بـ350 جنيه.') return `reply was ${outcome.reply}`;
  if (outcome.attempts !== 2) return `attempts was ${outcome.attempts}`;
  if (model.calls.generation !== 2) return `generation calls were ${model.calls.generation}`;
  if (outcome.history.length !== 2) return `history had ${outcome.history.length} entries`;
  if (outcome.history[0].outcome !== GROUNDING_STATUS.UNSUPPORTED) return `first verdict was ${outcome.history[0].outcome}`;
  return true;
}

// ─── The bound ────────────────────────────────────────────────────────────────

async function testAnEndlesslyFailingModelIsStopped() {
  // The whole point of §17. Each generation is DIFFERENT so the early-repeat exit cannot fire
  // — the loop must terminate on its own.
  const generations = [];
  for (let i = 0; i < 20; i++) generations.push(`الكتاب بـ${400 + i} جنيه.`);
  const validators = [];
  for (let i = 0; i < 20; i++) validators.push('{"supported":false,"reason":"invented price"}');

  const model = scripted({ generations, validators });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.REJECTED) return `status was ${outcome.status}`;
  if (outcome.attempts !== REGENERATION_DEFAULTS.maxAttempts) return `attempts was ${outcome.attempts}`;
  if (model.calls.generation > HARD_MAX_ATTEMPTS) {
    return `${model.calls.generation} generation calls for one comment`;
  }
  if (outcome.reply !== '') return 'a rejected reply was returned as publishable';
  return true;
}

async function testTheBoundCannotBeRaised() {
  // §17's requirement is that safety beats forcing a reply, so the ceiling is a constant. If
  // the bound were only a default, one caller passing a large value would reintroduce the
  // unlimited loop the milestone exists to forbid.
  const generations = [];
  for (let i = 0; i < 50; i++) generations.push(`الكتاب بـ${400 + i} جنيه.`);
  const validators = [];
  for (let i = 0; i < 50; i++) validators.push('{"supported":false}');

  for (const requested of [1, 2, 3, 4, 5, 25, 1000, Infinity, -1, 0, null, 'lots', NaN, {}]) {
    const model = scripted({ generations: [...generations], validators: [...validators] });
    const outcome = await generateAndValidateGrounded({
      commentText: COMMENT,
      evidence: approved(),
      complete: model.complete,
      options: { maxAttempts: requested }
    });

    if (model.calls.generation > HARD_MAX_ATTEMPTS) {
      return `maxAttempts=${requested} produced ${model.calls.generation} calls`;
    }
    if (outcome.attempts > HARD_MAX_ATTEMPTS) return `maxAttempts=${requested} reported ${outcome.attempts} attempts`;
    if (outcome.status === REPLY_STATUS.PUBLISHABLE) return `maxAttempts=${requested} published a rejected reply`;
  }
  return true;
}

async function testTheBoundCanBeLowered() {
  // A caller must be able to spend one attempt and stop, for cost or for a stricter policy.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ350 جنيه.'],
    validators: ['{"supported":false}', '{"supported":true}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: approved(),
    complete: model.complete,
    options: { maxAttempts: 1 }
  });

  if (outcome.status !== REPLY_STATUS.REJECTED) return `status was ${outcome.status}`;
  if (outcome.attempts !== 1) return `attempts was ${outcome.attempts}`;
  if (model.calls.generation !== 1) return `generation calls were ${model.calls.generation}`;
  return true;
}

async function testARepeatedReplyStopsEarly() {
  // The model returns the same rejected text twice. The same text fails the same way, so the
  // remaining attempts cannot help — spending them only buys the same verdict.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ400 جنيه.', 'الكتاب بـ350 جنيه.'],
    validators: ['{"supported":false}', '{"supported":false}', '{"supported":true}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.REPEATED) return `status was ${outcome.status}`;
  if (outcome.attempts !== 2) return `attempts was ${outcome.attempts}`;
  if (model.calls.generation !== 2) return `generation calls were ${model.calls.generation}`;
  if (outcome.reply !== '') return 'a rejected reply was returned';
  if (!/repeated/i.test(outcome.reason)) return `reason was ${outcome.reason}`;
  return true;
}

async function testARepeatIsDetectedThroughCosmeticDifferences() {
  // Two attempts differing only in spacing are the same reply, and comparing them must fold
  // whitespace and Arabic diacritics or the early exit never fires.
  const model = scripted({
    generations: ['الكتاب  بـ350   جنيه و الشحن خلال يومين.', 'الكتاب بـ350 جنيه و الشحن خلال يومين.'],
    validators: ['{"supported":false}', '{"supported":false}', '{"supported":true}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.REPEATED) return `status was ${outcome.status}`;
  if (model.calls.generation !== 2) return `generation calls were ${model.calls.generation}`;
  return true;
}

// ─── What is retried, and what is not ─────────────────────────────────────────

async function testAValidatorFailureIsNotRegenerated() {
  // The validator could not be read. That is our failure, not the answer's, and a second full
  // round of calls lands in the same place — on an outage it does it for nothing.
  const model = scripted({
    generations: ['الكتاب بـ350 جنيه.', 'الكتاب بـ350 جنيه.'],
    validators: ['garbage']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (model.calls.generation !== 1) return `generation calls were ${model.calls.generation}`;
  if (outcome.status !== REPLY_STATUS.FAILED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testAGenerationFailureIsNotRegenerated() {
  // §17 asks for regeneration after a VALIDATION failure. A model that did not return §15's
  // shape is a different problem, and retrying it turns a formatting blip into a loop.
  let calls = 0;
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: approved(),
    complete: async () => { calls++; return { text: 'not json at all' }; }
  });

  if (calls !== 1) return `generation calls were ${calls}`;
  if (outcome.status !== REPLY_STATUS.FAILED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.GENERATION_FAILED) return `code was ${outcome.code}`;
  return true;
}

// ─── §17's skip ───────────────────────────────────────────────────────────────

async function testAnExhaustedSkipIsASafetyFailureNotAHealthySkip() {
  // §24's NO_SUPPORTED_ANSWER is the feature working. A hallucination that survived
  // regeneration is NOT: it is a SAFETY rejection, and the user should see it.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ450 جنيه.'],
    validators: ['{"supported":false}', '{"supported":false}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.status !== REPLY_STATUS.REJECTED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED) return `code was ${outcome.code}`;
  if (isExpectedKnowledgeSkip(outcome.code)) return 'an exhausted hallucination counts as a healthy skip';
  if (categorizeKnowledgeError(outcome.code) !== ERROR_CATEGORY.SAFETY) {
    return `bucket was ${categorizeKnowledgeError(outcome.code)}`;
  }
  if (outcome.reply !== '') return 'a rejected reply survived into the result';
  return true;
}

async function testOnlyAPublishableOutcomeCarriesAReply() {
  // A caller that posts `reply` without checking `status` would post a rejected reply, so the
  // string must be empty everywhere except the one status that permits it.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ450 جنيه.'],
    validators: ['{"supported":false}', '{"supported":false}']
  });
  const rejected = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  const broken = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ400 جنيه.'],
    validators: ['{"supported":false}', '{"supported":false}']
  });
  const repeated = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: broken.complete
  });

  const failed = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: async () => ({ text: 'nope' })
  });

  for (const outcome of [rejected, repeated, failed]) {
    if (outcome.status !== REPLY_STATUS.PUBLISHABLE && outcome.reply !== '') {
      return `${outcome.status} carried a reply`;
    }
  }
  return true;
}

async function testTheAttemptCountIsReportedForRateLimiting() {
  // Every attempt is a fresh generation plus up to two validation calls, so a caller budgeting
  // one call per comment would let a batch of hallucinating comments spend several times the
  // configured cap without any of it being visible.
  const model = scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ350 جنيه.'],
    validators: ['{"supported":false}', '{"supported":true}']
  });
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT, evidence: approved(), complete: model.complete
  });

  if (outcome.attempts !== 2) return `attempts was ${outcome.attempts}`;
  if (outcome.history.length !== outcome.attempts) return `history had ${outcome.history.length} for ${outcome.attempts} attempts`;
  if (outcome.history.some((h) => typeof h.attempt !== 'number')) return 'a history entry has no attempt number';
  return true;
}

// ─── The retry gets less to work with, and told what it did ───────────────────

async function testTheRetryKeepsTheWholeApprovedEvidenceSet() {
  // §17 says "regenerate with stricter evidence", and the obvious reading is to hand the retry
  // fewer sections. That starves it: the previous reply got the price right from a section it
  // did NOT cite, so dropping uncited sections turns a correctly-sourced figure into an
  // unsupported number in the next prompt — and the comment is skipped after a rejection the
  // narrowing itself caused. Same trap as 20.9 validating against citations only.
  const prompts = [];
  let call = 0;
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: approved(),
    complete: async (messages, options) => {
      if (options.operation === 'GROUNDING_CHECK') return { text: '{"supported":true}' };
      call++;
      prompts.push(messages.map((m) => m.content).join('\n'));
      return {
        text: shape(
          call === 1 ? 'الكتاب بـ350 جنيه والشحن خلال يومين.' : 'الكتاب بـ350 جنيه.',
          call === 1 ? ['KNOWLEDGE-COVERAGE'] : []
        )
      };
    }
  });

  if (outcome.status !== REPLY_STATUS.PUBLISHABLE) return `status ${outcome.status}: ${outcome.reason}`;
  if (prompts.length !== 2) return `${prompts.length} generation prompts`;
  for (const id of ['KNOWLEDGE-PRICE', 'KNOWLEDGE-COVERAGE']) {
    if (!prompts[1].includes(id)) return `the retry lost ${id}`;
  }
  return true;
}

async function testEvidenceForRetryIsTotal() {
  for (const input of [null, undefined, 42, [], [null], approved()]) {
    const result = evidenceForRetry(input);
    if (!Array.isArray(result)) return `evidenceForRetry(${JSON.stringify(input)}) threw`;
  }
  if (evidenceForRetry(approved()).length !== 2) return 'the approved set was not returned whole';
  return true;
}


async function testTheRetryIsToldWhatItGotWrong() {
  // Concrete beats generic: a retry told only to be stricter tends to produce a
  // differently-worded wrong answer, which fails validation again and burns the next attempt.
  let retryPrompt = '';
  let call = 0;
  await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: approved(),
    complete: async (messages, options) => {
      if (options.operation === 'GROUNDING_CHECK') {
        return { text: call === 1 ? '{"supported":false,"reason":"the knowledge does not state 400"}' : '{"supported":true}' };
      }
      call++;
      if (call === 2) retryPrompt = messages.map((m) => m.content).join('\n');
      return { text: shape(call === 1 ? 'الكتاب بـ400 جنيه.' : 'الكتاب بـ350 جنيه.', []) };
    }
  });

  if (!retryPrompt) return 'no retry prompt was captured';
  if (!/previous attempt was rejected/i.test(retryPrompt)) return 'the retry was not told it was a retry';
  if (!/400/.test(retryPrompt)) return 'the retry was not told which figure was wrong';
  if (!/350/.test(retryPrompt)) return 'the retry lost the knowledge it still needs';
  return true;
}

async function testTheFirstAttemptIsNotToldAboutAPreviousFailure() {
  let firstPrompt = '';
  let call = 0;
  await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: approved(),
    complete: async (messages, options) => {
      if (options.operation === 'GROUNDING_CHECK') return { text: '{"supported":true}' };
      call++;
      if (call === 1) firstPrompt = messages.map((m) => m.content).join('\n');
      return { text: shape('الكتاب بـ350 جنيه.', []) };
    }
  });

  if (/previous attempt was rejected/i.test(firstPrompt)) return 'the first attempt was told about a failure that had not happened';
  return true;
}

async function testCorrectionNotesPreferTheValidatorsOwnWords() {
  const notes = buildCorrectionNotes({
    unsupported: [{ kind: 'number', value: '400' }],
    modelUnsupported: ['availability in all bookstores'],
    reason: 'the knowledge does not state the number 400'
  });

  const joined = notes.join('\n');
  if (!/400/.test(joined)) return `the number is missing: ${joined}`;
  if (!/availability in all bookstores/.test(joined)) return `the model's claim is missing: ${joined}`;
  if (!/does not state the number 400/.test(joined)) return `the validator's reason is missing: ${joined}`;

  // A verdict with NOTHING wrong in it legitimately produces nothing to correct — an empty
  // list is the honest answer, and inventing a note would put a false accusation in the retry
  // prompt. It must still never throw.
  for (const empty of [null, undefined, {}, { unsupported: [], modelUnsupported: [], reason: '' }]) {
    const result = buildCorrectionNotes(empty);
    if (!Array.isArray(result)) return `buildCorrectionNotes(${JSON.stringify(empty)}) threw`;
    if (result.length !== 0) return `buildCorrectionNotes(${JSON.stringify(empty)}) invented notes: ${result}`;
  }

  // A verdict with only a reason still says something useful.
  if (buildCorrectionNotes({ reason: 'the knowledge does not state it' }).length === 0) {
    return 'a reason-only verdict produced no notes';
  }
  return true;
}

async function testItNeverThrows() {
  for (const args of [
    {},
    { commentText: null, evidence: null },
    { commentText: COMMENT },
    { commentText: COMMENT, evidence: approved(), complete: 42 },
    { commentText: COMMENT, evidence: approved(), complete: async () => null },
    { commentText: COMMENT, evidence: approved(), options: { maxAttempts: 'two' } },
    { commentText: COMMENT, evidence: approved(), options: null }
  ]) {
    const outcome = await generateAndValidateGrounded(args);
    if (!outcome || !outcome.status) throw new Error(`${JSON.stringify(args)} → ${JSON.stringify(outcome)}`);
    if (!Array.isArray(outcome.history)) throw new Error(`${JSON.stringify(args)} → no history`);
  }
  return true;
}

async function testEveryOutcomeHasOneShape() {
  const mk = async (generations, validators) => {
    const model = scripted({ generations, validators });
    return generateAndValidateGrounded({ commentText: COMMENT, evidence: approved(), complete: model.complete });
  };

  const outcomes = await Promise.all([
    mk(['الكتاب بـ350 جنيه.'], ['{"supported":true}']),
    mk(['الكتاب بـ400 جنيه.', 'الكتاب بـ450 جنيه.'], ['{"supported":false}', '{"supported":false}']),
    mk(['الكتاب بـ400 جنيه.', 'الكتاب بـ400 جنيه.'], ['{"supported":false}', '{"supported":false}']),
    mk(['الكتاب بـ350 جنيه.'], ['garbage']),
    mk([], [])
  ]);

  const shapes = new Set(outcomes.map((o) => Object.keys(o).sort().join(',')));
  if (shapes.size !== 1) throw new Error(`shapes differ: ${[...shapes].join(' | ')}`);
  return true;
}

async function testNoEvidenceProducesNoReply() {
  // Nothing to ground against, so nothing may be published — and the attempt must not loop,
  // because this is a caller precondition rather than a rejection.
  let calls = 0;
  const outcome = await generateAndValidateGrounded({
    commentText: COMMENT,
    evidence: [],
    complete: async () => { calls++; return { text: shape('الكتاب بـ350 جنيه.', []) }; }
  });

  if (outcome.status === REPLY_STATUS.PUBLISHABLE) return 'a reply was published with no knowledge';
  if (calls > 1) return `${calls} generation calls with no knowledge`;
  return true;
}

async function testItIsDeterministic() {
  const build = () => scripted({
    generations: ['الكتاب بـ400 جنيه.', 'الكتاب بـ450 جنيه.'],
    validators: ['{"supported":false}', '{"supported":false}']
  });
  const a = await generateAndValidateGrounded({ commentText: COMMENT, evidence: approved(), complete: build().complete });
  const b = await generateAndValidateGrounded({ commentText: COMMENT, evidence: approved(), complete: build().complete });

  if (a.status !== b.status || a.attempts !== b.attempts) return 'the same inputs produced different verdicts';
  if (a.reason !== b.reason) return `reasons differed: ${a.reason} vs ${b.reason}`;
  return true;
}

export default async function runAllTests() {
  await runTest('a grounded reply is returned on the first attempt', testAGroundedReplyIsReturnedOnTheFirstAttempt);
  await runTest('a rejected reply is regenerated and can succeed (§17)', testARejectedReplyIsRegeneratedAndCanSucceed);

  await runTest('an endlessly failing model is stopped', testAnEndlesslyFailingModelIsStopped);
  await runTest('the bound cannot be raised past the ceiling', testTheBoundCannotBeRaised);
  await runTest('the bound can be lowered', testTheBoundCanBeLowered);
  await runTest('a repeated reply stops the loop early', testARepeatedReplyStopsEarly);
  await runTest('a repeat is detected through cosmetic differences', testARepeatIsDetectedThroughCosmeticDifferences);

  await runTest('a validator failure is not regenerated', testAValidatorFailureIsNotRegenerated);
  await runTest('a generation failure is not regenerated', testAGenerationFailureIsNotRegenerated);

  await runTest('an exhausted skip is a safety failure, not a healthy skip (§32)', testAnExhaustedSkipIsASafetyFailureNotAHealthySkip);
  await runTest('only a publishable outcome carries a reply', testOnlyAPublishableOutcomeCarriesAReply);
  await runTest('the attempt count is reported for rate limiting', testTheAttemptCountIsReportedForRateLimiting);

  await runTest('the retry keeps the whole approved evidence set (§17)', testTheRetryKeepsTheWholeApprovedEvidenceSet);
  await runTest('evidenceForRetry is total', testEvidenceForRetryIsTotal);
  await runTest('the retry is told what it got wrong', testTheRetryIsToldWhatItGotWrong);
  await runTest('the first attempt is not told about a failure that had not happened', testTheFirstAttemptIsNotToldAboutAPreviousFailure);
  await runTest('correction notes prefer the validator\'s own words', testCorrectionNotesPreferTheValidatorsOwnWords);

  await runTest('generating never throws', testItNeverThrows);
  await runTest('every outcome has one shape', testEveryOutcomeHasOneShape);
  await runTest('no evidence produces no reply', testNoEvidenceProducesNoReply);
  await runTest('the outcome is deterministic', testItIsDeterministic);

  return results;
}