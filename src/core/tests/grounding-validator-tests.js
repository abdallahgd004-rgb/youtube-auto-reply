/**
 * Grounding Validation Tests — Phase 20.10
 *
 * This is the last gate before publication, so the tests are written from two directions:
 *
 *   1. **A hallucination must be caught.** §16's own example is the centrepiece: "الكتاب بـ350
 *      جنيه والشحن خلال يومين" against knowledge that mentions only a price. The invented part
 *      is a WORD, so a numbers-only implementation passes it — that test is here to stop that
 *      simplification from ever being made.
 *   2. **A correct reply must survive.** A validator that rejects grounded replies is not safe,
 *      it is broken: it costs regenerations and skips comments the knowledge could answer.
 *
 * The layering is tested explicitly, because the failure mode is subtle — the model layer
 * cannot catch a numeric hallucination, so if it ever became the only layer the safety
 * property would be gone while every test that used a cooperative fake model still passed.
 *
 * Runs in the browser from grounding-validator-tests.html. No chrome stub, no network:
 * `complete` is injected.
 */

import {
  validateGrounding,
  validateWithModel,
  findUnsupportedClaims,
  extractFactualAtoms,
  parseGroundingVerdict,
  buildGroundingCheckMessages,
  GROUNDING_STATUS,
  GROUNDING_LAYER
} from '../grounding-validator.js';

import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip, categorizeKnowledgeError, ERROR_CATEGORY } from '../knowledge-schema.js';
import { REASONING_HEADROOM_TOKENS } from '../reasoning-budget.js';

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

const answering = (text) => async () => ({ text });
const agreeing = answering('{"supported":true}');

/** §16's knowledge: a price and nothing else. */
function priceEvidence() {
  return [{
    evidenceId: 'KNOWLEDGE-BOOKS-CHEMISTRY-PRICE',
    documentId: 'doc-a',
    filename: 'books/chemistry.md',
    headingPath: ['كيمياء', 'السعر'],
    content: 'السعر الحالي: 350 جنيه.'
  }];
}

/** §38 Test 4's reply, verbatim: the price is supported and the shipping is invented. */
const HALLUCINATED_REPLY = 'الكتاب بـ350 جنيه والشحن خلال يومين.';

// ─── §16's example, and the cases around it ───────────────────────────────────

async function testTheSpecExampleIsRejected() {
  // §16: knowledge "Price: 350 EGP", reply "الكتاب بـ350 جنيه والشحن خلال يومين."
  // The second claim is unsupported. This is THE test of this milestone.
  const outcome = await validateGrounding({
    reply: HALLUCINATED_REPLY,
    evidence: priceEvidence(),
    complete: agreeing
  });

  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testTheDurationIsCaughtNotJustTheNumber() {
  // The whole point of matching durations: the invented part of §16's reply is a WORD, not a
  // digit, so a numbers-only check passes it.
  //
  // "يومين" is the dual form, so the invented claim arrives as the FIGURE 2 rather than as a
  // stem — Arabic's broken plural makes the quantity invisible otherwise, and a knowledge base
  // saying "ثلاثة أيام" would otherwise "support" a reply claiming "يومين". Both paths are
  // tested below because both are real: a duration with a quantity, and one without.
  const found = findUnsupportedClaims(HALLUCINATED_REPLY, priceEvidence());

  if (found.ok) return 'the invented duration was not detected';
  if (!found.unsupported.some((a) => a.value === '2')) {
    return `the invented figure was not found: ${JSON.stringify(found.unsupported)}`;
  }
  if (found.unsupported.some((a) => a.kind === 'number' && a.value === '350')) {
    return 'the supported price 350 was reported as unsupported';
  }
  return true;
}

async function testADurationWithNoQuantityIsCaughtAsAStem() {
  // The other path: the reply claims a duration exists without saying how long. There is no
  // figure to compare, so the stem itself is the atom — and the knowledge mentions no days at
  // all, so it is unsupported.
  const found = findUnsupportedClaims('الكتاب بـ350 جنيه والشحن خلال أيام.', priceEvidence());

  if (found.ok) return 'an unsupported duration stem was not detected';
  const durations = found.unsupported.filter((a) => a.kind === 'duration');
  if (durations.length !== 1 || durations[0].value !== 'day') {
    return `duration atoms: ${JSON.stringify(durations)}`;
  }
  return true;
}

async function testTheSupportedPartOfTheSameReplyPasses() {
  // A reply that only states the price is grounded.
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ350 جنيه.',
    evidence: priceEvidence(),
    complete: agreeing
  });
  if (outcome.status !== GROUNDING_STATUS.SUPPORTED) return `status ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testAnInventedPriceIsRejected() {
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ400 جنيه.',
    evidence: priceEvidence(),
    complete: agreeing
  });

  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  if (!/400/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  if (outcome.layer !== GROUNDING_LAYER.DETERMINISTIC) return `layer was ${outcome.layer}`;
  return true;
}

async function testAnInventedDateIsRejected() {
  const outcome = await validateGrounding({
    reply: 'سعره 350 جنيه ويبدأ في 2027.',
    evidence: priceEvidence(),
    complete: agreeing
  });
  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  if (!outcome.unsupported.some((a) => a.value === '2027')) return `unsupported: ${JSON.stringify(outcome.unsupported)}`;
  return true;
}

async function testArabicIndicDigitsMatchTheirAsciiEquivalent() {
  // A viewer types ٣٥٠; the knowledge says 350. Folding both sides is what stops that being
  // read as an invented price on every Arabic-keyboard reply.
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ٣٥٠ جنيه.',
    evidence: priceEvidence(),
    complete: agreeing
  });
  if (outcome.status !== GROUNDING_STATUS.SUPPORTED) return `status ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testDecimalPricesAreNotMangled() {
  // normalizeArabic strips punctuation, turning 350.50 into 35050 — which would match nothing
  // and read as an invented price. Number extraction must not reuse it.
  const outcome = await validateGrounding({
    reply: 'السعر 350.50 جنيه.',
    evidence: [{ evidenceId: 'E', filename: 'a.md', headingPath: ['السعر'], content: 'السعر 350.50 جنيه.' }],
    complete: agreeing
  });
  if (outcome.status !== GROUNDING_STATUS.SUPPORTED) return `status ${outcome.status}: ${outcome.reason}`;
  return true;
}

