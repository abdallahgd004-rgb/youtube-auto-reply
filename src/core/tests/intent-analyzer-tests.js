/**
 * AI Intent Understanding Tests — Phase 20.6
 *
 * The output of this stage is the first thing the model produces that is NOT a keyword
 * match, so the tests concentrate on the two ways that goes wrong:
 *
 *   1. **A malformed answer being half-believed.** §20.6 says "Validate the structured
 *      output before using it". Validating loosely is the same as not validating: an
 *      `entities` value that is an object is how a model hands over a composed claim
 *      ("this subject's price is 300") to a stage that is only allowed to carry
 *      understanding. §42 says the knowledge base owns facts, so that test is the important
 *      one in this file.
 *   2. **A failure being treated as fatal.** Unlike `semantic-matcher.js`, an unreadable
 *      intent answer must NOT stop the comment: retrieval already works from the raw
 *      comment. Hence the tests that `ok:false` still returns a usable shape.
 *
 * The §38 Test 1 and Test 3 comments are used verbatim so the intent stage is exercised on
 * the wording the acceptance criteria actually name.
 *
 * Runs in the browser from intent-analyzer-tests.html. No chrome stub and no network:
 * `complete` is injected, which is the whole reason this stage adds no second HTTP client.
 */

import {
  analyzeIntent,
  parseIntentAnalysisResult,
  normalizeIntent,
  toIntentSearchTerms,
  buildIntentAnalysisMessages,
  isFactSeeking,
  INTENT,
  INTENT_ANALYSIS_OPTIONS,
  MAX_INTENT_ENTITIES,
  MAX_ENTITY_VALUE_CHARS,
  MAX_REQUEST_CHARS
} from '../intent-analyzer.js';

import { toRetrievalTerms, rankSections } from '../knowledge-retrieval.js';
import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip } from '../knowledge-schema.js';
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

/** §38 Test 1. */
const PRICE_COMMENT = 'هو تمن كتاب الكيمياء إيه؟';
/** §38 Test 3. */
const SHIPPING_COMMENT = 'الشحن بياخد كام يوم؟';

// ── §9's documented shape ──────────────────────────────────────────────────────

async function testReadsTheDocumentedExample() {
  // §9's example verbatim: the contract in the phase document has to be the contract in
  // the code, or a reader following the spec gets a different shape than they get at runtime.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"subject":"chemistry","grade":"third_secondary"}}')
  });

  if (!outcome.ok) return `not ok: ${outcome.reason}`;
  if (outcome.intent !== 'book_price') return `intent was ${outcome.intent}`;
  if (outcome.entities.subject !== 'chemistry') return `subject was ${outcome.entities.subject}`;
  if (outcome.entities.grade !== 'third_secondary') return `grade was ${outcome.entities.grade}`;
  return true;
}

async function testUnderstandsIntentWithoutExactWords() {
  // The whole point of the phase: "هو تمن" shares no word with "السعر", so a keyword stage
  // cannot reach this and the intent stage must.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"subject":"الكيمياء"}}')
  });

  if (outcome.intent !== INTENT.BOOK_PRICE) return `intent was ${outcome.intent}`;
  return true;
}

async function testShippingIsNotAPrice() {
  // §38 Test 3's comment asks about shipping. Reading it as book_price would send 20.7
  // looking for a price the base does not have, and the failure would be reported as a
  // missing price rather than a misread question.
  const outcome = await analyzeIntent({
    commentText: SHIPPING_COMMENT,
    complete: answering('{"intent":"shipping","entities":{}}')
  });

  if (outcome.intent !== INTENT.SHIPPING) return `intent was ${outcome.intent}`;
  return true;
}

async function testPraiseIsNotFactSeeking() {
  // A praise comment has nothing to look up. Classifying it as fact-seeking would push a
  // meaningless retrieval through the pipeline on every "ما شاء الله" the channel gets.
  const outcome = await analyzeIntent({
    commentText: 'ما شاء الله مجهود رائع',
    complete: answering('{"intent":"praise","entities":{}}')
  });

  if (outcome.intent !== INTENT.PRAISE) return `intent was ${outcome.intent}`;
  if (outcome.factSeeking !== false) return 'praise was marked fact-seeking';
  if (isFactSeeking(INTENT.PRAISE)) return 'isFactSeeking disagrees with the result';
  return true;
}

