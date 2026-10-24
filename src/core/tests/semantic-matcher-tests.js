/**
 * Semantic Trigger Matching tests
 *
 * These exercise the SAFETY properties of the LM Studio matching stage, not the
 * model's language ability (which cannot be asserted without a live server):
 *
 *   1. a semantically equivalent Arabic comment is read as a MATCH
 *   2. an unrelated comment is read as NO_MATCH
 *   3. the classification call never asks for, or returns, a reply
 *   4. invalid / malformed LM Studio JSON is never treated as a match
 *   5. an LM Studio failure is contained and recorded, not thrown
 *
 * Runs in the browser from semantic-matcher-tests.html. There is no Node runner.
 */

import {
  SEMANTIC_MATCH_OPTIONS,
  SEMANTIC_MATCH_PAYLOAD_TOKENS,
  flattenTriggerPhrases,
  buildSemanticMatchMessages,
  parseSemanticMatchResult,
  semanticMatchTriggers,
} from '../semantic-matcher.js';
import { REASONING_HEADROOM_TOKENS } from '../reasoning-budget.js';

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

/** A completion stub returning exactly the given text. */
function respondWith(text) {
  return async () => ({ text, reasoning: '' });
}

/** The three triggers from the task's own examples. */
const EXAMPLE_TRIGGERS = Object.freeze([
  { id: 'rule-1', enabled: true, phrases: ['بكام', 'السعر', 'منين أجيب'] },
]);

// ── 1. semantic match ───────────────────────────────────────────────────────

async function testParaphraseIsAMatch() {
  // "كام سعره؟" shares no substring with "بكام" and is not a word-order variant of
  // it, so a deterministic `includes()` matcher could never produce this. Only a
  // model that understands the intent can.
  const decision = await semanticMatchTriggers({
    commentText: 'كام سعره؟',
    phrases: EXAMPLE_TRIGGERS[0].phrases,
    complete: respondWith('{"matched":true,"trigger":"بكام"}'),
  });

  if (!decision.ok) return `Expected a readable verdict, got ${decision.reason}`;
  if (decision.matched !== true) return 'Expected MATCH for "كام سعره؟" against "بكام"';
  if (decision.trigger !== 'بكام') return `Expected the best trigger returned, got ${decision.trigger}`;
  return true;
}

async function testEveryExampleTriggerCanMatch() {
  const cases = [
    ['السعر كام؟', 'السعر'],
    ['منين أجيب الكتاب ده', 'منين أجيب'],
    ['كام سعره؟', 'بكام'],
  ];

  for (const [comment, expectedTrigger] of cases) {
    const decision = await semanticMatchTriggers({
      commentText: comment,
      phrases: EXAMPLE_TRIGGERS[0].phrases,
      complete: respondWith(JSON.stringify({ matched: true, trigger: expectedTrigger })),
    });
    if (decision.matched !== true) return `Expected MATCH for "${comment}"`;
    if (decision.trigger !== expectedTrigger) {
      return `Expected trigger "${expectedTrigger}" for "${comment}", got ${decision.trigger}`;
    }
  }
  return true;
}

// ── 2. semantic no-match ────────────────────────────────────────────────────

async function testUnrelatedCommentIsNoMatch() {
  const decision = await semanticMatchTriggers({
    commentText: 'الفيديو جميل جداً',
    phrases: ['بكام'],
    complete: respondWith('{"matched":false}'),
  });

  if (!decision.ok) return `Expected a readable verdict, got ${decision.reason}`;
  if (decision.matched !== false) return 'An unrelated comment must be NO_MATCH';
  return true;
}

/** Sharing one word with a trigger is not intent, so the verdict must stay NO_MATCH. */
async function testWordOverlapAloneIsNotAMatch() {
  const decision = await semanticMatchTriggers({
    commentText: 'الكاميرا حلوة',
    phrases: ['بكام'],
    complete: respondWith('{"matched":false}'),
  });

  if (decision.matched !== false) return 'Word overlap must not be enough for a match';
  return true;
}

// ── 3. classification only, never a reply ───────────────────────────────────