// ─── Durations ────────────────────────────────────────────────────────────────

async function testDurationInflectionsAreMatched() {
  // Arabic attaches inflection directly to the stem. If only the exact form matched, an
  // invented "أيام" would slip past a knowledge base that says "أيام عمل".
  const withDays = [{ evidenceId: 'E', filename: 's.md', headingPath: ['الشحن'], content: 'الشحن خلال ثلاثة أيام عمل.' }];

  // These all mean "three days" or "some days", which the knowledge does state. Note that
  // "يومين" is NOT in this list: it means TWO days, and the knowledge says three, so it is a
  // different figure — asserting it would be an invention, and asserting otherwise would test
  // the wrong thing. That case is covered by the test below.
  for (const reply of ['الشحن خلال 3 أيام.', 'الشحن بياخد ثلاثة أيام.', 'الشحن خلال أيام.', 'الشحن خلال اليوم.', 'الشحن خلال 3 ايام عمل.']) {
    const outcome = await validateGrounding({ reply, evidence: withDays, complete: agreeing });
    if (outcome.status !== GROUNDING_STATUS.SUPPORTED) {
      return `"${reply}" was rejected although the knowledge gives a duration: ${outcome.reason}`;
    }
  }
  return true;
}

async function testAStatedDurationStillNeedsItsNumberToExist() {
  // The knowledge says "three days"; a reply saying "two days" borrows the word and invents
  // the number. Both atoms have to be checked, not either one.
  const withDays = [{ evidenceId: 'E', filename: 's.md', headingPath: ['الشحن'], content: 'الشحن خلال ثلاثة أيام عمل.' }];
  const outcome = await validateGrounding({
    reply: 'الشحن خلال يومين.',
    evidence: withDays,
    complete: agreeing
  });
  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  return true;
}

async function testEachDurationTypeIsTrackedSeparately() {
  // Evidence mentions days. A claim about weeks is a different fact type and is unsupported.
  const withDays = [{ evidenceId: 'E', filename: 's.md', headingPath: ['الشحن'], content: 'الشحن خلال ثلاثة أيام.' }];

  for (const reply of ['الشحن خلال أسبوعين.', 'التوصيل خلال ساعتين.', 'الاسترجاع خلال شهرين.']) {
    const outcome = await validateGrounding({ reply, evidence: withDays, complete: agreeing });
    if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `"${reply}" was accepted`;
  }
  return true;
}

