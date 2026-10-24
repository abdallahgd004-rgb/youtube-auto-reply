/**
 * Knowledge Retrieval — Phase 20.5
 *
 * Given a comment and a usable index, produce the handful of sections worth putting in
 * front of the model. Everything downstream — answerability (20.7), grounded generation
 * (20.8), grounding validation (20.10) — is only as safe as this step, because a section
 * that is retrieved becomes something a reply may be grounded in.
 *
 * TWO STAGES, AND THE DIVISION IS THE POINT
 * ------------------------------------------
 *
 *   1. LOCAL SCORING over the index. Deterministic, free, Arabic-normalized term coverage.
 *      Its job is RECALL — narrowing a knowledge base to a shortlist so the model is not
 *      asked to read all of it. §36 is explicit that the whole repository must not be sent
 *      with every comment, and this is what prevents that.
 *   2. AI RERANKING of the shortlist. Its job is PRECISION. "بكام" and "كام سعره" share no
 *      term at all, which is exactly the case AGENTS.md records about semantic-matcher.js:
 *      a substring test cannot read Arabic intent, and dropping the comment locally would
 *      silently lose the one §38 Test 2 says must work.
 *
 * WHY STAGE 2 IS OPTIONAL AND DEGRADES INSTEAD OF FAILING
 * -------------------------------------------------------
 * `complete` is INJECTED (the service worker passes the existing `chatCompletion`), so this
 * module adds no second HTTP client and is fully testable without a network. When it is
 * absent — or when the call fails, times out or returns something unreadable — retrieval
 * falls back to the LOCAL ranking and says so. It never returns "no results" because the
 * model was down: that would turn a transient LM Studio problem into every comment being
 * skipped, which is a very different bug from the one being fixed.
 *
 * It is the same fail-safe contract semantic-matcher.js uses, deliberately. There is no
 * path through this module that invents a section: only ids the model was actually offered
 * can come back, so a hallucinated id cannot enter the evidence set.
 *
 * WHY THE LOCAL SCORE IS NOT USED AS A HARD FILTER
 * -------------------------------------------------
 * Zero term overlap means nothing at all. It is exactly what a well-worded paraphrase
 * looks like, and §38's Test 2 comment ("جبت كتاب الكيمياء من مكتبة الهدى بـ ٣٥٠ج هو عندكو
 * بكام") is largely built from words the knowledge base does not contain. So a low local
 * score narrows nothing away while a reranker is available; it only becomes NO_RESULTS when
 * there is no model to ask.
 *
 * NEVER RETURNS A PARTIAL OR UNAUTHORIZED INDEX
 * ----------------------------------------------
 * Retrieval refuses an index whose `retrievable` is false. The gate declared in 20.1 has
 * exactly one entry point and this is not a second one — a caller that skipped
 * `getKnowledgeIndex()` cannot get around it by coming here.
 *
 * Platform-agnostic: no `chrome.*`, no DOM, no network.
 */

import { normalizeArabic } from './matchers/arabic-normalizer.js';
import { KNOWLEDGE_ERROR } from './knowledge-schema.js';
import { usableSections } from './knowledge-index.js';
import { filterSectionsByScope } from './template-scope.js';
import { structuredCallOptions } from './reasoning-budget.js';

/**
 * What a retrieval did.
 *
 * `RERANKED` and `LOCAL_ONLY` are the same answer reached two ways — both are results, and
 * both go forward. The distinction exists for diagnostics, because "retrieved but the model
 * was unavailable" and "retrieved by the model" are different questions when a reply turns
 * out to be unsupported.
 */
export const RETRIEVAL_STATUS = Object.freeze({
  /** Sections came back. `state` says how they were chosen. */
  RETRIEVED: 'retrieved',
  /** Nothing in the base supports this comment. `NO_RELEVANT_KNOWLEDGE`. */
  NO_RESULTS: 'no_results',
  /** The index was missing or not authorized for retrieval. */
  UNAVAILABLE: 'unavailable',
});

