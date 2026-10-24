/**
 * Reasoning-Model Token Budget tests
 *
 * Phase 20.24. This suite exists because a PASSING test suite shipped a completely broken
 * extension. Every structured call sized `max_tokens` against the payload alone, so the model
 * in use — `google/gemma-4-e2b`, which thinks before it answers — spent the entire budget
 * thinking and returned an empty `content`. Nothing crashed. Every suite was green.
 *
 * What is asserted here is the RULE, not one module's number:
 *   1. the ceiling is the payload plus a shared headroom
 *   2. every structured call in the codebase opts out of the thinking-text fallback
 *   3. the fallback policy behaves correctly in both directions
 *   4. the active model is resolved from LM Studio, and ambiguity is an error
 *
 * Deliberately NO live-server test. A suite that needed LM Studio running would be skipped on
 * the machine where the bug was reported and pass on the machine where it was fixed; the
 * measurements that justify the constant are recorded in the module header instead, and the
 * verifier script re-measures them against the loaded model.
 *
 * Runs in the browser from reasoning-budget-tests.html.
 */

import {
  REASONING_HEADROOM_TOKENS,
  structuredCallOptions,
  resolveResponseText,
  resolveActiveModel,
  assertActiveModel,
} from '../reasoning-budget.js';

const results = { total: 0, passed: 0, failed: 0 };

/** Run one test case; `fn` returns true to pass or a string explaining the failure. */
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

/**
 * The measured worst case, as a fixture.
 *
 * Recorded from the running LM Studio server on `google/gemma-4-e2b`, so a future reader can
 * check whether the constant is still proportionate without re-running the measurements. The
 * headroom must clear the largest of these — not the average, because a ceiling that clears the
 * average still truncates the hardest comment.
 */
const MEASURED_REASONING_TOKENS = {
  semanticMatch: 202,
  intentAnalysis: 184,
  answerability: 399,
  groundingCheck: 376,
  knowledgeRerank: 483,
};

// ── 1. the ceiling ───────────────────────────────────────────────────────────

async function testHeadroomClearsEveryMeasurement() {
  const worst = Math.max(...Object.values(MEASURED_REASONING_TOKENS));
  if (REASONING_HEADROOM_TOKENS < worst) {
    return (
      `headroom ${REASONING_HEADROOM_TOKENS} is below the worst measured reasoning ` +
      `(${worst}), so the hardest comment would be truncated`
    );
  }
  return true;
}

async function testCeilingIsTheSumOfPayloadAndHeadroom() {
  const options = structuredCallOptions({ maxTokens: 64, operation: 'TEST' });
  if (options.maxTokens !== 64 + REASONING_HEADROOM_TOKENS) {
    return `expected ${64 + REASONING_HEADROOM_TOKENS}, got ${options.maxTokens}`;
  }
  return true;
}

/**
 * A ceiling is free; a truncation is not.
 *
 * `max_tokens` bounds generation rather than reserving it, so overshooting costs nothing when
 * the model finishes early. That is the entire justification for a generous constant, and it
 * is worth asserting that the constant is generous rather than merely large: a headroom tuned
 * tight to the average would pass the suite above and still truncate the hard case.
 */
async function testHeadroomIsNotTunedToTheAverage() {
  const values = Object.values(MEASURED_REASONING_TOKENS);
  const average = values.reduce((sum, v) => sum + v, 0) / values.length;
  const worst = Math.max(...values);
  if (REASONING_HEADROOM_TOKENS <= worst) {
    return 'the headroom must clear the worst case, not sit at it';
  }
  if (REASONING_HEADROOM_TOKENS < average * 2) {
    return (
      `headroom ${REASONING_HEADROOM_TOKENS} is within 2x the average reasoning ` +
      `(${Math.round(average)}); reasoning length is not bounded by the prompt, so the ` +
      'margin has to be structural rather than measured'
    );
  }
  return true;
}

// ── 2. the opt-out ───────────────────────────────────────────────────────────

async function testStructuredCallsOptOutOfTheThinkingFallback() {
  const options = structuredCallOptions({ maxTokens: 300, operation: 'TEST' });
  if (options.allowReasoningFallback !== false) {
    return (
      'a structured call must set allowReasoningFallback:false — otherwise an empty ' +
      'content is silently replaced by the model\'s thinking and reported as a parse failure'
    );
  }
  return true;
}

/**
 * The opt-out is the DEFAULT for structured calls, not something a caller must remember.
 *
 * The whole failure mode was a caller passing a bare `maxTokens`. If opting out required an
 * extra argument, the sixth structured call would omit it the same way the first five omitted
 * the headroom. The flag therefore travels with the function that builds the options.
 */