async function testAnUnknownReadingIsNotAnError() {
  // `unknown` is a legitimate classification, not a failure — a model that cannot tell must
  // be able to say so without being treated as broken.
  const outcome = await analyzeIntent({
    commentText: '؟؟',
    complete: answering('{"intent":"unknown","entities":{}}')
  });

  if (!outcome.ok) return 'a deliberate unknown was treated as a failure';
  if (outcome.intent !== INTENT.UNKNOWN) return `intent was ${outcome.intent}`;
  if (outcome.code) return `a successful result carried the code ${outcome.code}`;
  return true;
}

// ── The closed vocabulary IS the validation ─────────────────────────────────────

async function testAnInventedIntentBecomesUnknown() {
  // An open vocabulary would make every string the model emits a valid intent, which is
  // validation that cannot fail.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price_with_discount","entities":{}}')
  });

  if (!outcome.ok) return 'an invented intent was treated as a parse failure';
  if (outcome.intent !== INTENT.UNKNOWN) return `intent was ${outcome.intent}`;
  return true;
}

async function testIntentPunctuationVariantsFold() {
  // A model asked for a slug will sometimes answer "Book Price" or "book-price" for the
  // same intent. Rejecting those rejects the CORRECT answer over punctuation.
  for (const written of ['Book Price', 'book-price', ' book price ', 'BOOK_PRICE']) {
    const outcome = await analyzeIntent({
      commentText: PRICE_COMMENT,
      complete: answering(JSON.stringify({ intent: written, entities: {} }))
    });
    if (outcome.intent !== INTENT.BOOK_PRICE) return `"${written}" became ${outcome.intent}`;
  }
  return true;
}

async function testNormalizeIntentIsTotal() {
  for (const value of [null, undefined, 42, {}, [], '', '   ', '💰', 'PRICE', 'book_price']) {
    const intent = normalizeIntent(value);
    if (!Object.values(INTENT).includes(intent)) return `${JSON.stringify(value)} → ${intent}`;
  }
  return true;
}

// ── §42: the output is not the source of truth ─────────────────────────────────

async function testAnObjectEntityIsRejected() {
  // THE test in this file. A nested object is the shape a model uses to hand over a
  // composed claim — {"subject":{"name":"كيمياء","price":300}} — to a stage that may only
  // carry understanding. Coercing it to a string would launder an invented price into the
  // pipeline, and §42 puts facts with the knowledge base, not the model.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"subject":{"name":"كيمياء","price":300}}}')
  });

  if (outcome.ok) return 'an object entity was accepted';
  if (Object.keys(outcome.entities).length !== 0) return 'entities survived a rejected answer';
  if (outcome.code !== KNOWLEDGE_ERROR.INTENT_PARSE_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testAnArrayEntityIsRejected() {
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"subjects":["كيمياء","فيزياء"]}}')
  });

  if (outcome.ok) return 'an array entity was accepted';
  if (Object.keys(outcome.entities).length !== 0) return 'entities survived a rejected answer';
  return true;
}

async function testAPriceInAnEntityIsNeverAFact() {
  // Even as a STRING, a price handed over by the model must not be able to travel anywhere
  // except as a retrieval term. The regression that matters is someone adding a field to
  // this result later — an `answer`, an `extracted`, anything a caller could read as a fact —
  // so the guarantee is asserted structurally: the result carries EXACTLY these keys.
  //
  // (Asserting this by scanning for the substring "fact" would be a bad test: `factSeeking`
  // is a legitimate field, and it would fail on correct code.)
  const ALLOWED_FIELDS = [
    'ok', 'intent', 'entities', 'request', 'factSeeking',
    'searchTerms', 'code', 'reason', 'raw'
  ].sort().join(',');

  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"price":"300 جنيه"}}')
  });

  if (!outcome.ok) return `a well-formed entity was rejected: ${outcome.reason}`;

  const fields = Object.keys(outcome).sort().join(',');
  if (fields !== ALLOWED_FIELDS) return `unexpected fields: ${fields}`;

  // The price is carried as a string entity and as a retrieval term. That is the whole of
  // its journey here: 20.5 decides which sections those terms select, and 20.7 and 20.10
  // decide what may actually be said. Nothing in this result is an answer.
  if (outcome.entities.price !== '300 جنيه') return `entity was ${outcome.entities.price}`;
  if (!outcome.searchTerms.includes('300')) return `the term was lost: ${outcome.searchTerms}`;

  for (const value of Object.values(outcome.entities)) {
    if (typeof value !== 'string') return `a ${typeof value} survived as an entity value`;
  }
  return true;
}