async function testPromptAsksForJSONAndNothingElse() {
  const messages = buildSemanticMatchMessages('بكام', ['بكام', 'السعر']);

  if (messages.length !== 2) return `Expected 2 messages, got ${messages.length}`;
  const [system, user] = messages;

  if (!/JSON/i.test(system.content)) return 'The system prompt must fix a JSON output contract';
  if (/write a reply|generate a reply|compose a response|respond to the comment/i.test(system.content)) {
    return 'The system prompt must not ask for a reply';
  }
  if (/think step by step|chain.of.thought|explain your/i.test(system.content)) {
    return 'The classification prompt must not request reasoning';
  }

  for (const phrase of ['بكام', 'السعر']) {
    if (!user.content.includes(phrase)) return `The prompt must carry the trigger "${phrase}"`;
  }
  if (!user.content.includes('بكام')) return 'The prompt must carry the comment text';
  return true;
}

/**
 * The prompt must be short. Length is the main cost driver here, and a prompt padded
 * with instructions the model does not need is paid for on every detected comment.
 */
async function testPromptStaysShort() {
  const messages = buildSemanticMatchMessages('بكام', ['بكام', 'السعر', 'منين أجيب']);
  const total = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (total > 900) return `Prompt is ${total} chars; expected a compact classification prompt`;
  return true;
}

/**
 * The ceiling must clear a reasoning model's thinking, not just hold the verdict.
 *
 * REWRITTEN in Phase 20.24. This test used to assert `maxTokens <= 128`, and it PASSED while
 * the extension was completely broken — the bound it enforced was the bug. The call shipped a
 * 64-token ceiling to a reasoning model that spends ~200 tokens thinking, so `content` came
 * back empty on every single comment and the extension replied to nothing, reporting the cause
 * as "no JSON object in response".
 *
 * The lesson worth keeping is that "small and tidy" was never the property that mattered. What
 * matters is that the ceiling is large enough for thinking PLUS the answer, and that the
 * thinking-text fallback is off so an exhausted budget is reported as an exhausted budget.
 */
async function testCeilingClearsReasoningHeadroom() {
  if (SEMANTIC_MATCH_OPTIONS.temperature !== 0) {
    return `temperature must be 0 for a deterministic decision, got ${SEMANTIC_MATCH_OPTIONS.temperature}`;
  }
  if (SEMANTIC_MATCH_OPTIONS.maxTokens !== SEMANTIC_MATCH_PAYLOAD_TOKENS + REASONING_HEADROOM_TOKENS) {
    return (
      `maxTokens must be the payload plus the reasoning headroom, got ` +
      `${SEMANTIC_MATCH_OPTIONS.maxTokens} (expected ` +
      `${SEMANTIC_MATCH_PAYLOAD_TOKENS} + ${REASONING_HEADROOM_TOKENS})`
    );
  }
  // Measured against the model in use: the classification spends ~202 tokens thinking. A
  // ceiling below that returns an empty `content` on every comment.
  if (SEMANTIC_MATCH_OPTIONS.maxTokens < 256) {
    return (
      `maxTokens ${SEMANTIC_MATCH_OPTIONS.maxTokens} cannot hold the ~202 reasoning tokens ` +
      'measured on google/gemma-4-e2b plus the verdict'
    );
  }
  if (SEMANTIC_MATCH_OPTIONS.allowReasoningFallback !== false) {
    return 'a structured call must opt out of the reasoning_content fallback';
  }
  return true;
}

/** The completion stub must receive the low-temperature / small-limit overrides. */
async function testSemanticCallAppliesItsDecodingOptions() {
  let seen = null;
  await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    complete: async (messages, options) => {
      seen = { messages, options };
      return { text: '{"matched":true,"trigger":"بكام"}', reasoning: '' };
    },
  });

  if (!seen) return 'The completion function was never called';
  if (seen.options.temperature !== 0) return `temperature override missing: ${seen.options.temperature}`;
  if (seen.options.maxTokens !== SEMANTIC_MATCH_OPTIONS.maxTokens) {
    return `maxTokens override missing: ${seen.options.maxTokens}`;
  }
  return true;
}

