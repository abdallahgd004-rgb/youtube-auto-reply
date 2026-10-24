/**
 * Answerability Gate Tests — Phase 20.7
 *
 * This is the last gate before generation, so its tests concentrate on the two ways it can
 * be wrong in opposite directions:
 *
 *   1. **Permitting an unsupported answer.** A hallucination is the one outcome §42 exists to
 *      prevent, so every ambiguous reading — a missing field, a truthy `1`, a nested value, a
 *      thrown error — must resolve to NOT answering.
 *   2. **Refusing a supported one.** §24 makes NO_SUPPORTED_ANSWER the phase working, so the
 *      gate must not manufacture skips: an unreadable answer is a MODEL failure
 *      (`ANSWERABILITY_PARSE_FAILED`), not a missing fact, and conflating the two is what makes
 *      a working knowledge base look broken.
 *
 * §38 Test 3's shipping-duration case is used verbatim, because "price given, duration asked"
 * is the exact situation the gate exists for and the one a naive containment check gets wrong.
 *
 * Conflicts are checked deterministically and never involve the model at all (§18), so those
 * tests assert that no request is made.
 *
 * Runs in the browser from answerability-gate-tests.html. No chrome stub, no network:
 * `complete` is injected.
 */

import {
  checkAnswerability,
  detectConflict,
  selectEvidence,
  parseAnswerabilityResult,
  buildAnswerabilityMessages,
  ANSWERABILITY,
  ANSWERABILITY_DEFAULTS,
  ANSWERABILITY_OPTIONS
} from '../answerability-gate.js';

import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip, categorizeKnowledgeError, ERROR_CATEGORY } from '../knowledge-schema.js';
import { RETRIEVAL_STATUS } from '../knowledge-retrieval.js';
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

/** A completion function that answers with fixed text. */
const answering = (text) => async () => ({ text });

/** A section as 20.5 would return it. */
function section(overrides = {}) {
  return {
    evidenceId: 'EV-1',
    documentId: 'doc-a',
    filename: 'books/chemistry.md',
    headingPath: ['كيمياء', 'السعر'],
    content: 'السعر الحالي: 350 جنيه.',
    ...overrides
  };
}

const PRICE_COMMENT = 'هو تمن كتاب الكيمياء إيه؟';
/** §38 Test 3 — the comment the phase is built around. */
const SHIPPING_COMMENT = 'الشحن بياخد كام يوم؟';

// ─── §12's documented shape ────────────────────────────────────────────────────