async function testEntityValuesAreValidatedStrings() {
  // Numbers and booleans are legitimate entity values ("grade 3"), so they are coerced
  // rather than dropped — discarding them would lose real understanding.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"quantity":3,"available":true,"subject":" كيمياء "}}')
  });

  if (!outcome.ok) return `rejected: ${outcome.reason}`;
  if (outcome.entities.quantity !== '3') return `quantity was ${outcome.entities.quantity}`;
  if (outcome.entities.available !== 'true') return `available was ${outcome.entities.available}`;
  if (outcome.entities.subject !== 'كيمياء') return `subject was not trimmed: ${outcome.entities.subject}`;
  for (const value of Object.values(outcome.entities)) {
    if (typeof value !== 'string') return `a ${typeof value} survived as an entity value`;
  }
  return true;
}

async function testEmptyAndAbsentEntitiesAreValid() {
  // "No entities" is a real answer, not a malformed one.
  for (const written of [
    '{"intent":"praise","entities":{}}',
    '{"intent":"praise"}',
    '{"intent":"praise","entities":null}',
    '{"intent":"praise","entities":{"subject":""}}',
    '{"intent":"praise","entities":{"subject":null}}'
  ]) {
    const outcome = await analyzeIntent({
      commentText: 'ما شاء الله',
      complete: answering(written)
    });
    if (!outcome.ok) return `${written} was rejected: ${outcome.reason}`;
    if (Object.keys(outcome.entities).length !== 0) return `${written} produced entities`;
  }
  return true;
}

async function testOversizedOutputIsRejectedNotTruncated() {
  // A silently cut entity is a CORRUPTED entity, and a corrupted retrieval term is worse
  // than none: it steers retrieval toward the wrong section while the caller believes the
  // comment was understood.
  const long = 'ك'.repeat(MAX_ENTITY_VALUE_CHARS + 1);
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering(JSON.stringify({ intent: 'book_price', entities: { subject: long } }))
  });

  if (outcome.ok) return 'an oversized entity value was accepted';
  if (outcome.intent !== INTENT.UNKNOWN) return `intent was ${outcome.intent}`;
  return true;
}

async function testTooManyEntitiesIsRejected() {
  const many = {};
  for (let i = 0; i <= MAX_INTENT_ENTITIES; i++) many[`key${i}`] = `value${i}`;

  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering(JSON.stringify({ intent: 'book_price', entities: many }))
  });

  if (outcome.ok) return `${Object.keys(many).length} entities was accepted`;
  return true;
}

// ── A failure must not stop the comment ────────────────────────────────────────

async function testAnUnreadableAnswerIsNotFatal() {
  // The sharpest difference from semantic-matcher.js. There, an unreadable answer must mean
  // "do not reply". Here it must not: retrieval already works from the raw comment, so
  // failing closed here would trade a working feature for a diagnostic.
  const bad = ['', '   ', 'not json at all', '{', '{"intent":}', '[]', '"book_price"', 'null'];

  for (const text of bad) {
    const outcome = await analyzeIntent({ commentText: PRICE_COMMENT, complete: answering(text) });
    if (outcome.ok) return `${JSON.stringify(text)} was accepted`;
    if (outcome.intent !== INTENT.UNKNOWN) return `${JSON.stringify(text)} → intent ${outcome.intent}`;
    if (Object.keys(outcome.entities).length !== 0) return `${JSON.stringify(text)} → entities survived`;
    if (outcome.code !== KNOWLEDGE_ERROR.INTENT_PARSE_FAILED) return `${JSON.stringify(text)} → code ${outcome.code}`;
    // The caller must still be able to retrieve from the comment it already has.
    if (outcome.searchTerms.length !== 0) return `${JSON.stringify(text)} → searchTerms not empty`;
  }
  return true;
}

async function testAMissingIntentIsRejected() {
  // An entities-only answer is a valid JSON object with no reading in it.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"entities":{"subject":"كيمياء"}}')
  });

  if (outcome.ok) return 'an answer with no intent was accepted';
  if (Object.keys(outcome.entities).length !== 0) return 'entities survived without an intent';
  return true;
}