/** The matcher returns a verdict and nothing else — no reply text can leak through. */
async function testMatcherReturnsNoReplyContent() {
  // Even if the model volunteers a reply alongside its verdict, it must not survive.
  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    complete: respondWith('{"matched":true,"trigger":"بكام","reply":"السعر 50 جنيه"}'),
  });

  if (decision.reply !== undefined) return 'The verdict must not carry a reply field';
  if (JSON.stringify(decision).includes('50 جنيه')) {
    return 'Reply text must never pass through the matching verdict';
  }
  return true;
}

// ── 4. invalid output is never a match ──────────────────────────────────────

async function testMalformedResponsesAreNeverAMatch() {
  const bad = [
    ['empty string', ''],
    ['plain prose', 'The comment is asking about the price.'],
    ['truncated JSON', '{"matched": true'],
    ['invalid JSON', '{"matched": tru}'],
    ['string "true"', '{"matched": "true", "trigger": "بكام"}'],
    ['numeric 1', '{"matched": 1, "trigger": "بكام"}'],
    ['typo in the key', '{"matchd": true, "trigger": "بكام"}'],
    ['array instead of object', '[{"matched":true}]'],
    ['bare null', 'null'],
    ['no JSON at all', 'I cannot answer that.'],
    ['markdown table', '| matched | trigger |\n| --- | --- |\n| true | بكام |'],
    ['matched without a trigger', '{"matched": true}'],
    ['matched with a blank trigger', '{"matched": true, "trigger": "   "}'],
    ['matched with a non-string trigger', '{"matched": true, "trigger": 42}'],
  ];

  for (const [label, text] of bad) {
    const parsed = parseSemanticMatchResult(text);
    if (parsed.matched !== false) return `${label} must not be a match`;
    if (parsed.ok && parsed.reason !== 'no_match') {
      return `${label} should be reported as an unreadable verdict, got ok=true reason=${parsed.reason}`;
    }

    const decision = await semanticMatchTriggers({
      commentText: 'بكام',
      phrases: ['بكام'],
      complete: respondWith(text),
    });
    if (decision.matched !== false) return `${label} must not produce a match`;
  }
  return true;
}

/** A well-formed negative answer is a real verdict, not a failure. */
async function testWellFormedNoMatchIsOk() {
  const decision = await semanticMatchTriggers({
    commentText: 'الفيديو جميل',
    phrases: ['بكام'],
    complete: respondWith('{"matched": false}'),
  });

  if (decision.ok !== true) return 'A clean NO_MATCH is a readable verdict, not a failure';
  if (decision.matched !== false) return 'Expected NO_MATCH';
  return true;
}

/** Models wrap JSON in prose or fences; a correct answer must still be readable. */
async function testFencedAndPrefixedJSONIsAccepted() {
  const wrapped = [
    '```json\n{"matched":true,"trigger":"بكام"}\n```',
    'Here is my answer: {"matched":true,"trigger":"بكام"}',
    '{"matched":true,"trigger":"بكام"} — (high confidence)',
  ];

  for (const text of wrapped) {
    const decision = await semanticMatchTriggers({
      commentText: 'بكام',
      phrases: ['بكام'],
      complete: respondWith(text),
    });
    if (decision.matched !== true) return `Wrapped JSON should be readable: ${text}`;
    if (decision.trigger !== 'بكام') return `Expected the trigger from ${text}`;
  }
  return true;
}

// ── 5. LM Studio failure is contained ───────────────────────────────────────

/**
 * THE reported bug, as a test.
 *
 * Phase 20.24: every comment on a real channel failed with "no JSON object in response", and
 * the reason string pointed at `extractJson`. It was the token ceiling — the model had spent
 * the whole budget thinking and returned an empty `content`, so the thinking text was
 * substituted and then, correctly, failed to parse.
 *
 * Two properties are asserted, and the second is the one that actually cost the debugging
 * time. It is not enough for the ceiling to be right: when a budget IS exhausted, the failure
 * has to say so. A "no JSON object in response" on an empty response sends the reader to the
 * parser, which is exactly where this was looked at first.
 */