/** How a result was chosen. */
export const RETRIEVAL_STATE = Object.freeze({
  /** The model ranked the shortlist. */
  RERANKED: 'reranked',
  /** The local score decided, because no model was available or it failed. */
  LOCAL_ONLY: 'local_only',
});

/**
 * Defaults. Every one is a knob because §11 says the exact numbers should be set from
 * testing, and because they are the only thing standing between a 50-document base and a
 * prompt the model cannot use.
 */
export const RETRIEVAL_DEFAULTS = Object.freeze({
  /** Sections handed to the reranker. */
  maxCandidates: 12,
  /** Sections returned. §11's "top 3" is the shortlist; this is the working set. */
  maxResults: 5,
  /**
   * Local score at or above which a section counts as a hit when there is no model to ask.
   *
   * Deliberately low. This is a floor for "no model available", not a relevance judgement —
   * term coverage is a poor Arabic relevance signal and a high threshold would turn ordinary
   * paraphrases into silent skips.
   */
  minScore: 0.12,
  /**
   * Characters of section content the shortlist may carry.
   *
   * A backstop, not a target: `maxCandidates` bounds the count, and this bounds the size of
   * what those sections happen to contain. A base of fifty long documents can still exceed
   * it, and truncating the shortlist is better than a prompt the model cannot answer from.
   */
  maxCandidateChars: 6_000
});

/**
 * Size of the JSON ranking this call has to be able to emit: up to twelve section ids.
 *
 * Phase 20.24 — this is the PAYLOAD, not the request ceiling. It used to be the ceiling, on
 * the reasoning recorded in config.js ("a budget that runs out mid-thought returns an empty
 * `content`"), which was the right diagnosis applied to the wrong number: the room for
 * thinking has to be added to the payload, not carved out of it. Measured against the model in
 * use, this call spent 483 of its 600 tokens thinking — a 117-token margin over a
 * twelve-section shortlist, which is not a margin, it is luck.
 */
export const RERANK_PAYLOAD_TOKENS = 600;

/**
 * Decoding options for the rerank call.
 *
 * `temperature: 0` because this is a ranking decision, not prose: the same comment over the
 * same base must always produce the same order.
 *
 * Phase 20.24 — composed through `structuredCallOptions()`, which adds the reasoning headroom
 * and opts this call out of the thinking-text fallback.
 */
export const RERANK_OPTIONS = Object.freeze(
  structuredCallOptions({ maxTokens: RERANK_PAYLOAD_TOKENS, operation: 'KNOWLEDGE_RERANK' })
);

/**
 * Function words removed from both sides before matching.
 *
 * Without this, coverage is dominated by noise: "الشحن بياخد كام يوم" shares الش��ن and
 * بياخد with a shipping section, but it also shares في and من with half the base, and a
 * section about something else entirely scores on them. Only true function words are here —
 * no content word is removed, because dropping "سعر" would break the single most common
 * question in this phase.
 */
const STOPWORDS = new Set([
  // Arabic function words.
  'في', 'من', 'الى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'ما', 'ماذا',
  'هل', 'و', 'او', 'ثم', 'قد', 'كان', 'يكون', 'هو', 'هي', 'انا', 'انت', 'هو', 'كل', 'بعض',
  'عند', 'عندكم', 'لو', 'اذا', 'كم', 'اي', 'ايها', 'لكن', 'بس', 'ده', 'دي', 'ده', 'دي',
  'ازاي', 'امتى', 'فين', 'ليه', 'مش', 'مافيش', 'يعني', 'بجد', 'اخرا', 'دلوقتي', 'احنا',
  // English function words, for a mixed-language knowledge base.
  'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'do', 'does',
  'how', 'much', 'what', 'is', 'it', 'you', 'your', 'we', 'i', 'my', 'can', 'please', 'me'
]);