async function testOrdinaryWordsAreNotMistakenForDurations() {
  // The stem list is deliberately conservative: 'عام' is excluded because it is a substring of
  // 'دائماً', and a stem that fires on ordinary words would reject correct replies all day.
  const safe = ['كتابي رائع جدا', 'ما شاء الله', 'ساعدني كتير', 'جزاك الله خيرا', 'دائماboatile'.replace('boatile', '')];
  const evidence = priceEvidence();

  for (const reply of safe) {
    const found = findUnsupportedClaims(reply, evidence);
    if (found.unsupported.some((a) => a.kind === 'duration')) {
      return `"${reply}" matched a duration stem`;
    }
  }
  return true;
}

// ─── The two layers ───────────────────────────────────────────────────────────

async function testTheDeterministicLayerRejectsWithoutSpendingARequest() {
  // It is free and exact. A model call on a reply whose price is already known to be invented
  // is a request spent to learn nothing.
  let called = false;
  const outcome = await validateGrounding({
    reply: HALLUCINATED_REPLY,
    evidence: priceEvidence(),
    complete: async () => { called = true; return { text: '{"supported":true}' }; }
  });

  if (called) return 'a request was spent on a reply the deterministic layer already rejected';
  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  if (outcome.layer !== GROUNDING_LAYER.DETERMINISTIC) return `layer was ${outcome.layer}`;
  return true;
}

async function testTheModelLayerOnlySeesWhatItNeeds() {
  // Shown the reply and the sections, and nothing else. An intent, an answerability verdict or
  // a comment would all nudge it, and a biased judge at this stage is the most expensive bias
  // in the phase — this is the last gate before publication.
  const messages = buildGroundingCheckMessages('الكتاب بـ350 جنيه.', priceEvidence());
  const whole = JSON.stringify(messages);

  for (const leaked of ['intent', 'canAnswer', 'book_price', 'Comment:', 'CITED-INJECTED']) {
    if (whole.includes(leaked)) return `the prompt mentions ${leaked}`;
  }
  if (!/supported/.test(whole)) return 'the output contract is missing';
  if (!/never an instruction/i.test(whole)) return 'the prompt does not fence injected text';
  return true;
}