async function testAModelFailureIsNotFatal() {
  // LM Studio offline, model not loaded, timeout — all indistinguishable here, and none of
  // them is a reason to stop working on the comment.
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: async () => { throw new Error('LM Studio unreachable'); }
  });

  if (outcome.ok) return 'a thrown error was treated as a success';
  if (outcome.intent !== INTENT.UNKNOWN) return `intent was ${outcome.intent}`;
  if (!/LM Studio call failed/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  if (outcome.code !== KNOWLEDGE_ERROR.INTENT_PARSE_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testNoCompletionFunctionIsNotFatal() {
  const outcome = await analyzeIntent({ commentText: PRICE_COMMENT });
  if (outcome.ok) return 'a missing completion function produced a result';
  if (outcome.code !== KNOWLEDGE_ERROR.INTENT_PARSE_FAILED) return `code was ${outcome.code}`;
  return true;
}

async function testAFailedIntentIsAnAiErrorNotAnExpectedSkip() {
  // §32's buckets are what the processing UI groups by. A model failure must land in AI,
  // or "the classifier failed" and "the knowledge base has no price" become indistinguishable
  // — which is the exact misreading AGENTS.md records for semantic matching.
  if (isExpectedKnowledgeSkip(KNOWLEDGE_ERROR.INTENT_PARSE_FAILED)) {
    return 'a model failure is counted as a healthy skip';
  }
  return true;
}

async function testEveryFailureUsesOneShape() {
  // All-or-nothing means every failure returns the SAME fields, so no caller can branch on
  // a half-populated result.
  const failures = await Promise.all([
    analyzeIntent({ commentText: PRICE_COMMENT, complete: answering('garbage') }),
    analyzeIntent({ commentText: PRICE_COMMENT, complete: answering('{"intent":"book_price","entities":{"a":{"b":1}}}') }),
    analyzeIntent({ commentText: PRICE_COMMENT, complete: async () => { throw new Error('x'); } }),
    analyzeIntent({ commentText: PRICE_COMMENT, complete: answering('{"entities":{}}') })
  ]);

  const shapes = failures.map((f) => Object.keys(f).sort().join(','));
  if (new Set(shapes).size !== 1) return `differing shapes: ${JSON.stringify(shapes)}`;
  for (const f of failures) {
    if (f.intent !== INTENT.UNKNOWN) return `intent was ${f.intent}`;
    if (f.factSeeking !== false) return 'a failure claimed to be fact-seeking';
  }
  return true;
}

// ── Retrieval terms ────────────────────────────────────────────────────────────

async function testEntityTermsFoldLikeCommentTerms() {
  // If these two derivations disagreed, a term contributed by intent and a term read out of
  // the comment would stop matching the same heading — which is why toRetrievalTerms is
  // exported from one place rather than reimplemented.
  const fromComment = toRetrievalTerms('الكيمياء');
  const fromEntity = toRetrievalTerms('كيمياء');

  if (fromComment[0] !== fromEntity[0]) {
    return `the article did not fold: ${fromComment[0]} vs ${fromEntity[0]}`;
  }
  return true;
}

async function testSearchTermsComeFromEntityValues() {
  const outcome = await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: answering('{"intent":"book_price","entities":{"subject":"الكيمياء","grade":"ثالثة ثانوي"}}')
  });

  const terms = outcome.searchTerms;
  if (!terms.includes('كيمياء')) return `no folded subject term in ${JSON.stringify(terms)}`;
  if (!terms.includes('ثالثة') || !terms.includes('ثانوي')) return `grade lost: ${JSON.stringify(terms)}`;
  // The slug is an English identifier and the base is Arabic — folding it in would add a
  // term that matches nothing while weighting every section equally.
  if (terms.some((t) => t.includes('book') || t.includes('price'))) {
    return `the intent slug leaked into the query: ${JSON.stringify(terms)}`;
  }
  // Stopwords must not survive into the query.
  if (terms.some((t) => t === 'من' || t === 'في')) return `a stopword leaked: ${JSON.stringify(terms)}`;
  return true;
}