/**
 * Fold the Arabic definite article off the front of a term.
 *
 * This is not a nicety, it is the single biggest reason naive Arabic matching fails. A
 * commenter writes "بكام كتاب الكيمياء" and the knowledge says "السعر الحالي: 350 جنيه" —
 * the two share no term at all unless "سعر" and "السعر" are folded together, and "سعر" is
 * one of the most common words in every question this phase exists to answer.
 *
 * `ال` is only stripped when at least three characters remain. Words that merely BEGIN with
 * those two letters without being definite forms — الله, الآن, Mendonça-style names — are
 * left alone, because over-stripping creates the same false mismatch the fold is here to
 * remove.
 *
 * @param {string} token
 * @returns {string}
 */
function foldDefiniteArticle(token) {
  if (token.length >= 5 && token.startsWith('ال')) return token.slice(2);
  return token;
}

/**
 * Split normalized text into distinct content terms, folded canonically.
 *
 * Arabic is normalized first, which is what makes this more than a substring check:
 * diacritics, Alef variants, Arabic-Indic digits and tatweel all fold together, so
 * "٣٥٠" and "350", and "إستفسار" and "استفسار", produce the same term.
 *
 * Terms are folded to ONE canonical spelling per word, not both. Keeping "كيمياء" and
 * "الكيمياء" as two terms made a query containing the article match twice and score
 * double, which let a section beat a better one for no real reason. Folding both SIDES is
 * what makes matching work in both directions without inflating anything.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function contentTerms(text) {
  return new Set(termList(text));
}

/**
 * Every content term in a piece of text, as a LIST.
 *
 * Named separately because callers need the terms in order: the matched-terms metadata has
 * to say which words actually connected, and a Set would lose the ordering that makes the
 * field readable in a diagnostic entry.
 *
 * @param {string} text
 * @returns {string[]}
 */