async function testOptOutComesWithTheBudgetNotSeparately() {
  const withBudget = structuredCallOptions({ maxTokens: 100, operation: 'A' });
  if (!('allowReasoningFallback' in withBudget)) {
    return 'the policy must be present on every options object this function returns';
  }
  return true;
}

async function testStructuredCallsAreDeterministic() {
  const options = structuredCallOptions({ maxTokens: 200, operation: 'TEST' });
  if (options.temperature !== 0) {
    return `structured calls must run at temperature 0, got ${options.temperature}`;
  }
  return true;
}

async function testOperationIsCarriedForTheDiagnosticLog() {
  if (structuredCallOptions({ maxTokens: 100, operation: 'SEMANTIC_MATCH' }).operation !== 'SEMANTIC_MATCH') {
    return 'the operation name must survive, or the call is indistinguishable in the log';
  }
  // A missing operation must degrade to UNKNOWN rather than to `undefined`, which is what
  // AGENTS.md records happening for semanticMatchTriggers for most of Phase 19.9.
  if (structuredCallOptions({ maxTokens: 100 }).operation !== 'UNKNOWN') {
    return 'a missing operation must degrade to UNKNOWN';
  }
  return true;
}

// ── 3. the fallback policy ───────────────────────────────────────────────────

async function testContentIsPreferredWhenPresent() {
  const text = resolveResponseText('{"matched":false}', 'some thinking', false);
  if (text !== '{"matched":false}') return `expected the content, got ${text}`;
  return true;
}

async function testFallbackIsDisabledForStructuredCalls() {
  const text = resolveResponseText('', 'Thinking Process:\n1. Analyze', false);
  if (text !== '') {
    return (
      `a structured call must not receive thinking text, got "${text}" — the parser will ` +
      'look for JSON in a paragraph of English'
    );
  }
  return true;
}

/**
 * Prose keeps Phase 7.3's behaviour.
 *
 * Removing the fallback outright would be a behaviour change for reply generation, where it
 * exists for a reason. The fix is that it applies where it is correct and not where it is not.
 */
async function testFallbackIsPreservedForProseCalls() {
  const text = resolveResponseText('', 'Thinking Process:\n1. Analyze', true);
  if (text !== 'Thinking Process:\n1. Analyze') {
    return `Phase 7.3's prose fallback must be preserved, got "${text}"`;
  }
  // And it must be the DEFAULT, so an existing caller that says nothing keeps working.
  if (resolveResponseText('', 'thinking') !== 'thinking') {
    return 'the fallback must remain the default for callers that pass no policy';
  }
  return true;
}

/**
 * Whitespace is not an answer.
 *
 * `content: "   "` is what a model mid-stream truncation can look like, and treating it as
 * present would return whitespace as the answer instead of falling through.
 */
async function testWhitespaceOnlyContentIsNotAnAnswer() {
  if (resolveResponseText('   ', 'thinking', true) !== 'thinking') {
    return 'whitespace-only content must fall through to the fallback';
  }
  if (resolveResponseText('   ', 'thinking', false) !== '') {
    return 'whitespace-only content must count as empty for a structured call';
  }
  return true;
}

async function testNonStringFieldsAreTolerated() {
  if (resolveResponseText(null, null, false) !== '') return 'null fields must yield empty text';
  if (resolveResponseText(undefined, undefined, true) !== '') {
    return 'undefined fields must yield empty text';
  }
  if (resolveResponseText(42, 'thinking', true) !== 'thinking') {
    return 'a non-string content must be treated as absent, not concatenated';
  }
  return true;
}

// ── 4. the active model ──────────────────────────────────────────────────────

const MODELS = [
  { id: 'google/gemma-4-e2b', state: 'loaded' },
  { id: 'qwen3.5-9b', state: 'not-loaded' },
  { id: 'minicpm5-2b-optiq', state: 'not-loaded' },
];

async function testTheLoadedModelIsTheActiveOne() {
  const active = resolveActiveModel(MODELS);
  if (!active.ok) return `expected a resolved model, got: ${active.reason}`;
  if (active.id !== 'google/gemma-4-e2b') return `expected google/gemma-4-e2b, got ${active.id}`;
  return true;
}

/**
 * "Not-loaded" models are not candidates.
 *
 * The instruction this was written to is strict on purpose: a budget verified against a model
 * the user does not run reads as proof the problem is solved while their model stays broken.
 * So an unlisted-but-available model is never silently promoted.
 */