async function testSearchTermsAddToTheCommentRatherThanReplaceIt() {
  // The integration point with 20.5. A section the comment alone already reaches must stay
  // reachable when intent contributes extra terms, and a section only intent reaches must
  // become reachable too.
  const sections = [
    {
      evidenceId: 'A-PRICE',
      headingPath: ['كيمياء', 'السعر'],
      content: 'السعر الحالي: 350 جنيه.',
      searchText: 'كيمياء السعر السعر الحالي 350 جنيه'
    },
    {
      evidenceId: 'B-COVERAGE',
      headingPath: ['كيمياء', 'التغطية'],
      content: 'يغطي التفوق الدوال والتفاعلات.',
      searchText: 'كيمياء التغطية يغطي التفوق الدوال والتفاعلات'
    }
  ];

  const ranked = rankSections(sections, 'هو تمن كتاب إيه؟', ['كيمياء']);
  const ids = ranked.map((r) => r.section.evidenceId);

  if (!ids.includes('A-PRICE')) return `the price section was lost: ${ids}`;
  // Without the entity term the comment's own words do not reach the chemistry sections at
  // all, which is exactly the §38 Test 1 case.
  if (ranked[0].section.evidenceId !== 'A-PRICE' && ranked[0].score === 0) {
    return `nothing matched: ${JSON.stringify(ranked.map((r) => r.score))}`;
  }
  return true;
}

async function testNoIntentMeansTheCommentStillRetrieves() {
  // The property that makes an intent failure survivable, asserted directly: with no
  // intent at all, retrieval still finds the section the comment names.
  const sections = [{
    evidenceId: 'A',
    headingPath: ['الشحن'],
    content: 'الشحن خلال ثلاثة أيام عمل.',
    searchText: 'الشحن الشحن خلال ثلاثة ايام عمل'
  }];

  const ranked = rankSections(sections, SHIPPING_COMMENT, []);
  if (ranked.length === 0 || ranked[0].score <= 0) {
    return `the comment alone retrieved nothing: ${JSON.stringify(ranked.map((r) => r.score))}`;
  }
  return true;
}

// ── The request ────────────────────────────────────────────────────────────────

async function testThePromptDoesNotInviteAFact() {
  // The prompt must not ask the model for an answer, or the model will volunteer one and
  // the "understanding" stage becomes the first place a fact enters the pipeline.
  const [system, , user] = buildIntentAnalysisMessages(PRICE_COMMENT);
  const instruction = `${system.content}\n${user.content}`;

  if (!/never answer the comment/i.test(instruction)) return 'the prompt does not forbid answering';
  if (!/never state a price/i.test(instruction)) return 'the prompt does not forbid stating facts';
  if (!/JSON only/i.test(instruction)) return 'the prompt does not require JSON only';
  return true;
}

async function testThePromptEnumeratesTheVocabulary() {
  // "Choose one of these" is a question a small model answers reliably; "classify the
  // intent" is one it answers with an invented fourth category.
  const [system] = buildIntentAnalysisMessages(PRICE_COMMENT);
  for (const value of Object.values(INTENT)) {
    if (!system.content.includes(value)) return `the prompt omits ${value}`;
  }
  return true;
}

async function testThePromptCarriesTheCommentVerbatim() {
  // §38 Test 2's comment contains invisible marks around real words; the comment is passed
  // through untouched and normalization belongs to the matchers, not to the prompt.
  const comment = 'تم\nجبت كتاب الكيمياء من مكتبة الهدى بـ ٣٥٠ج هو عندكو بكام';
  const messages = buildIntentAnalysisMessages(comment);
  if (!messages[messages.length - 1].content.includes(comment)) return 'the comment was altered';
  return true;
}

async function testDeterministicOptions() {
  // Same comment, same reading. A non-zero temperature here makes intent a source of
  // run-to-run variance, which then looks like retrieval instability.
  if (INTENT_ANALYSIS_OPTIONS.temperature !== 0) return `temperature is ${INTENT_ANALYSIS_OPTIONS.temperature}`;

  const messages = buildIntentAnalysisMessages(PRICE_COMMENT);
  const seen = [];
  await analyzeIntent({ commentText: PRICE_COMMENT, complete: async (m, o) => { seen.push(o.operation); return { text: '{"intent":"book_price","entities":{}}' }; } });

  if (seen[0] !== 'INTENT_ANALYSIS') return `operation was ${seen[0]}`;
  if (!messages.length) return 'no messages were built';
  return true;
}