async function testReadsTheDocumentedShapes() {
  // §12 shows both a true and a false answer; the code has to produce both shapes.
  const yes = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":0.96,"reason":"The knowledge contains the current price."}')
  });
  if (yes.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${yes.status}`;
  if (yes.confidence !== 0.96) return `confidence was ${yes.confidence}`;
  if (!/current price/.test(yes.reason)) return `reason was ${yes.reason}`;

  const no = await checkAnswerability({
    commentText: SHIPPING_COMMENT,
    results: [section({ filename: 'shipping.md', headingPath: ['الشحن'], content: 'الشحن 30 جنيه للكتاب الواحد.' })],
    complete: answering('{"canAnswer":false,"reason":"Shipping duration is not provided in the knowledge."}')
  });
  if (no.status !== ANSWERABILITY.NO_SUPPORTED_ANSWER) return `status was ${no.status}`;
  if (no.code !== KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER) return `code was ${no.code}`;
  if (!/duration/i.test(no.reason)) return `the reason lost what is missing: ${no.reason}`;

  return true;
}

async function testTheApprovedEvidenceIsBoundToTheDecision() {
  // 20.8 builds its grounded prompt from THIS list. If the gate approved one set of facts
  // and generation drew from another, the approval would be decorative.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section(), section({ evidenceId: 'EV-2', headingPath: ['كيمياء', 'التغطية'] })],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.evidence.length !== 2) return `evidence had ${outcome.evidence.length}`;
  if (outcome.offeredCount !== 2) return `offeredCount was ${outcome.offeredCount}`;
  for (const item of outcome.evidence) {
    if (!item.evidenceId || !item.filename) return 'evidence lost its provenance';
    if (typeof item.content !== 'string') return 'evidence content is not a string';
  }
  return true;
}

async function testEveryOtherOutcomeReturnsNoEvidence() {
  // Only CAN_ANSWER authorises generation, so only it may hand over evidence.
  // (The conflict case needs genuinely DIFFERENT bodies — two documents that agree are not a
  // conflict, which is asserted separately and was a real mistake in an earlier draft of this
  // fixture.)
  const outcomes = await Promise.all([
    checkAnswerability({ commentText: SHIPPING_COMMENT, results: [section()], complete: answering('{"canAnswer":false}') }),
    checkAnswerability({ commentText: PRICE_COMMENT, results: [section()], complete: answering('garbage') }),
    checkAnswerability({ commentText: PRICE_COMMENT, results: [] }),
    checkAnswerability({
      commentText: PRICE_COMMENT,
      results: [
        section({ documentId: 'doc-a', document: { id: 'doc-a', filename: 'a.md', enabled: true, priority: 0, version: 1, updatedAt: 1 }, content: '350' }),
        section({ documentId: 'doc-b', evidenceId: 'EV-2', document: { id: 'doc-b', filename: 'b.md', enabled: true, priority: 0, version: 1, updatedAt: 1 }, content: '370' })
      ],
      complete: answering('{"canAnswer":true}')
    })
  ]);

  const names = [ANSWERABILITY.NO_SUPPORTED_ANSWER, ANSWERABILITY.UNDETERMINED, ANSWERABILITY.NO_RELEVANT_KNOWLEDGE, ANSWERABILITY.CONFLICTING_KNOWLEDGE];
  outcomes.forEach((outcome, i) => {
    if (outcome.status !== names[i]) return `${names[i]} expected, got ${outcome.status}`;
    if (outcome.evidence.length !== 0) return `${outcome.status} handed over evidence`;
  });
  return true;
}

// ─── Failing closed ────────────────────────────────────────────────────────────

async function testAnUnreadableAnswerNeverPermitsAnAnswer() {
  // Every one of these grants permission if it is read as "yes". None may.
  const permissive = [
    '{"canAnswer":"true"}', '{"canAnswer":1}', '{"canAnswer":"yes"}', '{"canAnswer":{}}',
    '{"canAnswer":[]}', '{"canAnswer":null}', '{}', '{"cananswer":true}',
    'garbage', '', '{', 'null', 'true', '{"canAnswer":true,}', '{"a":{"canAnswer":true}}'
  ];

  for (const text of permissive) {
    const outcome = await checkAnswerability({
      commentText: PRICE_COMMENT,
      results: [section()],
      complete: answering(text)
    });
    if (outcome.status === ANSWERABILITY.CAN_ANSWER) {
      return `${JSON.stringify(text)} was read as permission to answer`;
    }
    if (outcome.status !== ANSWERABILITY.UNDETERMINED) {
      return `${JSON.stringify(text)} → status ${outcome.status}`;
    }
    if (outcome.code !== KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED) {
      return `${JSON.stringify(text)} → code ${outcome.code}`;
    }
    if (outcome.evidence.length !== 0) return `${JSON.stringify(text)} → evidence survived`;
  }
  return true;
}

async function testAModelFailureFailsClosed() {
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: async () => { throw new Error('LM Studio unreachable'); }
  });

  if (outcome.status === ANSWERABILITY.CAN_ANSWER) return 'an outage permitted an answer';
  if (outcome.status !== ANSWERABILITY.UNDETERMINED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testAMissingCompletionFunctionFailsClosed() {
  const outcome = await checkAnswerability({ commentText: PRICE_COMMENT, results: [section()] });
  if (outcome.status !== ANSWERABILITY.UNDETERMINED) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testAnEmptyResponseFailsClosed() {
  // A reasoning model that spent its whole token budget thinking leaves nothing behind.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('   ')
  });
  if (outcome.status !== ANSWERABILITY.UNDETERMINED) return `status was ${outcome.status}`;
  return true;
}

async function testAModelFailureIsNotASupportedSkip() {
  // THE distinction in this file. "The model failed" and "your base has no shipping
  // duration" are both skips to a viewer, and §32 files them under different categories
  // precisely so the UI does not report a broken model as a complete knowledge base.
  const failed = await checkAnswerability({
    commentText: SHIPPING_COMMENT,
    results: [section()],
    complete: answering('nonsense')
  });
  const unsupported = await checkAnswerability({
    commentText: SHIPPING_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":false}')
  });

  if (isExpectedKnowledgeSkip(failed.code)) return 'a model failure counts as a healthy skip';
  if (!isExpectedKnowledgeSkip(unsupported.code)) return 'a supported-answer skip is not an expected skip';

  if (categorizeKnowledgeError(failed.code) !== ERROR_CATEGORY.AI) return `failed bucket: ${categorizeKnowledgeError(failed.code)}`;
  if (categorizeKnowledgeError(unsupported.code) !== ERROR_CATEGORY.EXPECTED_SKIP) {
    return `unsupported bucket: ${categorizeKnowledgeError(unsupported.code)}`;
  }
  return true;
}

// ─── Not manufacturing skips ───────────────────────────────────────────────────

async function testASupportedAnswerIsNotRefused() {
  // The other direction: the gate exists to skip, so it must still be willing to answer, or
  // Knowledge Mode produces nothing at all.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":0.9,"reason":"the price is stated"}')
  });
  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testPriceGivenButDurationAskedIsNotAnswerable() {
  // §13's exact case, and the one a naive containment check gets wrong: the sections DO
  // contain shipping information, just not shipping DURATION. The gate's whole job is
  // noticing that difference.
  const outcome = await checkAnswerability({
    commentText: SHIPPING_COMMENT,
    results: [
      section({ evidenceId: 'S1', filename: 'shipping.md', headingPath: ['الشحن'], content: 'الشحن 30 جنيه للكتاب الواحد، ومجاناً للكتابين.' }),
      section({ evidenceId: 'S2', filename: 'shipping.md', headingPath: ['سياسة الشحن المجاني'], content: 'الشحن مجاني للكتب الأكثر من واحد.' })
    ],
    complete: answering('{"canAnswer":false,"reason":"Shipping duration is not provided"}')
  });

  if (outcome.status !== ANSWERABILITY.NO_SUPPORTED_ANSWER) return `status was ${outcome.status}`;
  return true;
}

async function testConfidenceIsRecordedButNeverGates() {
  // A model's self-reported confidence is uncalibrated. A threshold built on it either never
  // fires or fires arbitrarily, and either way it silently decides whether a viewer gets an
  // answer. So confidence is surfaced, never enforced.
  const low = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":0.01}')
  });
  if (low.status !== ANSWERABILITY.CAN_ANSWER) return `a confidence of 0.01 changed the verdict`;

  const high = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":1}')
  });
  if (high.confidence !== 1) return `confidence was ${high.confidence}`;

  const nonsense = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":"very"}')
  });
  if (nonsense.confidence !== null) return `a nonsense confidence was recorded: ${nonsense.confidence}`;
  if (nonsense.status !== ANSWERABILITY.CAN_ANSWER) return 'a nonsense confidence changed the verdict';

  const negative = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: answering('{"canAnswer":true,"confidence":-4}')
  });
  if (negative.confidence !== null) return `an out-of-range confidence was recorded: ${negative.confidence}`;

  return true;
}

// ─── §18: conflicts are decided locally ────────────────────────────────────────

async function testEqualAuthorityContradictionIsAConflict() {
  // §38 Test 5. Two documents, same authority, different prices under the same heading.
  const document = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-a', document: document('doc-a', 'chemistry-old.md'), content: 'السعر 350 جنيه.' }),
      section({ documentId: 'doc-b', evidenceId: 'EV-2', document: document('doc-b', 'chemistry-new.md'), content: 'السعر 370 جنيه.' })
    ],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.CONFLICTING_KNOWLEDGE) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE) return `code was ${outcome.code}`;
  if (!/equal authority/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  return true;
}

async function testAConflictIsNeverPutToTheModel() {
  // §18: "The model must not simply choose one based on intuition." Asking it would invite
  // exactly that, and a conflict is settled without spending a request.
  let called = false;
  const document = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-a', document: document('doc-a', 'a.md'), content: '350' }),
      section({ documentId: 'doc-b', evidenceId: 'EV-2', document: document('doc-b', 'b.md'), content: '370' })
    ],
    complete: async () => { called = true; return { text: '{"canAnswer":true}' }; }
  });

  if (called) return 'a conflict was put to the model';
  return true;
}

async function testPrecedenceResolvesAConflictWithoutOne() {
  // §18's resolution mechanisms must actually be used: a higher-priority document wins and
  // the comment is answerable.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-old', document: { id: 'doc-old', filename: 'old.md', enabled: true, priority: 0, version: 1, updatedAt: 1 }, content: '350' }),
      section({
        documentId: 'doc-new', evidenceId: 'EV-2',
        document: { id: 'doc-new', filename: 'new.md', enabled: true, priority: 10, version: 2, updatedAt: 5000 },
        content: '370'
      })
    ],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testDocumentsThatAgreeAreNotAConflict() {
  // A user keeping a backup copy of a price list must not make every price question
  // unanswerable. Identical bodies disagree about nothing.
  const document = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-a', document: document('doc-a', 'books.md'), content: 'السعر 350 جنيه.' }),
      section({ documentId: 'doc-b', evidenceId: 'EV-2', document: document('doc-b', 'backup.md'), content: 'السعر 350 جنيه.' })
    ],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testDocumentsCoveringDifferentSubjectsAreNotAConflict() {
  // Equal authority but complementary content is a well-organised base, not a broken one.
  const document = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-a', document: document('doc-a', 'books.md'), headingPath: ['السعر'], content: '350' }),
      section({ documentId: 'doc-b', evidenceId: 'EV-2', document: document('doc-b', 'policies.md'), headingPath: ['سياسة الإرجاع'], content: 'يُرجع خلال أسبوعين.' })
    ],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testADisabledDocumentIsNotAConflict() {
  // A switched-off document is out of scope, not contradictory. Mixing it in would make any
  // base with one disabled file look broken.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [
      section({ documentId: 'doc-a', document: { id: 'doc-a', filename: 'a.md', enabled: true, priority: 0, version: 1, updatedAt: 1 }, content: '350' }),
      section({ documentId: 'doc-off', evidenceId: 'EV-2', document: { id: 'doc-off', filename: 'old.md', enabled: false, priority: 0, version: 1, updatedAt: 1 }, content: '999' })
    ],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testOneDocumentIsNeverAConflict() {
  // The common case, and the cheapest to get wrong: a base where everything is in one file.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section(), section({ evidenceId: 'EV-2', headingPath: ['كيمياء', 'التغطية'], content: 'يغطي التفوق.' })],
    complete: answering('{"canAnswer":true}')
  });
  if (outcome.status !== ANSWERABILITY.CAN_ANSWER) return `status was ${outcome.status}: ${outcome.reason}`;
  return true;
}

async function testDetectConflictIsTotal() {
  for (const input of [null, undefined, [], 'x', 42, [null, undefined, {}], [section()]]) {
    const outcome = detectConflict(input);
    if (outcome.conflicting) return `${JSON.stringify(input)} reported a conflict`;
    if (!Array.isArray(outcome.documents)) return `${JSON.stringify(input)} → documents not an array`;
  }
  return true;
}

// ─── Nothing retrieved, and an unusable index ──────────────────────────────────

async function testNothingRetrievedIsNotASupportedSkip() {
  // "No relevant knowledge" is a retrieval issue (§32), not the feature declining to answer.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [],
    retrievalStatus: RETRIEVAL_STATUS.NO_RESULTS,
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.NO_RELEVANT_KNOWLEDGE) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE) return `code was ${outcome.code}`;
  if (isExpectedKnowledgeSkip(outcome.code)) return 'an empty retrieval counts as a healthy skip';
  return true;
}

async function testABrokenIndexIsNotReportedAsHealthy() {
  // Empty results because the INDEX was unusable is a system failure. Reporting it as "no
  // relevant knowledge" is the same misreading AGENTS.md records for a missed trigger match:
  // the base looks complete when it was never read.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [],
    retrievalStatus: RETRIEVAL_STATUS.UNAVAILABLE,
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.code !== KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED) return `code was ${outcome.code}`;
  if (categorizeKnowledgeError(outcome.code) !== ERROR_CATEGORY.SYSTEM) return `bucket: ${categorizeKnowledgeError(outcome.code)}`;
  return true;
}

async function testNothingRetrievedCostsNoRequest() {
  let called = false;
  await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [],
    complete: async () => { called = true; return { text: '{"canAnswer":true}' }; }
  });
  if (called) return 'the model was asked to judge an empty evidence set';
  return true;
}

// ─── Evidence bounding ─────────────────────────────────────────────────────────

async function testOverflowIsDroppedNotTruncated() {
  // A section cut mid-number is worse than no section: the model is being asked whether the
  // knowledge supports an answer, and a truncated price supports a wrong one.
  const long = 'السعر '.repeat(400);
  const { offered, dropped } = selectEvidence([
    section({ evidenceId: 'SHORT', content: '350' }),
    section({ evidenceId: 'LONG', content: long })
  ]);

  if (offered.length !== 1 || offered[0].evidenceId !== 'SHORT') return `offered ${offered.map((o) => o.evidenceId)}`;
  if (dropped !== 1) return `dropped was ${dropped}`;
  for (const item of offered) {
    if (item.content.length > ANSWERABILITY_DEFAULTS.maxSectionChars) return 'a section was truncated rather than dropped';
  }
  return true;
}

async function testTheSectionCapIsEnforcedByDropping() {
  const many = [];
  for (let i = 0; i < ANSWERABILITY_DEFAULTS.maxSections + 4; i++) {
    many.push(section({ evidenceId: `EV-${i}`, content: `section ${i}` }));
  }
  const { offered, dropped } = selectEvidence(many);

  if (offered.length !== ANSWERABILITY_DEFAULTS.maxSections) return `offered ${offered.length}`;
  if (dropped !== 4) return `dropped was ${dropped}`;
  return true;
}

async function testOversizedSectionsAloneAreNotASupportedSkip() {
  // Sections existed but none fit the budget. That is a retrieval-shaped problem, and
  // reporting it as "no supported answer" would blame the user's Markdown for our limits.
  const outcome = await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section({ content: 'السعر '.repeat(400) })],
    complete: answering('{"canAnswer":true}')
  });

  if (outcome.status !== ANSWERABILITY.NO_RELEVANT_KNOWLEDGE) return `status was ${outcome.status}`;
  if (outcome.code !== KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE) return `code was ${outcome.code}`;
  if (!/character limit/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  return true;
}

// ─── The request ───────────────────────────────────────────────────────────────

async function testThePromptDoesNotInviteAnAnswer() {
  // A judge asked to decide whether it "can" help will help. The prompt has to forbid it.
  const [system, user] = buildAnswerabilityMessages(PRICE_COMMENT, [
    { filename: 'books/chemistry.md', headingPath: ['السعر'], content: '350 جنيه' }
  ]);
  const instruction = `${system.content}\n${user.content}`;

  if (!/Never answer the comment/i.test(instruction)) return 'the prompt does not forbid answering';
  if (!/duration/i.test(instruction)) return 'the prompt does not describe the missing-detail case';
  if (!/JSON only/i.test(instruction)) return 'the prompt does not require JSON only';
  return true;
}

async function testThePromptDoesNotLeakTheIntent() {
  // Naming the intent biases the judge toward finding the fact, and this is the last gate
  // before generation — the most expensive place for that bias to exist.
  // Tested STRUCTURALLY rather than by grepping the prompt for the word "shipping": the
  // prompt legitimately contains "shipping duration" as the §13 worked example, so a
  // substring check would fail on correct code. The guarantee is that the function has NO
  // intent parameter, so there is no way for a caller to leak one in.
  if (buildAnswerabilityMessages.length !== 2) {
    return `the prompt builder takes ${buildAnswerabilityMessages.length} parameters — a third ` +
      'would be a way to pass the intent in';
  }

  // Passing one anyway must not reach the model.
  const leaked = buildAnswerabilityMessages(
    PRICE_COMMENT,
    [{ filename: 'a.md', headingPath: ['السعر'], content: '350' }],
    { intent: 'book_price', entities: { subject: 'كيمياء' } }
  );
  const whole = JSON.stringify(leaked);
  for (const value of ['book_price', 'entityValueShouldNotAppear']) {
    if (whole.includes(value)) return `the prompt mentions ${value}`;
  }
  return true;
}

async function testThePromptShowsTheCommentAndTheSections() {
  const messages = buildAnswerabilityMessages(PRICE_COMMENT, [
    { filename: 'books/chemistry.md', headingPath: ['كيمياء', 'السعر'], content: 'السعر 350 جنيه' }
  ]);
  const user = messages[messages.length - 1].content;

  if (!user.includes(PRICE_COMMENT)) return 'the comment is missing';
  if (!user.includes('350')) return 'the section content is missing';
  if (!user.includes('books/chemistry.md')) return 'the filename is missing';
  if (!user.includes('كيمياء')) return 'the heading path is missing';
  return true;
}

async function testTheRequestIsDeterministicAndNamed() {
  if (ANSWERABILITY_OPTIONS.temperature !== 0) return `temperature is ${ANSWERABILITY_OPTIONS.temperature}`;

  let operation = '';
  await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: async (m, o) => { operation = o.operation; return { text: '{"canAnswer":true}' }; }
  });
  if (operation !== 'ANSWERABILITY') return `operation was ${operation}`;
  return true;
}

/**
 * Phase 20.24 — the ceiling must clear a reasoning model's thinking.
 *
 * Asserted HERE as well as in reasoning-budget-tests.js on purpose. This gate fails CLOSED, so
 * a truncated answer is UNDETERMINED: every comment goes unanswered and a healthy knowledge
 * base reads as knowing nothing. That is the single most expensive consequence of the budget
 * bug, and it is invisible from the module that owns the rule.
 */
async function testTheCeilingClearsReasoningAndOptsOutOfTheFallback() {
  let seen = null;
  await checkAnswerability({
    commentText: PRICE_COMMENT,
    results: [section()],
    complete: async (m, o) => { seen = o; return { text: '{"canAnswer":true}' }; }
  });

  if (!seen) return 'the completion function was never called';
  // Exact composition, not a lower bound: the ceiling must be the payload plus the shared
  // headroom, so a payload change here cannot quietly shrink the room for thinking.
  if (seen.maxTokens !== ANSWERABILITY_DEFAULTS.maxTokens + REASONING_HEADROOM_TOKENS) {
    return (
      `maxTokens ${seen.maxTokens} is not the payload (${ANSWERABILITY_DEFAULTS.maxTokens}) plus ` +
      `the headroom (${REASONING_HEADROOM_TOKENS})`
    );
  }
  // And it must clear what the model actually spends: 399 reasoning tokens, measured.
  if (seen.maxTokens < 399 + ANSWERABILITY_DEFAULTS.maxTokens) {
    return `maxTokens ${seen.maxTokens} cannot hold the ~399 reasoning tokens measured plus the verdict`;
  }
  if (seen.allowReasoningFallback !== false) {
    return (
      'a structured call must opt out of the reasoning_content fallback — otherwise an ' +
      'exhausted budget is reported as a parse failure on a paragraph of thinking'
    );
  }
  return true;
}

// ─── Parsing ───────────────────────────────────────────────────────────────────

async function testParsingIsTotalAndStrict() {
  const hostile = [null, 42, {}, [], true, '{', '}{', '{"canAnswer":"true"}', '{"canAnswer":1}'];
  for (const value of hostile) {
    const parsed = parseAnswerabilityResult(value);
    if (parsed.ok) return `${JSON.stringify(value)} parsed`;
    if (parsed.canAnswer !== false) return `${JSON.stringify(value)} → canAnswer ${parsed.canAnswer}`;
  }

  // Fences and prose are common enough that a bare parse would fail on correct answers.
  for (const text of [
    '```json\n{"canAnswer":true,"confidence":0.9}\n```',
    'Sure:\n{"canAnswer":true,"confidence":0.9}\nDone.'
  ]) {
    const parsed = parseAnswerabilityResult(text);
    if (!parsed.ok || parsed.canAnswer !== true) return `${JSON.stringify(text.slice(0, 20))} → ${JSON.stringify(parsed)}`;
  }

  // A reason is optional; a verdict without one is still a verdict.
  const noReason = parseAnswerabilityResult('{"canAnswer":false}');
  if (!noReason.ok || noReason.canAnswer !== false) return 'a verdict without a reason was rejected';

  return true;
}

async function testEveryOutcomeHasOneShape() {
  const outcomes = await Promise.all([
    checkAnswerability({ commentText: PRICE_COMMENT, results: [section()], complete: answering('{"canAnswer":true}') }),
    checkAnswerability({ commentText: PRICE_COMMENT, results: [section()], complete: answering('{"canAnswer":false}') }),
    checkAnswerability({ commentText: PRICE_COMMENT, results: [section()], complete: answering('garbage') }),
    checkAnswerability({ commentText: PRICE_COMMENT, results: [], retrievalStatus: RETRIEVAL_STATUS.NO_RESULTS }),
    checkAnswerability({
      commentText: PRICE_COMMENT,
      results: [
        section({ documentId: 'doc-a', document: { id: 'doc-a', filename: 'a.md', enabled: true, priority: 0, version: 1, updatedAt: 1 } }),
        section({ documentId: 'doc-b', evidenceId: 'EV-2', document: { id: 'doc-b', filename: 'b.md', enabled: true, priority: 0, version: 1, updatedAt: 1 } })
      ],
      complete: answering('{"canAnswer":true}')
    })
  ]);

  const shapes = new Set(outcomes.map((o) => Object.keys(o).sort().join(',')));
  if (shapes.size !== 1) throw new Error(`shapes differ: ${[...shapes].join(' | ')}`);

  for (const outcome of outcomes) {
    if (!outcome.code && outcome.status !== ANSWERABILITY.CAN_ANSWER) {
      throw new Error(`${outcome.status} carries no error code`);
    }
    if (outcome.status === ANSWERABILITY.CAN_ANSWER && outcome.code) {
      throw new Error('CAN_ANSWER carries an error code');
    }
  }
  return true;
}

async function testTheGateNeverThrows() {
  // A throwing gate would take down a comment that could have been skipped cleanly.
  for (const args of [
    {},
    { commentText: null, results: null },
    { commentText: PRICE_COMMENT, results: 'not an array' },
    { commentText: PRICE_COMMENT, results: [null, undefined, {}] },
    { commentText: PRICE_COMMENT, results: [section()], complete: null },
    { commentText: PRICE_COMMENT, results: [section()], complete: 42 },
    { commentText: PRICE_COMMENT, results: [section()], options: { maxSections: -1 } }
  ]) {
    const outcome = await checkAnswerability(args);
    if (!outcome || !outcome.status) throw new Error(`${JSON.stringify(args)} → ${JSON.stringify(outcome)}`);
  }
  return true;
}


/**
 * ── Phase 20.19 regression: the gate must be able to SEE a decided contradiction ──
 *
 * `detectConflict()` is handed 20.5's RETRIEVAL RESULTS, and until 20.19 those carried no
 * `priority`, `version` or `updatedAt`. The shared owner then synthesized documents whose
 * authority it had never read, called every pair "equal authority", and the gate SKIPPED
 * the comment. So the practical effect of the bug was: set a higher priority on the
 * current price list, exactly as 20.12's resolution steps instruct, and every question
 * about that price stayed permanently unanswered.
 *
 * These cases are the counterpart to the conflicts suite's, and they assert the thing
 * that actually matters to a viewer — whether the reply happens at all.
 */
const result = (id, filename, content, over) =>
  Object.assign(
    { evidenceId: `EV-${id}`, documentId: id, filename, category: 'books', headingPath: ['السعر'], content },
    over || {}
  );

async function testADecidedContradictionIsNotAConflict() {
  const outcome = detectConflict([
    result('old', 'old.md', 'السعر 350', { priority: 0, version: 1, updatedAt: 100 }),
    result('new', 'new.md', 'السعر 400', { priority: 9, version: 1, updatedAt: 200 })
  ]);
  // §18 decides this, so the base CAN answer and the gate must let generation run.
  if (outcome.conflicting) return `must not conflict once precedence decides it: ${outcome.reason}`;
  if (!outcome.reason) return 'the resolution should be explained';
  return true;
}

async function testEqualAuthorityStillSkipsTheComment() {
  const outcome = detectConflict([
    result('a', 'a.md', '350', { priority: 0, version: 1, updatedAt: 100 }),
    result('b', 'b.md', '400', { priority: 0, version: 1, updatedAt: 100 })
  ]);
  if (!outcome.conflicting) return 'genuinely equal authority must still skip';
  if (outcome.documents.length !== 2) return `documents=${outcome.documents.length}`;
  return true;
}

async function testABackupCopyDoesNotBlockAnAnswer() {
  const outcome = detectConflict([
    result('old', 'old.md', 'السعر 350', { priority: 0, version: 1, updatedAt: 100 }),
    result('new', 'new.md', 'السعر 350', { priority: 5, version: 1, updatedAt: 100 })
  ]);
  if (outcome.conflicting) return 'identical content is agreement and must not block';
  return true;
}

async function testADisabledResultCannotConflict() {
  const outcome = detectConflict([
    result('a', 'a.md', '350', { priority: 0, version: 1, updatedAt: 100 }),
    result('b', 'b.md', '400', { priority: 0, version: 1, updatedAt: 100, enabled: false })
  ]);
  if (outcome.conflicting) return 'a disabled document must not block an answer';
  return true;
}

async function testResultsWithoutAuthorityFieldsStillBlock() {
  // A pre-20.19 shape — no authority fields at all. Precedence cannot be read, so the
  // pair is genuinely undecidable and the gate must keep withholding. Failing OPEN here
  // would mean answering from a contradiction on the strength of data that is absent.
  const outcome = detectConflict([
    { evidenceId: 'EV-a', documentId: 'a', filename: 'a.md', headingPath: ['السعر'], content: '350' },
    { evidenceId: 'EV-b', documentId: 'b', filename: 'b.md', headingPath: ['السعر'], content: '400' }
  ]);
  if (!outcome.conflicting) return 'an undecidable pair must still skip';
  return true;
}

export default async function runAllTests() {
  await runTest('§12 shapes are the shapes the code produces', testReadsTheDocumentedShapes);
  await runTest('the approved evidence is bound to the decision', testTheApprovedEvidenceIsBoundToTheDecision);
  await runTest('only CAN_ANSWER hands over evidence', testEveryOtherOutcomeReturnsNoEvidence);

  await runTest('an unreadable answer never permits an answer', testAnUnreadableAnswerNeverPermitsAnAnswer);
  await runTest('a model failure fails closed', testAModelFailureFailsClosed);
  await runTest('a missing completion function fails closed', testAMissingCompletionFunctionFailsClosed);
  await runTest('an empty response fails closed', testAnEmptyResponseFailsClosed);
  await runTest('a model failure is not a supported skip (§32)', testAModelFailureIsNotASupportedSkip);

  await runTest('a supported answer is not refused', testASupportedAnswerIsNotRefused);
  await runTest('price given but duration asked is not answerable (§13)', testPriceGivenButDurationAskedIsNotAnswerable);
  await runTest('confidence is recorded but never gates', testConfidenceIsRecordedButNeverGates);

  await runTest('equal-authority contradiction is a conflict (§38 Test 5)', testEqualAuthorityContradictionIsAConflict);
  await runTest('a conflict is never put to the model (§18)', testAConflictIsNeverPutToTheModel);
  await runTest('precedence resolves a conflict without one (§18)', testPrecedenceResolvesAConflictWithoutOne);
  await runTest('documents that agree are not a conflict', testDocumentsThatAgreeAreNotAConflict);
  await runTest('documents covering different subjects are not a conflict', testDocumentsCoveringDifferentSubjectsAreNotAConflict);
  await runTest('a disabled document is not a conflict', testADisabledDocumentIsNotAConflict);
  await runTest('one document is never a conflict', testOneDocumentIsNeverAConflict);
  await runTest('detectConflict is total', testDetectConflictIsTotal);

  console.log('\n--- Phase 20.19: a decided contradiction must not skip ---');
  await runTest('Precedence-decided is not a conflict', testADecidedContradictionIsNotAConflict);
  await runTest('Equal authority still skips', testEqualAuthorityStillSkipsTheComment);
  await runTest('A backup copy does not block an answer', testABackupCopyDoesNotBlockAnAnswer);
  await runTest('A disabled result cannot conflict', testADisabledResultCannotConflict);
  await runTest('Absent authority fields still block', testResultsWithoutAuthorityFieldsStillBlock);

  await runTest('nothing retrieved is not a supported skip', testNothingRetrievedIsNotASupportedSkip);
  await runTest('a broken index is not reported as healthy', testABrokenIndexIsNotReportedAsHealthy);
  await runTest('nothing retrieved costs no request', testNothingRetrievedCostsNoRequest);

  await runTest('overflow is dropped, not truncated', testOverflowIsDroppedNotTruncated);
  await runTest('the section cap is enforced by dropping', testTheSectionCapIsEnforcedByDropping);
  await runTest('oversized sections alone are not a supported skip', testOversizedSectionsAloneAreNotASupportedSkip);

  await runTest('the prompt does not invite an answer', testThePromptDoesNotInviteAnAnswer);
  await runTest('the prompt does not leak the intent', testThePromptDoesNotLeakTheIntent);
  await runTest('the prompt shows the comment and the sections', testThePromptShowsTheCommentAndTheSections);
  await runTest('the request is deterministic and named', testTheRequestIsDeterministicAndNamed);
  await runTest('the ceiling clears reasoning and opts out of the fallback', testTheCeilingClearsReasoningAndOptsOutOfTheFallback);

  await runTest('parsing is total and strict', testParsingIsTotalAndStrict);
  await runTest('every outcome has one shape', testEveryOutcomeHasOneShape);
  await runTest('the gate never throws', testTheGateNeverThrows);

  return results;
}
