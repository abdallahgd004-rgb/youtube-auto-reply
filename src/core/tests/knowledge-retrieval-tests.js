/**
 * Knowledge Retrieval Tests — Phase 20.5
 *
 * Retrieval is where a section stops being text and becomes something a reply may be
 * grounded in, so these cases concentrate on the two ways that goes wrong:
 *
 *   1. **Retrieving nothing that is actually relevant** — the silent one. A local
 *      substring filter drops "بكام" because the knowledge says "السعر", and the one
 *      comment §38 Test 2 requires is skipped with no error anywhere. Hence the tests around
 *      paraphrase and about the local score never being a hard filter.
 *   2. **Retrieving something that is not supported** — the loud one. Hence the tests that
 *      the model cannot invent a section, and cannot turn its own failure into "no results".
 *
 * §37's retrieval list is walked explicitly: exact relevance, different wording, synonyms,
 * Arabic wording variations, irrelevant comments, multiple relevant sections, no relevant
 * knowledge.
 *
 * Runs in the browser from knowledge-retrieval-tests.html. No chrome stub: retrieval is a
 * pure function of (comment, index) plus an injected completion function.
 */

import {
  retrieveKnowledge,
  rankSections,
  scoreSection,
  toCandidateShortlist,
  parseRerankResult,
  RETRIEVAL_DEFAULTS,
  RETRIEVAL_STATUS,
  RETRIEVAL_STATE,
  RERANK_OPTIONS
} from '../knowledge-retrieval.js';
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

/** Build an index-shaped object, as getKnowledgeIndex() would return. */
function indexOf(sections, overrides = {}) {
  return {
    retrievable: true,
    state: 'fresh',
    sections: sections.map((s, i) => ({
      id: `ksec-${i}`,
      evidenceId: s.evidenceId,
      documentId: 'kdoc-1',
      filename: s.filename || 'books/chemistry.md',
      category: 'books',
      headingPath: s.headingPath || ['السعر'],
      content: s.content,
      empty: false,
      ordinal: i,
      // searchText is what retrieval reads; the real index builds it at index time.
      searchText: `${(s.headingPath || ['السعر']).join(' ')} ${s.content}`,
      enabled: true,
      priority: 0,
      version: 1,
      updatedAt: 0,
      charCount: s.content.length
    })),
    ...overrides
  };
}