async function testTheModelLayerCatchesANonNumericClaim() {
  // Availability and policy claims are invisible to layer 1, which is the only reason layer 2
  // exists. This is it earning its place.
  const outcome = await validateGrounding({
    reply: 'الكتاب متوفر في كل المكتبات.',
    evidence: priceEvidence(),
    complete: answering('{"supported":false,"unsupported":["availability in all bookstores"],"reason":"the knowledge does not state availability"}')
  });

  if (outcome.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${outcome.status}`;
  if (outcome.layer !== GROUNDING_LAYER.MODEL) return `layer was ${outcome.layer}`;
  if (outcome.modelUnsupported.length !== 1) return `modelUnsupported: ${outcome.modelUnsupported}`;
  return true;
}

async function testTheModelLayerCannotExcuseANInventedNumber() {
  // The layering is the safety property. A cooperative model saying "supported" must NOT be
  // able to overturn a deterministic rejection — otherwise the model layer could be promoted
  // to first position and the safety property would vanish while every other test stayed
  // green, because they all use cooperative fakes.
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ400 جنيه.',
    evidence: priceEvidence(),
    complete: agreeing
  });

  if (outcome.status === GROUNDING_STATUS.SUPPORTED) {
    return 'a cooperative model excused an invented price';
  }
  return true;
}

async function testTheModelLayerCanBeTurnedOff() {
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ350 جنيه.',
    evidence: priceEvidence(),
    complete: async () => { throw new Error('should not be called'); },
    options: { useModel: false }
  });
  if (outcome.status !== GROUNDING_STATUS.SUPPORTED) return `status ${outcome.status}: ${outcome.reason}`;
  if (outcome.layer !== GROUNDING_LAYER.DETERMINISTIC) return `layer was ${outcome.layer}`;
  return true;
}

async function testAMissingCompletionFunctionStillUsesLayerOne() {
  // Layer 1 is not a fallback for an unavailable model — it runs first, always.
  const invented = await validateGrounding({
    reply: 'الكتاب بـ400 جنيه.',
    evidence: priceEvidence()
  });
  if (invented.status !== GROUNDING_STATUS.UNSUPPORTED) return `status was ${invented.status}`;

  const grounded = await validateGrounding({
    reply: 'الكتاب بـ350 جنيه.',
    evidence: priceEvidence()
  });
  if (grounded.status !== GROUNDING_STATUS.SUPPORTED) return `a grounded reply was rejected without a model: ${grounded.reason}`;
  return true;
}

// ─── Failing closed ───────────────────────────────────────────────────────────

async function testAnUnreadableVerdictNeverPasses() {
  // Fail closed: an unreadable answer from a permission-granting stage means do not publish.
  const unreadable = ['', '   ', 'garbage', '{', 'null', 'true', '[]', '{}', '{"supported":"true"}',
    '{"supported":1}', '{"supported":{}}', '[{"supported":true}]', '{"a":{"supported":true}}', '{"supported":true,}'];

  for (const text of unreadable) {
    const outcome = await validateGrounding({
      reply: 'الكتاب بـ350 جنيه.',
      evidence: priceEvidence(),
      complete: answering(text)
    });
    if (outcome.status === GROUNDING_STATUS.SUPPORTED) {
      return `${JSON.stringify(text)} was read as "supported"`;
    }
    if (outcome.status !== GROUNDING_STATUS.UNDETERMINED) {
      return `${JSON.stringify(text)} → ${outcome.status}`;
    }
  }
  return true;
}

async function testAModelFailureNeverPasses() {
  const outcome = await validateGrounding({
    reply: 'الكتاب بـ350 جنيه.',
    evidence: priceEvidence(),
    complete: async () => { throw new Error('LM Studio unreachable'); }
  });
  if (outcome.status === GROUNDING_STATUS.SUPPORTED) return 'an outage published a reply';
  if (outcome.code !== KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testNoEvidenceCannotBeSupported() {
  for (const evidence of [[], null, undefined, [null], 'not an array']) {
    const outcome = await validateGrounding({
      reply: 'الكتاب بـ350 جنيه.',
      evidence,
      complete: agreeing
    });
    if (outcome.status === GROUNDING_STATUS.SUPPORTED) return `${JSON.stringify(evidence)} produced SUPPORTED`;
    if (outcome.code !== KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED) return `code was ${outcome.code}`;
  }
  return true;
}

async function testAnEmptyReplyIsRejected() {
  const outcome = await validateGrounding({ reply: '   ', evidence: priceEvidence(), complete: agreeing });
  if (outcome.status === GROUNDING_STATUS.SUPPORTED) return 'an empty reply was supported';
  if (!outcome.reason) return 'no reason given';
  return true;
}

async function testAFailedCheckIsNotASafetyRejection() {
  // THE distinction. "We could not tell" and "the reply invented a price" are both
  // do-not-publish, but reporting a flaky validator as a safety rejection tells the user their
  // knowledge base is producing wrong answers when the reply may have been correct.
  const undetermined = await validateGrounding({
    reply: 'الكتاب بـ350 جنيه.',
    evidence: priceEvidence(),
    complete: answering('garbage')
  });
  const unsafe = await validateGrounding({
    reply: 'الكتاب بـ400 جنيه.',
    evidence: priceEvidence(),
    complete: agreeing
  });

  if (undetermined.code !== KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED) return `undetermined code ${undetermined.code}`;
  if (unsafe.code !== KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED) return `unsafe code ${unsafe.code}`;

  if (categorizeKnowledgeError(undetermined.code) !== ERROR_CATEGORY.AI) return `undetermined bucket ${categorizeKnowledgeError(undetermined.code)}`;
  if (categorizeKnowledgeError(unsafe.code) !== ERROR_CATEGORY.SAFETY) return `unsafe bucket ${categorizeKnowledgeError(unsafe.code)}`;

  // Neither is a healthy skip: an unsupported answer and an unreadable verdict are both real
  // failures a user needs to see.
  if (isExpectedKnowledgeSkip(undetermined.code)) return 'a failed check counts as a healthy skip';
  if (isExpectedKnowledgeSkip(unsafe.code)) return 'an unsupported reply counts as a healthy skip';
  return true;
}

// ─── Atoms ────────────────────────────────────────────────────────────────────

async function testAtomExtractionIsTotal() {
  for (const input of [null, undefined, 42, '', '   ', {}, []]) {
    const atoms = extractFactualAtoms(input);
    if (!Array.isArray(atoms)) return `extractFactualAtoms(${JSON.stringify(input)}) threw`;
    for (const atom of atoms) {
      if (typeof atom.value !== 'string' || typeof atom.kind !== 'string') return `malformed atom ${JSON.stringify(atom)}`;
    }
  }
  return true;
}

async function testFindingClaimsIsTotal() {
  for (const args of [
    [null, null], ['reply', null], ['reply', []], [null, priceEvidence()], [42, priceEvidence()]
  ]) {
    const found = findUnsupportedClaims(...args);
    if (!found || typeof found.ok !== 'boolean' || !Array.isArray(found.unsupported)) {
      return `findUnsupportedClaims(${JSON.stringify(args)}) threw`;
    }
  }
  return true;
}

async function testVerdictParsingIsTotal() {
  const hostile = [null, undefined, 42, true, [], '{}', '{"supported":[]}', '{"supported":null}', '}{', '{"supported":true,"unsupported":"x"}'];
  for (const value of hostile) {
    const parsed = parseGroundingVerdict(value);
    if (parsed.ok) return `${JSON.stringify(value)} parsed`;
    if (parsed.supported !== false) return `${JSON.stringify(value)} → supported`;
  }

  const fenced = parseGroundingVerdict('```json\n{"supported":true}\n```');
  if (!fenced.ok) return 'a fenced verdict was rejected';

  const withList = parseGroundingVerdict('{"supported":false,"unsupported":["a","b"]}');
  if (!withList.ok || withList.unsupported.length !== 2) return 'the unsupported list was lost';

  return true;
}

async function testTheLayerTwoCallIsNamed() {
  let operation = '';
  await validateWithModel({
    reply: 'x', evidence: priceEvidence(),
    complete: async (m, o) => { operation = o.operation; return { text: '{"supported":true}' }; }
  });
  if (operation !== 'GROUNDING_CHECK') return `operation was ${operation}`;
  return true;
}

/**
 * Phase 20.24 — the ceiling must clear a reasoning model's thinking.
 *
 * This stage sits LAST, so a truncated budget threw away a reply that had already been
 * generated, validated and grounded. And it reported GROUNDING_CHECK_FAILED, which means "we
 * could not tell" rather than "the reply invented a price" — a deliberately different code,
 * because one sends the user into their Markdown files for a problem that is not there.
 */
async function testTheCeilingClearsReasoningAndOptsOutOfTheFallback() {
  let seen = null;
  await validateWithModel({
    reply: 'x', evidence: priceEvidence(),
    complete: async (m, o) => { seen = o; return { text: '{"supported":true}' }; }
  });

  if (!seen) return 'the completion function was never called';
  // Exact composition: the payload this call builds from, plus the shared headroom.
  if (seen.maxTokens !== 300 + REASONING_HEADROOM_TOKENS) {
    return `maxTokens ${seen.maxTokens} is not the 300-token payload plus the ${REASONING_HEADROOM_TOKENS}-token headroom`;
  }
  // And it must clear what the model actually spends: 376 reasoning tokens, measured.
  if (seen.maxTokens < 376 + 300) {
    return `maxTokens ${seen.maxTokens} cannot hold the ~376 reasoning tokens measured plus the verdict`;
  }
  if (seen.allowReasoningFallback !== false) {
    return 'a structured call must opt out of the reasoning_content fallback';
  }
  return true;
}

async function testEveryOutcomeHasOneShape() {
  const outcomes = await Promise.all([
    validateGrounding({ reply: 'الكتاب بـ350 جنيه.', evidence: priceEvidence(), complete: agreeing }),
    validateGrounding({ reply: 'الكتاب بـ400 جنيه.', evidence: priceEvidence(), complete: agreeing }),
    validateGrounding({ reply: 'الكتاب بـ350 جنيه.', evidence: priceEvidence(), complete: answering('garbage') }),
    validateGrounding({ reply: 'الكتاب بـ350 جنيه.', evidence: priceEvidence(), complete: async () => { throw new Error('x'); } }),
    validateGrounding({ reply: 'x', evidence: [], complete: agreeing }),
    validateGrounding({ reply: '', evidence: priceEvidence(), complete: agreeing })
  ]);

  const shapes = new Set(outcomes.map((o) => Object.keys(o).sort().join(',')));
  if (shapes.size !== 1) throw new Error(`shapes differ: ${[...shapes].join(' | ')}`);

  for (const outcome of outcomes) {
    if (outcome.status === GROUNDING_STATUS.SUPPORTED && outcome.code) {
      throw new Error('SUPPORTED carries an error code');
    }
    if (outcome.status !== GROUNDING_STATUS.SUPPORTED && !outcome.code) {
      throw new Error(`${outcome.status} carries no error code`);
    }
    if (!outcome.reason) throw new Error(`${outcome.status} has no reason`);
  }
  return true;
}

async function testValidatingNeverThrows() {
  for (const args of [
    {},
    { reply: null, evidence: null },
    { reply: 'x' },
    { reply: 'x', evidence: priceEvidence(), complete: 42 },
    { reply: 'x', evidence: priceEvidence(), complete: async () => null },
    { reply: 'x', evidence: priceEvidence(), options: null }
  ]) {
    const outcome = await validateGrounding(args);
    if (!outcome || !outcome.status) throw new Error(`${JSON.stringify(args)} → ${JSON.stringify(outcome)}`);
    if (!Array.isArray(outcome.unsupported) || !Array.isArray(outcome.modelUnsupported)) {
      throw new Error(`${JSON.stringify(args)} → shape is wrong`);
    }
  }
  return true;
}

async function testItIsDeterministic() {
  const args = { reply: 'الكتاب بـ350 جنيه.', evidence: priceEvidence(), complete: agreeing };
  const a = await validateGrounding(args);
  const b = await validateGrounding(args);
  if (a.status !== b.status || a.reason !== b.reason) return 'the same inputs produced different verdicts';
  return true;
}

export default async function runAllTests() {
  await runTest("§16's example reply is rejected", testTheSpecExampleIsRejected);
  await runTest('the invented duration is caught, not just the number', testTheDurationIsCaughtNotJustTheNumber);
  await runTest('a duration with no quantity is caught as a stem', testADurationWithNoQuantityIsCaughtAsAStem);
  await runTest('the supported half of that reply passes', testTheSupportedPartOfTheSameReplyPasses);
  await runTest('an invented price is rejected', testAnInventedPriceIsRejected);
  await runTest('an invented date is rejected', testAnInventedDateIsRejected);
  await runTest('Arabic-Indic digits match their ASCII equivalent', testArabicIndicDigitsMatchTheirAsciiEquivalent);
  await runTest('decimal prices are not mangled', testDecimalPricesAreNotMangled);

  await runTest('duration inflections are matched', testDurationInflectionsAreMatched);
  await runTest('a stated duration still needs its number to exist', testAStatedDurationStillNeedsItsNumberToExist);
  await runTest('each duration type is tracked separately', testEachDurationTypeIsTrackedSeparately);
  await runTest('ordinary words are not mistaken for durations', testOrdinaryWordsAreNotMistakenForDurations);

  await runTest('the deterministic layer rejects without spending a request', testTheDeterministicLayerRejectsWithoutSpendingARequest);
  await runTest('the model layer sees only what it needs', testTheModelLayerOnlySeesWhatItNeeds);
  await runTest('the model layer catches a non-numeric claim', testTheModelLayerCatchesANonNumericClaim);
  await runTest('the model layer cannot excuse an invented number', testTheModelLayerCannotExcuseANInventedNumber);
  await runTest('the model layer can be turned off', testTheModelLayerCanBeTurnedOff);
  await runTest('a missing completion function still uses layer 1', testAMissingCompletionFunctionStillUsesLayerOne);

  await runTest('an unreadable verdict never passes', testAnUnreadableVerdictNeverPasses);
  await runTest('a model failure never passes', testAModelFailureNeverPasses);
  await runTest('no evidence cannot be supported', testNoEvidenceCannotBeSupported);
  await runTest('an empty reply is rejected', testAnEmptyReplyIsRejected);
  await runTest('a failed check is not a safety rejection (§32)', testAFailedCheckIsNotASafetyRejection);

  await runTest('atom extraction is total', testAtomExtractionIsTotal);
  await runTest('finding unsupported claims is total', testFindingClaimsIsTotal);
  await runTest('verdict parsing is total', testVerdictParsingIsTotal);
  await runTest('the layer-2 call is named in diagnostics', testTheLayerTwoCallIsNamed);
  await runTest('the layer-2 ceiling clears reasoning', testTheCeilingClearsReasoningAndOptsOutOfTheFallback);
  await runTest('every outcome has one shape', testEveryOutcomeHasOneShape);
  await runTest('validating never throws', testValidatingNeverThrows);
  await runTest('validation is deterministic', testItIsDeterministic);

  return results;
}