async function testTheOperationIsNamed() {
  // Without a named operation every knowledge call reads as operation=UNKNOWN in the
  // diagnostic log — the problem AGENTS.md records for semanticMatchTriggers.
  let operation = '';
  await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: async (m, o) => { operation = o.operation; return { text: '{"intent":"praise","entities":{}}' }; }
  });
  if (operation !== 'INTENT_ANALYSIS') return `operation was ${operation}`;
  return true;
}

/**
 * Phase 20.24 — the ceiling must clear a reasoning model's thinking.
 *
 * This call is the one that PASSED at its old budget: 184 reasoning tokens against a 200-token
 * ceiling, sixteen to spare. That is why it is asserted. A stage that fails intermittently, on
 * the longer comments only, with no error anywhere else, is harder to catch than one that is
 * always broken — and it fails OPEN, so every comment it loses is silently unenriched.
 */
async function testTheCeilingClearsReasoningAndOptsOutOfTheFallback() {
  let seen = null;
  await analyzeIntent({
    commentText: PRICE_COMMENT,
    complete: async (m, o) => { seen = o; return { text: '{"intent":"praise","entities":{}}' }; }
  });

  if (!seen) return 'the completion function was never called';
  if (seen.maxTokens !== INTENT_ANALYSIS_OPTIONS.maxTokens) {
    return `the request ceiling does not match the exported options: ${seen.maxTokens}`;
  }
  if (seen.maxTokens < 184 + 200) {
    return `maxTokens ${seen.maxTokens} cannot hold the ~184 reasoning tokens measured plus the 200-token intent payload`;
  }
  if (seen.maxTokens !== 200 + REASONING_HEADROOM_TOKENS) {
    return `maxTokens ${seen.maxTokens} is not the 200-token payload plus the ${REASONING_HEADROOM_TOKENS}-token headroom`;
  }
  if (seen.allowReasoningFallback !== false) {
    return 'a structured call must opt out of the reasoning_content fallback';
  }
  return true;
}

async function testRequestIsOptionalAndBounded() {
  // §8 asks for "what information the commenter is requesting", which 20.8 will need.
  const withRequest = parseIntentAnalysisResult('{"intent":"book_price","entities":{},"request":"the price of the chemistry book"}');
  if (!withRequest.ok || withRequest.request !== 'the price of the chemistry book') {
    return `request was ${withRequest.request}`;
  }

  const without = parseIntentAnalysisResult('{"intent":"book_price","entities":{}}');
  if (!without.ok || without.request !== '') return `absent request became ${without.request}`;

  const long = 'x'.repeat(MAX_REQUEST_CHARS + 1);
  const oversized = parseIntentAnalysisResult(JSON.stringify({ intent: 'book_price', entities: {}, request: long }));
  if (oversized.ok) return 'an oversized request was accepted';

  const wrongType = parseIntentAnalysisResult('{"intent":"book_price","entities":{},"request":42}');
  if (wrongType.ok) return 'a non-string request was accepted';

  return true;
}

async function testAnEmptyCommentCostsNoRequest() {
  let called = false;
  const outcome = await analyzeIntent({
    commentText: '   ',
    complete: async () => { called = true; return { text: '{"intent":"other","entities":{}}' }; }
  });

  if (called) return 'the model was called for an empty comment';
  if (outcome.ok) return 'an empty comment produced a reading';
  return true;
}

// ── Fences and prose ───────────────────────────────────────────────────────────

async function testFencedAndPrefixedJsonIsAccepted() {
  // Models wrap JSON in prose or fences often enough that requiring a bare parse would fail
  // on correct answers.
  const wrapped = [
    '```json\n{"intent":"book_price","entities":{"subject":"كيمياء"}}\n```',
    'Here is the analysis:\n{"intent":"book_price","entities":{"subject":"كيمياء"}}',
    '.comment {"intent":"book_price","entities":{"subject":"كيمياء"}} done.'
  ];

  for (const text of wrapped) {
    const outcome = await analyzeIntent({ commentText: PRICE_COMMENT, complete: answering(text) });
    if (!outcome.ok) return `${JSON.stringify(text.slice(0, 24))} was rejected: ${outcome.reason}`;
    if (outcome.entities.subject !== 'كيمياء') return `subject lost in ${outcome.entities.subject}`;
  }
  return true;
}