async function testExhaustedThinkingBudgetIsNamedAsSuch() {
  const budgetError = new Error('LM Studio spent the whole response budget thinking.');
  budgetError.isReasoningBudget = true;

  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    complete: async () => { throw budgetError; },
  });

  if (decision.ok !== false) return 'An exhausted budget must be a controlled failure';
  if (decision.matched !== false) return 'An exhausted budget must never become a match';
  if (!/budget/i.test(decision.reason)) {
    return (
      `An exhausted thinking budget must name the budget, got "${decision.reason}" — ` +
      'reporting it as a parse failure sends the reader to the wrong file'
    );
  }
  if (/no JSON object/i.test(decision.reason)) {
    return `The parse-failure wording must not survive on an empty response: "${decision.reason}"`;
  }
  return true;
}

/**
 * A model that returns thinking and no content is an EMPTY response, not prose to parse.
 *
 * This is the other half: the matcher must never be handed the thinking text and asked to find
 * JSON in it. `respondWith` is bypassed because the stub has to model the transport's policy,
 * not the matcher's.
 */
async function testThinkingTextIsNeverOfferedToTheParser() {
  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    // What the client returns once the fallback is opted out of: no content, reasoning kept
    // only for diagnostics.
    complete: async () => ({ text: '', reasoning: 'Thinking Process:\n1. Analyze the triggers' }),
  });

  if (decision.ok !== false) return 'An empty content must be a failure, not a verdict';
  if (decision.matched !== false) return 'An empty content must never become a match';
  if (decision.reason !== 'empty response') {
    return `Expected the empty-response reason, got "${decision.reason}"`;
  }
  return true;
}

async function testTransportErrorsBecomeControlledFailures() {
  const errors = [
    new Error('Cannot connect to LM Studio.'),
    new Error('LM Studio did not respond in time'),
    new Error('No model selected. Choose a model in Settings.'),
  ];

  for (const error of errors) {
    const decision = await semanticMatchTriggers({
      commentText: 'بكام',
      phrases: ['بكام'],
      complete: async () => { throw error; },
    });

    if (decision.ok !== false) return `${error.message} should be a controlled failure`;
    if (decision.matched !== false) return `${error.message} must never become a match`;
    if (!decision.reason.includes(error.message)) {
      return `The failure reason should name the cause, got "${decision.reason}"`;
    }
  }
  return true;
}

/** A rejection from an async completion must be caught, not escape to the caller. */
async function testRejectedPromiseDoesNotEscape() {
  let threw = false;
  let decision = null;
  try {
    decision = await semanticMatchTriggers({
      commentText: 'بكام',
      phrases: ['بكام'],
      complete: () => Promise.reject(new Error('socket hang up')),
    });
  } catch (_) {
    threw = true;
  }

  if (threw) return 'A rejected completion must not propagate to the queue';
  if (!decision || decision.matched !== false) return 'A rejection must resolve to no match';
  return true;
}

/** An empty completion (a reasoning model that spent its whole budget) fails safe. */
async function testEmptyCompletionIsAControlledFailure() {
  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    complete: async () => ({ text: '', reasoning: 'thinking about it' }),
  });

  if (decision.ok !== false) return 'An empty content field is a failure, not a no_match';
  if (decision.matched !== false) return 'An empty response must never become a match';
  return true;
}

/** A missing completion function is a wiring error and must be reported, not thrown. */
async function testMissingCompletionFunctionIsReported() {
  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: ['بكام'],
    complete: undefined,
  });

  if (decision.ok !== false) return 'Expected a controlled failure';
  if (decision.matched !== false) return 'Expected no match';
  return true;
}

// ── Trigger flattening ──────────────────────────────────────────────────────

async function testOnlyEnabledRulesAreSent() {
  const { phrases } = flattenTriggerPhrases([
    { id: 'a', enabled: true, phrases: ['بكام'] },
    { id: 'b', enabled: false, phrases: ['السعر'] },
    { id: 'c', phrases: ['منين أجيب'] },
  ]);

  if (phrases.includes('السعر')) return 'A disabled rule must not reach the model';
  if (!phrases.includes('بكام')) return 'An explicitly enabled rule must be sent';
  return true;
}