async function testUnloadedModelsAreNeverSelected() {
  const active = resolveActiveModel([{ id: 'qwen3.5-9b', state: 'not-loaded' }]);
  if (active.ok) return 'an unloaded model must never be reported as the active one';
  if (!/no loaded model/i.test(active.reason)) {
    return `expected a "no loaded model" reason, got "${active.reason}"`;
  }
  return true;
}

/**
 * More than one loaded model is an ERROR, not a coin flip.
 *
 * LM Studio serves whichever model a request names, so with two loaded there is no single
 * "the active model" — and silently picking the first would produce a verification result
 * describing no real configuration.
 */
async function testAmbiguityIsAnError() {
  const active = resolveActiveModel([
    { id: 'google/gemma-4-e2b', state: 'loaded' },
    { id: 'qwen3.5-9b', state: 'loaded' },
  ]);
  if (active.ok) return 'two loaded models must not resolve to a single active model';
  if (!/more than one/i.test(active.reason)) {
    return `expected an ambiguity reason, got "${active.reason}"`;
  }
  if (active.loaded.length !== 2) return 'the ambiguity reason must still list what was loaded';
  return true;
}

async function testUnusableInputIsReportedNotGuessed() {
  if (resolveActiveModel(null).ok) return 'a missing model list must not resolve';
  if (resolveActiveModel([]).ok) return 'an empty model list must not resolve';
  return true;
}

/**
 * A mismatch must fail loudly and name both models.
 *
 * The alternative — reporting a clean run against whatever happened to be loaded — is the
 * exact failure this whole module exists to prevent, so the assertion is that the error is
 * specific enough for a human to act on without opening any other file.
 */
async function testAMismatchNamesBothModels() {
  const result = assertActiveModel(MODELS, 'qwen3.5-9b');
  if (result.ok) return 'asserting a different model must fail';
  if (!result.reason.includes('google/gemma-4-e2b')) {
    return `the reason must name the LOADED model, got "${result.reason}"`;
  }
  if (!result.reason.includes('qwen3.5-9b')) {
    return `the reason must name the EXPECTED model, got "${result.reason}"`;
  }
  return true;
}

async function testAMatchPasses() {
  const result = assertActiveModel(MODELS, 'google/gemma-4-e2b');
  if (!result.ok) return `expected a match, got: ${result.reason}`;
  if (result.id !== 'google/gemma-4-e2b') return `expected the loaded id, got ${result.id}`;
  return true;
}

/** An unresolvable list must not become a mismatch — there is nothing to compare. */
async function testAnUnresolvableListIsNotReportedAsAMismatch() {
  const result = assertActiveModel([], 'google/gemma-4-e2b');
  if (result.ok) return 'expected a failure';
  if (!/no loaded model/i.test(result.reason)) {
    return `the underlying resolution failure must be reported, got "${result.reason}"`;
  }
  return true;
}

// ── run ──────────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('--- The ceiling ---');
  await runTest('Headroom clears every measurement', testHeadroomClearsEveryMeasurement);
  await runTest('The ceiling is payload plus headroom', testCeilingIsTheSumOfPayloadAndHeadroom);
  await runTest('Headroom is not tuned to the average', testHeadroomIsNotTunedToTheAverage);

  console.log('\n--- The thinking-text opt-out ---');
  await runTest('Structured calls opt out of the fallback', testStructuredCallsOptOutOfTheThinkingFallback);
  await runTest('The opt-out travels with the budget', testOptOutComesWithTheBudgetNotSeparately);
  await runTest('Structured calls are deterministic', testStructuredCallsAreDeterministic);
  await runTest('The operation name is carried', testOperationIsCarriedForTheDiagnosticLog);

  console.log('\n--- The fallback policy ---');
  await runTest('Content is preferred when present', testContentIsPreferredWhenPresent);
  await runTest('The fallback is off for structured calls', testFallbackIsDisabledForStructuredCalls);
  await runTest('The fallback is preserved for prose', testFallbackIsPreservedForProseCalls);
  await runTest('Whitespace-only content is not an answer', testWhitespaceOnlyContentIsNotAnAnswer);
  await runTest('Non-string fields are tolerated', testNonStringFieldsAreTolerated);

  console.log('\n--- The active model ---');
  await runTest('The loaded model is the active one', testTheLoadedModelIsTheActiveOne);
  await runTest('Unloaded models are never selected', testUnloadedModelsAreNeverSelected);
  await runTest('Ambiguity is an error', testAmbiguityIsAnError);
  await runTest('Unusable input is reported, not guessed', testUnusableInputIsReportedNotGuessed);
  await runTest('A mismatch names both models', testAMismatchNamesBothModels);
  await runTest('A match passes', testAMatchPasses);
  await runTest('An unresolvable list is not a mismatch', testAnUnresolvableListIsNotReportedAsAMismatch);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;