async function testParsingNeverThrows() {
  // parseIntentAnalysisResult is called on whatever the model returned, so it must be total.
  const hostile = [null, undefined, 42, {}, [], true, '{"intent":{"a":1}}', '{"intent":[]}',
    '{"intent":"book_price","entities":"string"}', '{"intent":"book_price","entities":[]}',
    '{"intent":"book_price","entities":{"":"x"}}', '{}{}', '}{'];

  for (const value of hostile) {
    const parsed = parseIntentAnalysisResult(value);
    if (parsed.ok) return `${JSON.stringify(value)} parsed`;
    if (parsed.intent !== INTENT.UNKNOWN) return `${JSON.stringify(value)} → ${parsed.intent}`;
    if (Object.keys(parsed.entities).length !== 0) return `${JSON.stringify(value)} → entities survived`;
  }
  return true;
}

export default async function runAllTests() {
  await runTest('§9 example shape is the shape the code produces', testReadsTheDocumentedExample);
  await runTest('intent is understood without exact words (§38 Test 1)', testUnderstandsIntentWithoutExactWords);
  await runTest('a shipping question is not read as a price question (§38 Test 3)', testShippingIsNotAPrice);
  await runTest('praise is not fact-seeking', testPraiseIsNotFactSeeking);
  await runTest('a deliberate unknown is not a failure', testAnUnknownReadingIsNotAnError);

  await runTest('an invented intent becomes unknown', testAnInventedIntentBecomesUnknown);
  await runTest('intent punctuation variants fold to the same intent', testIntentPunctuationVariantsFold);
  await runTest('normalizeIntent is total', testNormalizeIntentIsTotal);

  await runTest('an object entity is rejected (§42)', testAnObjectEntityIsRejected);
  await runTest('an array entity is rejected (§42)', testAnArrayEntityIsRejected);
  await runTest('no entity value can travel as a fact (§42)', testAPriceInAnEntityIsNeverAFact);
  await runTest('entity values are validated strings', testEntityValuesAreValidatedStrings);
  await runTest('empty and absent entities are valid', testEmptyAndAbsentEntitiesAreValid);
  await runTest('oversized output is rejected, not truncated', testOversizedOutputIsRejectedNotTruncated);
  await runTest('too many entities is rejected', testTooManyEntitiesIsRejected);

  await runTest('an unreadable answer is not fatal', testAnUnreadableAnswerIsNotFatal);
  await runTest('an answer with no intent is rejected', testAMissingIntentIsRejected);
  await runTest('a model failure is not fatal', testAModelFailureIsNotFatal);
  await runTest('a missing completion function is not fatal', testNoCompletionFunctionIsNotFatal);
  await runTest('a model failure is an AI error, not a healthy skip (§32)', testAFailedIntentIsAnAiErrorNotAnExpectedSkip);
  await runTest('every failure returns one shape', testEveryFailureUsesOneShape);

  await runTest('entity terms fold exactly like comment terms', testEntityTermsFoldLikeCommentTerms);
  await runTest('search terms come from entity values only', testSearchTermsComeFromEntityValues);
  await runTest('search terms add to the comment rather than replace it', testSearchTermsAddToTheCommentRatherThanReplaceIt);
  await runTest('no intent at all still leaves the comment retrievable', testNoIntentMeansTheCommentStillRetrieves);

  await runTest('the prompt does not invite a fact', testThePromptDoesNotInviteAFact);
  await runTest('the prompt enumerates the closed vocabulary', testThePromptEnumeratesTheVocabulary);
  await runTest('the prompt carries the comment verbatim (§38 Test 2)', testThePromptCarriesTheCommentVerbatim);
  await runTest('the call is deterministic and named', testDeterministicOptions);
  await runTest('the operation is named in diagnostics', testTheOperationIsNamed);
  await runTest('the ceiling clears reasoning and opts out of the fallback', testTheCeilingClearsReasoningAndOptsOutOfTheFallback);
  await runTest('request is optional and bounded (§8)', testRequestIsOptionalAndBounded);
  await runTest('an empty comment costs no request', testAnEmptyCommentCostsNoRequest);

  await runTest('fenced and prefixed JSON is accepted', testFencedAndPrefixedJsonIsAccepted);
  await runTest('parsing never throws on hostile input', testParsingNeverThrows);

  return results;
}