async function testUnusablePhrasesAreDropped() {
  const { phrases } = flattenTriggerPhrases([
    { id: 'a', enabled: true, phrases: ['بكام', '', '   ', null, 42, undefined] },
    { id: 'b', enabled: true, phrases: 'not-an-array' },
    'not-a-rule',
    null,
  ]);

  if (phrases.length !== 1 || phrases[0] !== 'بكام') {
    return `Only real phrases should survive, got ${JSON.stringify(phrases)}`;
  }
  return true;
}

/** The returned phrase maps back to its rule so the activity log keeps its rule id. */
async function testPhraseMapsBackToItsRule() {
  const { ruleIdByPhrase } = flattenTriggerPhrases([
    { id: 'rule-price', enabled: true, phrases: ['بكام', 'السعر'] },
    { id: 'rule-source', enabled: true, phrases: ['منين أجيب'] },
  ]);

  if (ruleIdByPhrase.get('السعر') !== 'rule-price') return 'السعر should map to rule-price';
  if (ruleIdByPhrase.get('منين أجيب') !== 'rule-source') return 'منين أجيب should map to rule-source';
  return true;
}

/**
 * No enabled trigger at all is a configuration state, not a matching decision, so no
 * request should be spent on it.
 */
async function testNoTriggersCostsNoRequest() {
  let calls = 0;
  const decision = await semanticMatchTriggers({
    commentText: 'بكام',
    phrases: [],
    complete: async () => { calls++; return { text: '{"matched":true}', reasoning: '' }; },
  });

  if (calls !== 0) return `Expected no request with an empty trigger list, got ${calls}`;
  if (decision.matched !== false) return 'Nothing configured means nothing can match';
  return true;
}

async function runAllTests() {
  console.log('\n=== Semantic Trigger Matching Tests ===\n');

  console.log('--- Semantic matching ---');
  await runTest('Arabic paraphrase is a MATCH', testParaphraseIsAMatch);
  await runTest('Every example trigger can match', testEveryExampleTriggerCanMatch);
  await runTest('Unrelated comment is NO_MATCH', testUnrelatedCommentIsNoMatch);
  await runTest('Word overlap alone is not a match', testWordOverlapAloneIsNotAMatch);

  console.log('\n--- Classification only ---');
  await runTest('Prompt asks for JSON and nothing else', testPromptAsksForJSONAndNothingElse);
  await runTest('Prompt stays short', testPromptStaysShort);
  await runTest('The ceiling clears reasoning headroom', testCeilingClearsReasoningHeadroom);
  await runTest('Semantic call applies its decoding options', testSemanticCallAppliesItsDecodingOptions);
  await runTest('Matcher returns no reply content', testMatcherReturnsNoReplyContent);

  console.log('\n--- Invalid output is never a match ---');
  await runTest('Malformed responses are never a match', testMalformedResponsesAreNeverAMatch);
  await runTest('Well-formed NO_MATCH is a readable verdict', testWellFormedNoMatchIsOk);
  await runTest('Fenced or prefixed JSON is accepted', testFencedAndPrefixedJSONIsAccepted);

  console.log('\n--- LM Studio failure handling ---');
  await runTest('Transport errors become controlled failures', testTransportErrorsBecomeControlledFailures);
  await runTest('An exhausted thinking budget is named as such', testExhaustedThinkingBudgetIsNamedAsSuch);
  await runTest('Thinking text is never offered to the parser', testThinkingTextIsNeverOfferedToTheParser);
  await runTest('A rejected promise does not escape', testRejectedPromiseDoesNotEscape);
  await runTest('Empty completion is a controlled failure', testEmptyCompletionIsAControlledFailure);
  await runTest('Missing completion function is reported', testMissingCompletionFunctionIsReported);

  console.log('\n--- Trigger flattening ---');
  await runTest('Only enabled rules are sent', testOnlyEnabledRulesAreSent);
  await runTest('Unusable phrases are dropped', testUnusablePhrasesAreDropped);
  await runTest('A phrase maps back to its rule', testPhraseMapsBackToItsRule);
  await runTest('No triggers costs no request', testNoTriggersCostsNoRequest);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;