const PRICE = indexOf([
  { content: 'السعر الحالي: 350 جنيه.', evidenceId: 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر' }
]);
const SHIPPING_COST = indexOf([
  { content: 'شحن كتاب واحد: 30 جنيه. الشحن مجاني عند شراء كتابين أو أكثر.', evidenceId: 'KNOWLEDGE-SHIPPING-الشحن' }
]);

/** A completion function that answers with a fixed JSON body. */
function completing(text) {
  return async () => ({ text });
}

/** A completion function that identifies the top section by name and returns its id. */
function rerankingFirstId() {
  return async (messages) => {
    const offered = String(messages[1].content).match(/id: (\S+)/);
    return { text: JSON.stringify({ ranked: [{ id: offered ? offered[1] : '', score: 0.9 }] }) };
  };
}

// ── The gate ──────────────────────────────────────────────────────────────────

async function testAnUnusableIndexIsRefused() {
  // Retrieval must not be a second way into an index. If it were, a caller that skipped
  // getKnowledgeIndex() could reach a stale base.
  for (const index of [null, undefined, {}, { retrievable: false }, { retrievable: false, sections: [] }]) {
    const outcome = await retrieveKnowledge({ commentText: 'بكام؟', index });
    if (outcome.status !== RETRIEVAL_STATUS.UNAVAILABLE) {
      return `An unusable index returned ${outcome.status}`;
    }
    if (outcome.code !== 'KNOWLEDGE_INDEX_FAILED') return `Unexpected code: ${outcome.code}`;
    if (outcome.results.length !== 0) return 'An unusable index returned results';
  }
  return true;
}

async function testAnEmptyBaseIsNoResultsNotAFailure() {
  const outcome = await retrieveKnowledge({ commentText: 'بكام؟', index: indexOf([]) });
  if (outcome.status !== RETRIEVAL_STATUS.UNAVAILABLE) return `Unexpected status: ${outcome.status}`;
  if (outcome.code !== 'NO_RELEVANT_KNOWLEDGE') return `Unexpected code: ${outcome.code}`;
  return true;
}

// ── §37: exact relevance ──────────────────────────────────────────────────────

async function testAnExactQuestionFindsItsSection() {
  const outcome = await retrieveKnowledge({ commentText: 'سعر كتاب الكيمياء كام؟', index: PRICE });
  if (outcome.status !== RETRIEVAL_STATUS.RETRIEVED) return `Unexpected status: ${outcome.status}`;
  if (outcome.results.length !== 1) return `Expected 1 result, got ${outcome.results.length}`;
  if (outcome.results[0].evidenceId !== 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر') {
    return `Wrong section: ${outcome.results[0].evidenceId}`;
  }
  return true;
}

async function testTheRightSectionWinsAmongMany() {
  // Realistic heading paths. Giving every section the same heading would let them all
  // inherit the same heading match and would test nothing but the tie-break.
  const index = indexOf([
    { content: 'السعر الحالي: 350 جنيه.', evidenceId: 'A-PRICE', headingPath: ['كيمياء', 'السعر'] },
    { content: 'شحن كتاب واحد: 30 جنيه.', evidenceId: 'B-SHIPPING', headingPath: ['الشحن'] },
    { content: 'الكيمياء تغطي fizzles الأنهار والتفاعلات.', evidenceId: 'C-TOPICS', headingPath: ['الكيمياء', 'المنهج'] }
  ]);
  const outcome = await retrieveKnowledge({ commentText: 'سعر كتاب الكيمياء كام؟', index });

  if (outcome.results[0].evidenceId !== 'A-PRICE') {
    return `The price section did not win: ${outcome.results[0].evidenceId}`;
  }
  return true;
}

// ── §37: different wording, synonyms, Arabic variation ─────────────────────────

async function testAParaphraseStillFindsTheSection() {
  // The core §38 Test 2 comment, built almost entirely from words the knowledge base does
  // not contain. A hard local filter would drop it and skip silently.
  const comment = 'جبت كتاب الكيمياء من مكتبة الهدى بـ ٣٥٠ج هو عندكو بكام';
  const outcome = await retrieveKnowledge({
    commentText: comment,
    index: PRICE,
    complete: rerankingFirstId()
  });

  if (outcome.status !== RETRIEVAL_STATUS.RETRIEVED) return `The paraphrase found nothing: ${outcome.reason}`;
  if (outcome.results[0].evidenceId !== 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر') {
    return `Wrong section for the paraphrase: ${outcome.results[0].evidenceId}`;
  }
  if (outcome.state !== RETRIEVAL_STATE.RERANKED) return `Expected a reranked result, got ${outcome.state}`;
  return true;
}

async function testTheLocalScoreIsNotAHardFilterWhenAModelIsAvailable() {
  // A comment sharing no terms at all still reaches the model. Dropping it locally would
  // make retrieval unable to do the one job it exists for.
  const outcome = await retrieveKnowledge({
    commentText: 'كام سعره؟',
    index: PRICE,
    complete: rerankingFirstId()
  });
  if (outcome.offeredCount === 0) return 'The shortlist was empty, so the model was never asked';
  if (outcome.results.length === 0) return 'The model could not rescue a zero-overlap comment';
  return true;
}

async function testArabicVariationsMatch() {
  // Diacritics, Alef variants, Arabic-Indic vs Western digits, and tatweel all fold
  // together, so these are one term as far as scoring is concerned.
  const index = indexOf([{ content: 'السعر الحالي: 350 جنيه.', evidenceId: 'A-PRICE' }]);

  const variants = [
    'السعر الحالى 350 جنيه',  // ى vs ي
    'السِّعر الحالي: ٣٥٠ جنيه', // diacritic + Arabic-Indic digits
    'السعــــر الحالي 350 جنيه'  // tatweel
  ];
  for (const comment of variants) {
    const outcome = await retrieveKnowledge({ commentText: comment, index });
    if (outcome.results.length === 0) return `"${comment}" found nothing`;
  }
  return true;
}

async function testTheHeadingIsSearchedAsWellAsTheBody() {
  // The product name usually lives in the heading while the price lives in the body, so a
  // comment naming the product must reach a section that never repeats it.
  const index = indexOf([{ content: '350 جنيه.', evidenceId: 'A-PRICE', headingPath: ['كيمياء', 'السعر'] }]);
  const outcome = await retrieveKnowledge({ commentText: 'بكام كتاب الكيمياء؟', index });

  if (outcome.results.length === 0) return 'A comment naming only the product found nothing';
  if (outcome.results[0].headingCoverage <= 0) return 'The heading match was not scored';
  return true;
}

async function testStopwordsDoNotCreateMatches() {
  // Without them, "الشحن في اليوم" shares في and من with half the base and a section about
  // something else entirely scores on them.
  const index = indexOf([
    { content: 'سعر كتاب الكيمياء 350 جنيه.', evidenceId: 'A-PRICE' },
    { content: 'مدة التوصيل ثلاثة أيام عمل.', evidenceId: 'B-DURATION' }
  ]);
  const outcome = await retrieveKnowledge({ commentText: 'من فين أجيب الكتاب؟', index });

  // Nothing here is genuinely relevant, and the shared function words must not make the
  // two sections look interchangeable.
  const top = outcome.results[0];
  if (top && top.coverage > 0.5) return `Function words inflated coverage to ${top.coverage}`;
  return true;
}

// ── §37: multiple relevant sections, and no relevant knowledge ────────────────

async function testSeveralRelevantSectionsAreReturnedInOrder() {
  const index = indexOf([
    { content: 'السعر الحالي: 350 جنيه.', evidenceId: 'A-PRICE', headingPath: ['السعر'] },
    { content: 'السعر القديم كان 320 جنيه.', evidenceId: 'B-OLD-PRICE', headingPath: ['أسعار سابقة'] },
    { content: 'شحن كتاب واحد: 30 جنيه.', evidenceId: 'C-SHIPPING', headingPath: ['الشحن'] }
  ]);
  const outcome = await retrieveKnowledge({
    commentText: 'أسعار كتاب الكيمياء كام؟',
    index,
    complete: completing(JSON.stringify({ ranked: [{ id: 'A-PRICE', score: 0.9 }, { id: 'B-OLD-PRICE', score: 0.6 }] }))
  });

  if (outcome.results.length !== 2) return `Expected 2 results, got ${outcome.results.length}`;
  if (outcome.results[0].evidenceId !== 'A-PRICE') return 'The current price was not ranked first';
  if (outcome.results[0].modelScore !== 0.9) return `Model score was lost: ${outcome.results[0].modelScore}`;
  return true;
}

async function testResultsAreCapped() {
  const sections = [];
  for (let i = 0; i < 20; i++) {
    sections.push({ content: `السعر رقم ${i}: 350 جنيه.`, evidenceId: `A-${i}`, headingPath: ['السعر'] });
  }
  const outcome = await retrieveKnowledge({
    commentText: 'السعر كام؟',
    index: indexOf(sections),
    options: { maxResults: 3, maxCandidates: 10 }
  });

  if (outcome.results.length !== 3) return `Expected 3 results, got ${outcome.results.length}`;
  if (outcome.offeredCount !== 10) return `Expected 10 offered to the model, got ${outcome.offeredCount}`;
  return true;
}

async function testTheShortlistIsCapped() {
  const sections = [];
  for (let i = 0; i < 60; i++) {
    sections.push({ content: `السعر ${i}: 350 جنيه.`, evidenceId: `A-${i}`, headingPath: ['السعر'] });
  }
  const outcome = await retrieveKnowledge({
    commentText: 'السعر كام؟',
    index: indexOf(sections),
    complete: rerankingFirstId()
  });

  // §36: the whole repository must never be sent with every comment.
  if (outcome.offeredCount > RETRIEVAL_DEFAULTS.maxCandidates) {
    return `Offered ${outcome.offeredCount} sections, over the cap`;
  }
  if (outcome.consideredCount !== 60) return 'Not every section was considered locally';
  return true;
}

async function testTheModelCanReportNothingRelevant() {
  const outcome = await retrieveKnowledge({
    commentText: 'امتى هتبعت الحلقة الجاية؟',
    index: PRICE,
    complete: completing('{"ranked":[]}')
  });

  if (outcome.status !== RETRIEVAL_STATUS.NO_RESULTS) return `Unexpected status: ${outcome.status}`;
  if (outcome.code !== 'NO_RELEVANT_KNOWLEDGE') return `Unexpected code: ${outcome.code}`;
  if (outcome.state !== RETRIEVAL_STATE.RERANKED) return 'A deliberate no-result should say it was reranked';
  return true;
}

// ── §13: the shipping-duration case ───────────────────────────────────────────

async function testShippingCostIsNotShippingDuration() {
  // §13's own example. The shortlist will contain the shipping PRICE section, and the model
  // is told explicitly that such a section does not answer a question about days. This test
  // pins that the instruction and the empty-list response are wired up together.
  const outcome = await retrieveKnowledge({
    commentText: 'الشحن بياخد كام يوم؟',
    index: SHIPPING_COST,
    complete: completing('{"ranked":[]}')
  });

  if (outcome.status !== RETRIEVAL_STATUS.NO_RESULTS) {
    return 'The shipping price section was treated as answering a question about days';
  }
  return true;
}

// ── Fail-safe: the model cannot invent or break anything ──────────────────────

async function testAHallucinatedIdIsDiscarded() {
  // Only ids that were actually offered may come back. An invented id that reached the
  // evidence set would be cited by a reply with nothing behind it.
  const outcome = await retrieveKnowledge({
    commentText: 'سعر كتاب الكيمياء كام؟',
    index: PRICE,
    complete: completing(JSON.stringify({
      ranked: [
        { id: 'KNOWLEDGE-DOES-NOT-EXIST', score: 1 },
        { id: 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر', score: 0.8 }
      ]
    }))
  });

  if (outcome.results.length !== 1) return `Expected 1 result, got ${outcome.results.length}`;
  if (outcome.results[0].evidenceId !== 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر') {
    return 'The wrong section survived';
  }
  return true;
}

async function testAFailingModelFallsBackToLocalOrder() {
  // Never "no results" because LM Studio is down: that would turn a transient outage into
  // every comment in the base being skipped, which is a completely different bug.
  const outcome = await retrieveKnowledge({
    commentText: 'سعر كتاب الكيمياء كام؟',
    index: PRICE,
    complete: async () => { throw new Error('LM Studio unreachable'); }
  });

  if (outcome.status !== RETRIEVAL_STATUS.RETRIEVED) return `A model failure became ${outcome.status}`;
  if (outcome.state !== RETRIEVAL_STATE.LOCAL_ONLY) return `Expected LOCAL_ONLY, got ${outcome.state}`;
  if (outcome.results[0].modelScore !== null) return 'modelScore should be null when no model ranked it';
  return true;
}

async function testAnUnreadableAnswerFallsBackRatherThanReturningNothing() {
  for (const text of ['', 'not json at all', '{"ranked":"nope"}', '{}', '[1,2,3]', null]) {
    const outcome = await retrieveKnowledge({
      commentText: 'سعر كتاب الكيمياء كام؟',
      index: PRICE,
      complete: completing(text)
    });
    if (outcome.status !== RETRIEVAL_STATUS.RETRIEVED) {
      return `An unreadable answer (${JSON.stringify(text)}) became ${outcome.status}`;
    }
    if (outcome.state !== RETRIEVAL_STATE.LOCAL_ONLY) return 'An unreadable answer should fall back to local order';
  }
  return true;
}

async function testDuplicateIdsInARankingCollapse() {
  const outcome = await retrieveKnowledge({
    commentText: 'سعر كتاب الكيمياء كام؟',
    index: PRICE,
    complete: completing(JSON.stringify({
      ranked: [
        { id: 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر', score: 0.9 },
        { id: 'KNOWLEDGE-BOOKS-CHEMISTRY-السعر', score: 0.1 }
      ]
    }))
  });
  if (outcome.results.length !== 1) return `Duplicate ids produced ${outcome.results.length} results`;
  if (outcome.results[0].modelScore !== 0.9) return 'The first placement should win';
  return true;
}

async function testWithoutAModelTheLocalOrderStands() {
  const outcome = await retrieveKnowledge({ commentText: 'سعر كتاب الكيمياء كام؟', index: PRICE });
  if (outcome.status !== RETRIEVAL_STATUS.RETRIEVED) return 'Retrieval needs a model to work at all';
  if (outcome.state !== RETRIEVAL_STATE.LOCAL_ONLY) return `Unexpected state: ${outcome.state}`;
  return true;
}

// ── Relevance metadata ────────────────────────────────────────────────────────

async function testResultsCarryExplainableRelevanceMetadata() {
  const outcome = await retrieveKnowledge({ commentText: 'سعر كتاب الكيمياء كام؟', index: PRICE });
  const top = outcome.results[0];

  for (const field of ['localRank', 'localScore', 'coverage', 'headingCoverage', 'matchedTerms', 'modelScore']) {
    if (!(field in top)) return `The result is missing ${field}`;
  }
  if (top.matchedTerms.length === 0) return 'No matched terms were recorded, so the score cannot be explained';
  if (!top.matchedTerms.includes('الكيمياء') && !top.matchedTerms.includes('سعر')) {
    return `Unexpected matched terms: ${JSON.stringify(top.matchedTerms)}`;
  }
  return true;
}

async function testResultsCarryTheirSourceForExplainability() {
  const outcome = await retrieveKnowledge({ commentText: 'سعر كتاب الكيمياء كام؟', index: PRICE });
  const top = outcome.results[0];
  if (top.filename !== 'books/chemistry.md') return `Lost the filename: ${top.filename}`;
  if (top.documentId !== 'kdoc-1') return 'Lost the document id';
  if (!Array.isArray(top.headingPath)) return 'Lost the heading path';
  if (!top.content.includes('350')) return 'The cited content was not carried through';
  return true;
}

// ── Determinism ───────────────────────────────────────────────────────────────

async function testRankingIsDeterministic() {
  // The same comment over the same base must always produce the same order, or a
  // "sometimes it answers, sometimes it doesn't" report has no reproducible cause.
  const index = indexOf([
    { content: 'السعر 350 جنيه.', evidenceId: 'A' },
    { content: 'السعر 350 جنيه.', evidenceId: 'B' },
    { content: 'السعر 350 جنيه.', evidenceId: 'C' }
  ]);
  const first = rankSections(index.sections, 'السعر كام؟').map((e) => e.section.evidenceId);
  const second = rankSections(index.sections, 'السعر كام؟').map((e) => e.section.evidenceId);
  if (JSON.stringify(first) !== JSON.stringify(second)) return 'The ranking is not deterministic';
  return true;
}

async function testScoringIsPureAndBounded() {
  const section = PRICE.sections[0];
  const terms = new Set(['سعر', 'كيمياء']);
  const a = scoreSection(section, terms);
  const b = scoreSection(section, terms);
  if (a.score !== b.score) return 'Scoring is not pure';
  if (a.score < 0 || a.score > 1) return `Score out of range: ${a.score}`;

  // Junk input scores zero rather than throwing.
  if (scoreSection(null, terms).score !== 0) return 'A missing section did not score 0';
  if (scoreSection(section, new Set()).score !== 0) return 'An empty query did not score 0';
  return true;
}

async function testRerankOptionsAreForADecisionNotProse() {
  if (RERANK_OPTIONS.temperature !== 0) return 'A ranking decision must use temperature 0';
  return true;
}

// ── Budget ────────────────────────────────────────────────────────────────────

async function testAnOversizedSectionIsNotTruncated() {
  // Truncating a section mid-sentence would make a reply cite a claim the knowledge does
  // not quite make. The budget drops the OVERFLOW instead.
  const big = 'السعر 350 جنيه. '.repeat(2_000); // ~36k chars, over the default budget
  const ranked = rankSections(indexOf([{ content: big, evidenceId: 'BIG' }]).sections, 'السعر كام؟');
  const shortlist = toCandidateShortlist(ranked, { maxCandidates: 5, maxCandidateChars: 1_000 });

  if (shortlist.length === 0) return 'The first candidate was dropped by the budget';
  if (shortlist[0].section.content.length !== big.length) return 'A section was truncated rather than dropped';
  return true;
}

async function testEmptySectionsAreNeverOffered() {
  // Phase 20.4 keeps an EMPTY section in the index on purpose — dropping it would change the
  // document's shape — and marks it so `isSectionUsable()` can keep it out of RETRIEVAL. That
  // filter existed and nothing called it, so a bodyless heading could be ranked, offered to the
  // reranker and then APPROVED as evidence.
  //
  // The failure it causes is quiet and specific: the model is asked whether an empty section
  // answers the question, and when the real content sits in a sibling section the grounded reply
  // can lose its own source.
  const sections = [
    { evidenceId: 'PARENT', documentId: 'd', filename: 'books.md', headingPath: ['الكيمياء'], content: '', empty: true },
    { evidenceId: 'PRICE', documentId: 'd', filename: 'books.md', headingPath: ['الكيمياء', 'السعر'], content: 'السعر 350 جنيه.', empty: false }
  ];
  const outcome = await retrieveKnowledge({
    commentText: 'بكام؟',
    index: { retrievable: true, state: 'fresh', sections },
    options: { useModel: false }
  });

  if (outcome.results.some((r) => r.evidenceId === 'PARENT')) {
    return 'an empty section reached the results';
  }
  if (!outcome.results.some((r) => r.evidenceId === 'PRICE')) {
    return `the usable section was lost: ${JSON.stringify(outcome.results.map((r) => r.evidenceId))}`;
  }
  return true;
}

async function testADocumentWithOnlyEmptySectionsSaysSo() {
  // Every section empty is not the same as no documents at all: the reason has to distinguish
  // them, or a user whose knowledge file is all headings sees "the knowledge base has no
  // sections" and goes looking for a file that is right there.
  const outcome = await retrieveKnowledge({
    commentText: 'بكام؟',
    index: {
      retrievable: true,
      state: 'fresh',
      sections: [{ evidenceId: 'A', documentId: 'd', filename: 'a.md', headingPath: ['س'], content: '', empty: true }]
    },
    options: { useModel: false }
  });

  if (outcome.status !== RETRIEVAL_STATUS.UNAVAILABLE) return `status was ${outcome.status}`;
  if (!/none of them has any content/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  return true;
}

async function testTheShortlistRespectsTheCharacterBudget() {
  const sections = [];
  for (let i = 0; i < 30; i++) {
    sections.push({ content: `السعر ${i}: ${'جنيه '.repeat(500)}`, evidenceId: `A-${i}`, headingPath: ['السعر'] });
  }
  const ranked = rankSections(indexOf(sections).sections, 'السعر كام؟');
  const shortlist = toCandidateShortlist(ranked, { maxCandidates: 30, maxCandidateChars: 4_000 });

  const chars = shortlist.reduce((sum, e) => sum + e.section.content.length, 0);
  if (chars > 4_000) return `The shortlist carried ${chars} chars, over the 4000 budget`;
  if (shortlist.length === 0) return 'Everything was dropped';
  return true;
}

// ── Parser unit ───────────────────────────────────────────────────────────────

async function testTheRankingParserIgnoresUnknownAndJunkEntries() {
  const shortlist = [{ section: { evidenceId: 'A' } }, { section: { evidenceId: 'B' } }];
  const parsed = parseRerankResult(
    JSON.stringify({
      ranked: [
        { id: 'B', score: 0.8 },
        { id: 'UNKNOWN', score: 1 },
        { id: 42, score: 0.5 },
        null,
        'nope',
        { score: 0.7 },
        { id: 'A', score: 2 } // out of range, clamped rather than dropped
      ]
    }),
    shortlist
  );

  if (JSON.stringify(parsed.ids) !== JSON.stringify(['B', 'A'])) return `Unexpected order: ${JSON.stringify(parsed.ids)}`;
  if (parsed.rankById.get('A').score !== 1) return 'An out-of-range score was not clamped';
  return true;
}

async function testTheRankingParserReturnsNullForUnreadableInput() {
  const shortlist = [{ section: { evidenceId: 'A' } }];
  for (const raw of [null, '', 'nope', '{', '{"ranked":null}', '{"ranked":{}}', '[{"id":"A"}]']) {
    if (parseRerankResult(raw, shortlist) !== null) return `${JSON.stringify(raw)} was accepted`;
  }
  return true;
}

async function testAFencedJsonAnswerIsStillRead() {
  // Models wrap JSON in prose or fences often enough that a bare parse would fail on
  // correct answers.
  const shortlist = [{ section: { evidenceId: 'A' } }];
  const parsed = parseRerankResult('```json\n{"ranked":[{"id":"A","score":1}]}\n```', shortlist);
  if (!parsed || parsed.ids[0] !== 'A') return 'A fenced answer was not read';
  return true;
}

/**
 * Phase 20.24 — the rerank ceiling must clear a reasoning model's thinking.
 *
 * The most expensive measurement of the five: 483 reasoning tokens over a twelve-section
 * shortlist, against a 600-token ceiling. It passed, by 117 tokens, and that margin was not
 * safety — a base one section larger or a comment one clause longer would have exhausted it.
 *
 * The failure this call has is not catastrophic (an unreadable ranking falls back to the local
 * order, which is a real result), which is exactly why it would have gone unnoticed: retrieval
 * quietly got worse and nothing anywhere said so.
 */
async function testTheRerankCeilingClearsReasoning() {
  if (RERANK_OPTIONS.maxTokens !== 600 + REASONING_HEADROOM_TOKENS) {
    return `maxTokens ${RERANK_OPTIONS.maxTokens} is not the 600-token ranking payload plus the ${REASONING_HEADROOM_TOKENS}-token headroom`;
  }
  if (RERANK_OPTIONS.maxTokens < 483 + 600) {
    return `maxTokens ${RERANK_OPTIONS.maxTokens} cannot hold the ~483 reasoning tokens measured on a twelve-section shortlist`;
  }
  if (RERANK_OPTIONS.allowReasoningFallback !== false) {
    return 'a structured call must opt out of the reasoning_content fallback';
  }
  if (RERANK_OPTIONS.temperature !== 0) {
    return `a ranking decision must be deterministic, got temperature ${RERANK_OPTIONS.temperature}`;
  }
  return true;
}

async function runAllTests() {
  console.log('\n=== Knowledge Retrieval Tests (Phase 20.5) ===\n');

  await runTest('An unusable index is refused', testAnUnusableIndexIsRefused);
  await runTest('An empty base is no-results, not a failure', testAnEmptyBaseIsNoResultsNotAFailure);

  await runTest('An exact question finds its section', testAnExactQuestionFindsItsSection);
  await runTest('The right section wins among many', testTheRightSectionWinsAmongMany);

  await runTest('A paraphrase still finds the section', testAParaphraseStillFindsTheSection);
  await runTest('The local score is not a hard filter', testTheLocalScoreIsNotAHardFilterWhenAModelIsAvailable);
  await runTest('Arabic variations match', testArabicVariationsMatch);
  await runTest('The heading is searched as well as the body', testTheHeadingIsSearchedAsWellAsTheBody);
  await runTest('Stopwords do not create matches', testStopwordsDoNotCreateMatches);

  await runTest('Several relevant sections are returned in order', testSeveralRelevantSectionsAreReturnedInOrder);
  await runTest('Results are capped', testResultsAreCapped);
  await runTest('The shortlist is capped', testTheShortlistIsCapped);
  await runTest('The model can report nothing relevant', testTheModelCanReportNothingRelevant);
  await runTest('Shipping cost is not shipping duration', testShippingCostIsNotShippingDuration);

  await runTest('A hallucinated id is discarded', testAHallucinatedIdIsDiscarded);
  await runTest('A failing model falls back to local order', testAFailingModelFallsBackToLocalOrder);
  await runTest('An unreadable answer falls back rather than returning nothing', testAnUnreadableAnswerFallsBackRatherThanReturningNothing);
  await runTest('Duplicate ids in a ranking collapse', testDuplicateIdsInARankingCollapse);
  await runTest('Without a model the local order stands', testWithoutAModelTheLocalOrderStands);

  await runTest('Results carry explainable relevance metadata', testResultsCarryExplainableRelevanceMetadata);
  await runTest('Results carry their source for explainability', testResultsCarryTheirSourceForExplainability);

  await runTest('Ranking is deterministic', testRankingIsDeterministic);
  await runTest('Scoring is pure and bounded', testScoringIsPureAndBounded);
  await runTest('Rerank options are for a decision, not prose', testRerankOptionsAreForADecisionNotProse);

  await runTest('An oversized section is not truncated', testAnOversizedSectionIsNotTruncated);
  await runTest('The shortlist respects the character budget', testTheShortlistRespectsTheCharacterBudget);

  await runTest('The ranking parser ignores unknown and junk entries', testTheRankingParserIgnoresUnknownAndJunkEntries);
  await runTest('The ranking parser returns null for unreadable input', testTheRankingParserReturnsNullForUnreadableInput);
  await runTest('A fenced JSON answer is still read', testAFencedJsonAnswerIsStillRead);
  await runTest('The rerank ceiling clears reasoning', testTheRerankCeilingClearsReasoning);
  await runTest('An empty section is never offered', testEmptySectionsAreNeverOffered);
  await runTest('A document with only empty sections says so', testADocumentWithOnlyEmptySectionsSaysSo);

  console.log('\n--- Phase 20.19: authority on the result ---');
  await runTest('Results carry the document authority', testResultsCarryTheDocumentAuthority);
  await runTest('Absent authority defaults to numbers', testAuthorityDefaultsAreNumbersNotUndefined);


/**
 * ── Phase 20.21: the per-section term cache ─────────────────────────────────────
 *
 * `scoreSection()` used to re-derive a section's term sets from its `searchText` on EVERY
 * call — that is, the full Arabic normalization of the whole base, once per comment. The
 * memo is keyed on the section OBJECT, so the property that matters is that a rebuilt
 * section is scored from scratch. A cache that survived a rebuild would rank a comment
 * against knowledge the user has already replaced, which is the stale-knowledge hole 20.4
 * exists to close, reached by a completely different route.
 */
async function testRepeatedScoringOfOneSectionIsIdentical() {
  const section = {
    evidenceId: 'E1',
    searchText: 'كيمياء السعر 350 جنيه الشحن ثلاثة أيام',
    headingPath: ['كيمياء', 'السعر'],
    content: 'السعر 350 جنيه'
  };
  const queries = ['بكام الكيمياء', 'الشحن كام يوم', 'سعر كيمياء', 'لا علاقة'];

  const first = queries.map((q) => scoreSection(section, q));
  const second = queries.map((q) => scoreSection(section, q));

  for (let i = 0; i < queries.length; i++) {
    // The whole result, including the matched-terms metadata: a memo that dropped or
    // reordered a term would keep the score and lose the explanation.
    if (JSON.stringify(first[i]) !== JSON.stringify(second[i])) {
      return `scoring "${queries[i]}" changed between calls: ${JSON.stringify(first[i])} vs ${JSON.stringify(second[i])}`;
    }
  }
  return true;
}

async function testARebuiltSectionIsScoredFromItsOwnText() {
  // Two distinct objects that happen to share an id, which is what a rebuild produces. If
  // the cache were keyed on the id — or were shared across objects — the second section
  // would be ranked using the FIRST one's text, and the user would get answers from
  // knowledge they deleted.
  const before = {
    evidenceId: 'KNOWLEDGE-CHEM',
    searchText: 'كيمياء السعر 350 جنيه',
    headingPath: ['كيمياء', 'السعر'],
    content: 'السعر 350 جنيه'
  };
  const after = {
    evidenceId: 'KNOWLEDGE-CHEM',
    searchText: 'احياء السعر 900 جنيه',
    headingPath: ['احياء', 'السعر'],
    content: 'السعر 900 جنيه'
  };

  const chemistry = scoreSection(before, new Set(['كيمياء', 'سعر']));
  const biology = scoreSection(after, new Set(['احياء', 'سعر']));

  if (!(chemistry.score > 0)) return 'the original section should match its own subject';
  if (!(biology.score > 0)) return 'the rebuilt section should match its own subject';
  // The decisive one: the rebuilt section must NOT match the old subject.
  const stale = scoreSection(after, new Set(['كيمياء']));
  if (stale.score > 0) {
    return `the rebuilt section still matched the OLD subject (score=${stale.score}) — a stale term cache`;
  }
  return true;
}

async function testTheTermCacheSurvivesADegenerateSection() {
  // Nothing to cache, and nothing to throw: an empty section is a legal index section and
  // §20.13/§18 rely on those being inert rather than fatal.
  for (const section of [undefined, null, {}, { searchText: '', headingPath: [] }]) {
    const scored = scoreSection(section, new Set(['سعر']));
    if (scored.score !== 0) return `a degenerate section scored ${scored.score}`;
  }
  return true;
}

async function testScoresAreUnchangedByRepeatedRanking() {
  // Rank the same corpus twice and require identical ordering and identical scores: the
  // observable contract retrieval has to keep.
  const index = indexOf([
    { evidenceId: 'A', content: 'السعر 350 جنيه.', headingPath: ['السعر'], filename: 'a.md' },
    { evidenceId: 'B', content: 'الشحن ثلاثة أيام.', headingPath: ['الشحن'], filename: 'b.md' },
    { evidenceId: 'C', content: 'الكيمياء مادة.', headingPath: ['الكيمياء'], filename: 'c.md' }
  ]);
  const query = toRetrievalTerms('بكام سعر الكيمياء؟');

  const one = await retrieveKnowledge({ commentText: 'بكام سعر الكيمياء؟', index, complete: async () => ({ text: JSON.stringify({ ranked: [] }) }) });
  const two = await retrieveKnowledge({ commentText: 'بكام سعر الكيمياء؟', index, complete: async () => ({ text: JSON.stringify({ ranked: [] }) }) });

  const shape = (r) => JSON.stringify(r.results.map((x) => [x.evidenceId, x.localScore, x.localRank]));
  if (shape(one) !== shape(two)) return `ranking changed between runs:\n  ${shape(one)}\n  ${shape(two)}`;
  return true;
}

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}


/**
 * ── Phase 20.19: the result must carry the document's AUTHORITY ──────────────────
 *
 * 20.7's gate and 20.12's audit both resolve §18 precedence from these results. Until
 * 20.19 they carried no `priority`, `version` or `updatedAt`, so every pair of documents
 * looked equally authoritative: a decided contradiction was reported as blocking and the
 * comment was SKIPPED. This asserts the fields survive the whole retrieval path, because
 * the defect lived at the boundary between 20.5 and 20.7 — not in either module alone.
 */
async function testResultsCarryTheDocumentAuthority() {
  const index = indexOf([
    { evidenceId: 'PRICE', content: 'السعر 350 جنيه.', filename: 'books/new.md', headingPath: ['السعر'] }
  ]);
  // The index's own sections are the source of truth for authority; make them distinctive
  // so a hardcoded default cannot pass this.
  index.sections[0].priority = 9;
  index.sections[0].version = 5;
  index.sections[0].updatedAt = 12345;
  index.sections[0].enabled = true;

  const retrieval = await retrieveKnowledge({
    commentText: 'بكام كتاب الكيمياء؟',
    index,
    complete: async (messages) => {
      const ids = (messages.map((m) => m.content).join('\n').match(/id: (\S+)/g) || []).map((l) => l.slice(4));
      return { text: JSON.stringify({ ranked: ids.map((id) => ({ id, score: 0.9 })) }) };
    }
  });

  const [first] = retrieval.results;
  if (!first) return 'nothing was retrieved';
  if (first.priority !== 9) return `priority=${first.priority}, expected 9`;
  if (first.version !== 5) return `version=${first.version}, expected 5`;
  if (first.updatedAt !== 12345) return `updatedAt=${first.updatedAt}, expected 12345`;
  if (first.enabled !== true) return `enabled=${first.enabled}`;
  return true;
}

async function testAuthorityDefaultsAreNumbersNotUndefined() {
  // A section built without authority fields must still yield numeric ones: the gate's
  // comparator reads them with `typeof … === 'number'`, and an `undefined` would make a
  // document look malformed rather than simply low-authority.
  const index = indexOf([
    { evidenceId: 'PRICE', content: 'السعر 350 جنيه.' }
  ]);
  delete index.sections[0].priority;
  delete index.sections[0].version;
  delete index.sections[0].updatedAt;

  const retrieval = await retrieveKnowledge({
    commentText: 'بكام كتاب الكيمياء؟',
    index,
    complete: async (messages) => {
      const ids = (messages.map((m) => m.content).join('\n').match(/id: (\S+)/g) || []).map((l) => l.slice(4));
      return { text: JSON.stringify({ ranked: ids.map((id) => ({ id, score: 0.9 })) }) };
    }
  });

  const [first] = retrieval.results;
  if (!first) return 'nothing was retrieved';
  for (const field of ['priority', 'version', 'updatedAt']) {
    if (typeof first[field] !== 'number') return `${field}=${first[field]}, expected a number`;
  }
  return true;
}

export default runAllTests;