function termList(text) {
  const normalized = normalizeArabic(text);
  const terms = [];
  // A Set for the membership test, the array for the ORDER. Phase 20.21: this was
  // `terms.includes(token)`, which is quadratic in the number of distinct terms — and
  // `termList()` runs over every section of the base on every comment, so the cost was
  // multiplied by the whole knowledge base. Output is byte-identical: the array still
  // pushes first-seen order and the Set holds exactly the tokens already in it.
  const seen = new Set();
  for (const raw of normalized.split(/\s+/)) {
    if (!raw) continue;
    const token = foldDefiniteArticle(raw);
    if (!token || STOPWORDS.has(raw) || STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/**
 * Reduce text to the canonical terms retrieval matches on.
 *
 * Exported because Phase 20.6's intent stage needs the EXACT same derivation for the terms
 * it contributes. Stopword removal and definite-article folding have to agree on both
 * sides, or a term contributed by intent and a term read out of the comment stop matching
 * the same heading.
 *
 * A second copy of these rules in `intent-analyzer.js` would be the same hazard as the
 * hand-maintained copy in `content/arabic-normalizer-global.js`: it would drift silently,
 * nothing would fail, and Arabic matching would quietly stop working.
 *
 * @param {string} text
 * @returns {string[]} canonical terms, first-seen order, no duplicates
 */
export function toRetrievalTerms(text) {
  return termList(text);
}

/**
 * Score one section against a comment, deterministically.
 *
 * Two components, and the weighting is the whole design:
 *
 *   - COVERAGE (0.75): how much of the comment the section accounts for. This is what
 *     actually matters — a section that answers the question asked is worth more than one
 *     that happens to share a common noun.
 *   - HEADING COVERAGE (0.25): how much of the comment appears in the section's HEADING.
 *     The product name usually lives in the heading while the price lives in the body, so
 *     this is what lets "منتج كيمياء" reach a section whose text is only "350 جنيه".
 *
 * A section that matches nothing scores exactly 0 rather than being dropped, because the
 * tie-break then falls to ordering and the score stays available as relevance metadata.
 *
 * @param {Object} section - an indexed section (needs `searchText` and `headingPath`)
 * @param {Set<string>} queryTerms
 * @returns {{score: number, coverage: number, headingCoverage: number,
 *   matchedTerms: string[], headingMatches: string[]}}
 */
/**
 * Phase 20.21 — the derived term sets for one section, computed at most once per section.
 *
 * A `WeakMap` keyed on the section OBJECT, deliberately:
 *
 *  - It needs no new field on the index section, so nothing about the index shape, the
 *    fingerprint or a prompt changes.
 *  - It invalidates itself. A rebuild produces brand-new section objects, so a stale entry
 *    cannot outlive the text it was derived from — no version to compare, no explicit clear
 *    that someone can forget. Index sections are never mutated in place, so object identity
 *    is a sound cache key here.
 *  - It cannot leak. An unreferenced section's entry is collectable with it.
 *
 * The alternative — stamping a `searchTerms` array onto each section at index time — is the
 * same idea in a more visible place, and it would put derived data into the structure the
 * fingerprint is computed from. `searchText` is already precomputed there for exactly this
 * reason, so the shape change was available; not taking it is the smaller risk.
 */
const sectionTermCache = new WeakMap();

/** The section's body and heading terms, derived once and reused across queries. */
function sectionTermSets(section) {
  if (!section || typeof section !== 'object') {
    return { sectionTerms: new Set(), headingTerms: new Set() };
  }

  const cached = sectionTermCache.get(section);
  if (cached) return cached;

  const derived = {
    sectionTerms: new Set(termList(section.searchText || '')),
    headingTerms: new Set(termList((section.headingPath || []).join(' ')))
  };
  sectionTermCache.set(section, derived);
  return derived;
}

export function scoreSection(section, queryTerms) {
  const terms = queryTerms instanceof Set ? queryTerms : contentTerms(queryTerms);

  const { sectionTerms, headingTerms } = sectionTermSets(section);

  const matchedTerms = [];
  let headingMatches = 0;
  for (const term of terms) {
    if (sectionTerms.has(term)) matchedTerms.push(term);
    if (headingTerms.has(term)) headingMatches++;
  }

  if (terms.size === 0) {
    return { score: 0, coverage: 0, headingCoverage: 0, matchedTerms: [], headingMatches: [] };
  }

  const coverage = matchedTerms.length / terms.size;
  const headingCoverage = headingMatches / terms.size;
  return {
    score: coverage * 0.75 + headingCoverage * 0.25,
    coverage,
    headingCoverage,
    matchedTerms,
    headingMatches: headingTerms.size ? headingMatches / headingTerms.size : 0
  };
}

/**
 * Rank every usable section against a comment.
 *
 * Total and deterministic: ties are broken by heading coverage, then by the SHORTER section
 * (a long section matches more terms by accident, and a precise 60-character answer should
 * outrank a 5,000-character document that mentions everything), then by ordinal so the same
 * base always yields the same order.
 *
 * @param {Array<Object>} sections
 * @param {string} commentText
 * @param {string[]} [extraTerms] - additional canonical terms to score against, from the
 *        Phase 20.6 intent stage. Added to the comment's own terms, never replacing them.
 * @returns {Array<{section: Object, score: number, coverage: number,
 *   headingCoverage: number, matchedTerms: string[], rank: number}>}
 */
export function rankSections(sections, commentText, extraTerms = []) {
  const queryTerms = contentTerms(commentText);
  for (const term of Array.isArray(extraTerms) ? extraTerms : []) {
    if (typeof term === 'string' && term) queryTerms.add(term);
  }
  const usable = Array.isArray(sections) ? sections.filter(Boolean) : [];
  if (usable.length === 0 || queryTerms.size === 0) return [];

  const scored = usable.map((section) => {
    const s = scoreSection(section, queryTerms);
    return { section, ...s };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.headingCoverage !== a.headingCoverage) return b.headingCoverage - a.headingCoverage;
    const lengthA = (a.section.content || '').length;
    const lengthB = (b.section.content || '').length;
    if (lengthA !== lengthB) return lengthA - lengthB;
    const ordinalA = a.section.ordinal ?? 0;
    const ordinalB = b.section.ordinal ?? 0;
    if (ordinalA !== ordinalB) return ordinalA - ordinalB;
    return String(a.section.evidenceId || '').localeCompare(String(b.section.evidenceId || ''));
  });

  return scored.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Narrow a ranking to a bounded shortlist.
 *
 * The character budget is applied by DROPPING the lowest-ranked overflow rather than by
 * truncating any section's content: a half-quoted section is a grounding hazard, and §2's
 * rule is that skipping is preferred to a partial claim.
 *
 * @param {Array<Object>} ranked
 * @param {{maxCandidates?: number, maxCandidateChars?: number}} [options]
 * @returns {Array<Object>}
 */
export function toCandidateShortlist(ranked, options = {}) {
  const maxCandidates = options.maxCandidates ?? RETRIEVAL_DEFAULTS.maxCandidates;
  const maxChars = options.maxCandidateChars ?? RETRIEVAL_DEFAULTS.maxCandidateChars;

  const shortlist = [];
  let chars = 0;
  for (const entry of ranked) {
    if (shortlist.length >= maxCandidates) break;
    const size = (entry.section?.content || '').length;
    // A section is always admitted if it is the first one, so a base whose sections are
    // individually enormous still gets one candidate rather than an empty shortlist.
    if (chars > 0 && chars + size > maxChars) continue;
    chars += size;
    shortlist.push(entry);
  }
  return shortlist;
}

/** The instructions for the rerank call. */
function buildRerankMessages(commentText, shortlist) {
  const catalogue = shortlist
    .map((entry, index) => {
      const s = entry.section;
      const heading = (s.headingPath || []).join(' > ') || '(no heading)';
      return [
        `[${index}] id: ${s.evidenceId}`,
        `document: ${s.filename}`,
        `section: ${heading}`,
        'content:',
        s.content
      ].join('\n');
    })
    .join('\n\n---\n\n');

  return [
    {
      role: 'system',
      content:
        'You rank knowledge sections by how well they answer a YouTube comment. ' +
        'Understand Egyptian Arabic, Modern Standard Arabic, and paraphrases. ' +
        'Rank every section that is relevant or helpful to answer the question, most relevant first. ' +
        'In "id", you can use the section index number (e.g. "0", "1", ...) or the exact id string. ' +
        'Rank a section that answers the question even if it also contains other information. ' +
        'Some of the commenter\'s text is background, not a second question: if the comment ' +
        'quotes a price, a number or an experience from somewhere else and then asks what YOU ' +
        'charge, it is ONE question — rank the section stating your price. ' +
        'Return an empty list when nothing is relevant. ' +
        'Answer with JSON only, no explanation, no markdown: {"ranked":[{"id":"0","score":0.95},{"id":"1","score":0.8}]}'
    },
    {
      role: 'user',
      content: `Comment:\n${String(commentText == null ? '' : commentText)}\n\nSections:\n${catalogue}\n\nJSON only.`
    }
  ];
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that requiring a bare parse would fail
 * on correct answers.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Interpret a rerank response as an ordering of OFFERED ids.
 *
 * This is the safety boundary, and it mirrors parseSemanticMatchResult():
 *
 *   - only ids that were actually offered are accepted, so a hallucinated id cannot enter
 *     the evidence set and be cited later
 *   - duplicate ids collapse, keeping the model's best (first) placement
 *   - an unreadable answer is `null`, meaning "fall back to local order", NEVER "nothing is
 *     relevant"
 *
 * @param {string} raw
 * @param {Array<Object>} shortlist
 * @returns {{ids: string[], rankById: Map<string, {score: number}>}|null}
 */
export function parseRerankResult(raw, shortlist) {
  const offered = new Set(shortlist.map((entry) => entry.section.evidenceId));

  const json = extractJson(raw);
  if (!json) return null;

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.ranked)) return null;

  const ids = [];
  const rankById = new Map();
  for (const item of parsed.ranked) {
    if (!item || typeof item !== 'object') continue;
    let id = typeof item.id === 'string' ? item.id.trim() : (typeof item.id === 'number' ? String(item.id) : '');
    // If not an exact offered id, check if the model referenced a shortlist index (e.g. 0, "0", "[0]", "section 0")
    if (!offered.has(id)) {
      const indexMatch = id.match(/^(?:section\s*|#)?\[?(\d+)\]?$/i);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10);
        if (idx >= 0 && idx < shortlist.length && shortlist[idx]?.section?.evidenceId) {
          id = shortlist[idx].section.evidenceId;
        }
      }
    }
    // Unknown or already-seen ids are dropped, never appended.
    if (!id || !offered.has(id) || rankById.has(id)) continue;
    const score = typeof item.score === 'number' && Number.isFinite(item.score)
      ? Math.max(0, Math.min(1, item.score))
      : 0;
    rankById.set(id, { score });
    ids.push(id);
  }

  return { ids, rankById };
}

/**
 * Retrieve the sections worth putting in front of the model.
 *
 * Never throws. Every failure comes back as a status, because this runs inside the reply
 * pipeline and an exception here would be reported as a generic failure, losing the code
 * that explains WHY the comment was skipped.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Object} params.index - the result of getKnowledgeIndex(); must be retrievable
 * @param {Function} [params.complete] - async (messages, options) => {text}, INJECTED
 * @param {Object} [params.options] - overrides for RETRIEVAL_DEFAULTS
 * @param {Array<Object>} [params.scope] - knowledge scope from the active template (§22), as
 *        returned by `parseScope()`. Restricts which documents may contribute evidence.
 * @param {string[]} [params.extraTerms] - canonical terms from the Phase 20.6 intent stage,
 *        added to the local query. The RERANK PROMPT STILL SEES THE COMMENT ALONE, and that
 *        asymmetry is deliberate: telling the reranker "the intent is book_price" nudges it
 *        toward price-shaped sections, which biases the pipeline toward ANSWERING. When the
 *        knowledge base has no price, §2 wants a skip, and a biased reranker is the wrong
 *        place to create one. The intent decides answerability in 20.7, against what was
 *        actually retrieved.
 * @returns {Promise<{status: string, state: string, results: Array<Object>,
 *   code: string, reason: string, offeredCount: number, consideredCount: number}>}
 */
/**
 * A readable digest of what was actually offered to the reranker.
 *
 * Phase 22.1. When the reranker returns an empty ranking, "the model found no relevant
 * section in the shortlist" is a true sentence that answers nothing a user can act on: the
 * question is always whether the section holding the answer was IN the shortlist at all,
 * and nothing above reported that. A price buried in a long chapter is dropped by
 * `toCandidateShortlist`'s character budget before this point, so the shortlist can be
 * short of exactly the one section that would have answered the comment.
 *
 * File + heading only — never content. This rides the one-second poll and the content is
 * the user's own material; the heading is what identifies a section and costs a fraction
 * of the size.
 *
 * @param {Array<Object>} shortlist
 * @param {number} [limit]
 * @returns {Array<{filename: string, heading: string, chars: number}>}
 */
export function summarizeShortlist(shortlist, limit = 8) {
  const entries = Array.isArray(shortlist) ? shortlist : [];
  const out = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    const s = entry && entry.section;
    if (!s) continue;
    out.push({
      filename: typeof s.filename === 'string' ? s.filename : '',
      heading: (Array.isArray(s.headingPath) ? s.headingPath : []).join(' > '),
      // The character count is the whole point of this digest: it says WHY a section is not
      // here (too big for the budget) as well as what is.
      chars: typeof s.content === 'string' ? s.content.length : 0
    });
  }
  return out;
}

export async function retrieveKnowledge({ commentText, index, complete, options = {}, extraTerms = [], scope = [] }) {
  const config = { ...RETRIEVAL_DEFAULTS, ...(options || {}) };
  const unavailable = (code, reason) => ({
    status: RETRIEVAL_STATUS.UNAVAILABLE,
    state: '',
    results: [],
    code,
    reason,
    offeredCount: 0,
    consideredCount: 0
  });

  // The gate is not re-implemented here. An index that is not authorized is refused, which
  // means a caller cannot reach a stale index by coming straight to retrieval.
  if (!index || index.retrievable !== true) {
    return unavailable(KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, 'the knowledge index is not usable');
  }

  // `usableSections()`, NOT `index.sections`. An EMPTY section — a heading the user wrote with
  // no body — is kept in the index on purpose (20.4: dropping it would change the document's
  // shape) and is marked so `isSectionUsable()` can keep it OUT of retrieval. 20.4 exported that
  // filter and nothing called it, so a bodyless heading could be ranked, offered to the reranker
  // and then APPROVED as evidence: the model would be asked whether an empty section answers the
  // question, and with the price in a sibling section the grounded reply could lose its own
  // source. Found by the Phase 20.16 end-to-end check, which is the first thing to drive the
  // real pipeline.
  let sections = usableSections(index);
  if (sections.length === 0) {
    const total = Array.isArray(index.sections) ? index.sections.length : 0;
    return unavailable(
      KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      total > 0
        ? `the knowledge base has ${total} section(s) but none of them has any content`
        : 'the knowledge base has no sections'
    );
  }

  // Phase 20.13 — a template may scope which knowledge this comment can draw on (§22). Applied
  // HERE rather than at index time, because the scope belongs to the active template and so
  // changes per video, while an index is the whole base.
  //
  // A scope that matches nothing is reported as a MISCONFIGURATION rather than as an empty
  // base. The two look identical from the caller's side, and silently reporting "no relevant
  // knowledge" would leave a user whose scope is typo'd wondering why every comment skips.
  if (Array.isArray(scope) && scope.length > 0) {
    const narrowed = filterSectionsByScope(sections, scope);
    if (narrowed.sections.length === 0) {
      return unavailable(
        KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
        `the template scope matched none of the ${sections.length} indexed sections`
      );
    }
    sections = narrowed.sections;
  }

  const ranked = rankSections(sections, commentText, extraTerms);
  const shortlist = toCandidateShortlist(ranked, config);

  if (shortlist.length === 0) {
    return {
      status: RETRIEVAL_STATUS.NO_RESULTS,
      state: '',
      results: [],
      code: KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      reason: 'no section could be shortlisted',
      offeredCount: 0,
      consideredCount: sections.length,
      shortlist: []
    };
  }

  let order = shortlist.map((entry) => entry.section.evidenceId);
  let state = RETRIEVAL_STATE.LOCAL_ONLY;
  let modelScores = new Map();

  // Without a model, or when the model cannot be read, the local order stands. Both are
  // results — only a genuinely empty base is NO_RESULTS.
  if (typeof complete === 'function') {
    let response = null;
    try {
      response = await complete(buildRerankMessages(commentText, shortlist), {
        // Named so this request is distinguishable from generation and classification in the
        // diagnostic log; without it every knowledge call reads as operation=UNKNOWN.
        ...RERANK_OPTIONS
      });
    } catch (_) {
      // LM Studio unreachable, model not loaded, timeout — all "use the local order".
      response = null;
    }

    const parsed = parseRerankResult(response && response.text, shortlist);

    if (parsed && parsed.ids.length > 0) {
      order = parsed.ids;
      state = RETRIEVAL_STATE.RERANKED;
      modelScores = parsed.rankById;
    } else if (parsed) {
      // An empty list from the model is meaningful and honoured: the model considered the
      // shortlist and found nothing relevant. That IS a no-result.
      //
      // Phase 22.2 TRIED to override this — falling back to the local order whenever the
      // reranker discarded everything, on the grounds that a small model going quiet is not
      // proof of absence. The existing suite refused it, and the suite was right:
      // `testShippingCostIsNotShippingDuration` is §13's own example, and it pins that a
      // shipping PRICE section must NOT answer a question about shipping DAYS. Falling back
      // readmits exactly the section the reranker exists to exclude, and the answerability
      // gate is a model call too — it is not a second, independent arbiter of the same
      // judgement, so it cannot be relied on to catch what the reranker let through.
      //
      // The over-strictness is a PROBLEM, so it is fixed in the prompt below, where the
      // model is told what "relevant" means, rather than by discarding the model's verdict.
      // An empty ranking that the model got wrong has to be fixed by making the question
      // clearer, not by removing the answer.
      return {
        status: RETRIEVAL_STATUS.NO_RESULTS,
        state: RETRIEVAL_STATE.RERANKED,
        results: [],
        code: KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
        reason: 'the model found no relevant section in the shortlist',
        offeredCount: shortlist.length,
        consideredCount: sections.length,
        shortlist: summarizeShortlist(shortlist)
      };
    }
    // Unreadable → LOCAL_ONLY, deliberately NOT a no-result.
  }

  const byId = new Map(shortlist.map((entry) => [entry.section.evidenceId, entry]));

  const results = [];
  for (const id of order) {
    if (results.length >= config.maxResults) break;
    const entry = byId.get(id);
    if (!entry) continue;
    const reranked = modelScores.get(id);
    results.push({
      evidenceId: id,
      documentId: entry.section.documentId,
      filename: entry.section.filename,
      category: entry.section.category,
      headingPath: entry.section.headingPath,
      content: entry.section.content,
      // Phase 20.19 fix — the document's AUTHORITY, carried through from the section.
      //
      // 20.7's gate and 20.12's audit both resolve §18 precedence from these results, and
      // without these three fields they compared documents whose priority, version and edit
      // time had never been read: every pair looked like equal authority, so a conflict
      // that §18 decides was reported as ambiguous and the comment was SKIPPED. That made
      // 20.12's own advice ("give one of them a higher priority") permanently ineffective
      // for anyone who acted on it — evidence removed with no way to earn it back.
      //
      // They are not prompts: both the rerank catalogue and the grounded prompt are built
      // from `index.sections` and read only headingPath and content, so nothing here can
      // reach the model.
      enabled: entry.section.enabled !== false,
      priority: typeof entry.section.priority === 'number' ? entry.section.priority : 0,
      version: typeof entry.section.version === 'number' ? entry.section.version : 1,
      updatedAt: typeof entry.section.updatedAt === 'number' ? entry.section.updatedAt : 0,
      // Relevance metadata, as §6 asks for. `localScore` is always present and always
      // explainable; `modelScore` is null when no model ranked it, so a diagnosis can tell
      // "the model said this was irrelevant" from "the model was never asked".
      localRank: entry.rank,
      localScore: Number(entry.score.toFixed(4)),
      coverage: Number(entry.coverage.toFixed(4)),
      headingCoverage: Number(entry.headingCoverage.toFixed(4)),
      matchedTerms: entry.matchedTerms,
      modelScore: reranked ? reranked.score : null
    });
  }

  if (results.length === 0) {
    return {
      status: RETRIEVAL_STATUS.NO_RESULTS,
      state,
      results: [],
      code: KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      reason: 'nothing survived the ordering',
      offeredCount: shortlist.length,
      consideredCount: sections.length,
      shortlist: summarizeShortlist(shortlist)
    };
  }

  return {
    status: RETRIEVAL_STATUS.RETRIEVED,
    state,
    results,
    code: '',
    reason: '',
    offeredCount: shortlist.length,
    consideredCount: sections.length,
    shortlist: summarizeShortlist(shortlist)
  };
}
