/**
 * Answerability Gate — Phase 20.7
 *
 * The last checkpoint before a factual reply is generated. It answers one question: does the
 * knowledge that 20.5 actually retrieved contain what this comment is asking for?
 *
 * ── The organising principle of this file ───────────────────────────────────────
 *
 * Phase 20 has three stages that ask the model a question and act on the answer, and they
 * split cleanly by what a failure would mean:
 *
 *   - A stage that only ADDS information fails OPEN. That is 20.6's intent stage: it enriches
 *     an already-working retrieval, so a model glitch costs one enrichment.
 *   - A stage that GRANTS PERMISSION fails CLOSED. That is this one, and it is the reason the
 *     two behave differently.
 *
 * Getting this backwards in either direction is a real bug, and they fail in opposite ways.
 * An unreadable answerability answer treated as "yes" generates a reply the knowledge does
 * not support — a hallucination, which is the one outcome §42 exists to prevent. Treated as
 * "no" it silently stops grounded replies working for a model that formats badly.
 *
 * The second is recoverable and loud, so this stage fails closed AND reports
 * `ANSWERABILITY_PARSE_FAILED`, which §32 buckets as an AI issue precisely so the processing
 * UI can say "the model failed" instead of "the knowledge base has no price". A user who
 * cannot tell those apart sees a working feature that knows nothing, and goes looking in
 * their Markdown files.
 *
 * ── Conflicts are decided BEFORE the model, and never by it ─────────────────────
 *
 * §18: "The model must not simply choose one based on intuition." So a conflict is detected
 * deterministically here, from 20.1's `resolveDocumentPrecedence`, and short-circuits the
 * whole stage. Asking a model whether 350 or 370 is right invites it to pick the one that
 * reads more confidently, which is exactly the failure §18 names.
 *
 * "Conflict" here is narrow on purpose: two enabled documents of EQUAL authority that
 * contribute DIFFERENT content under the SAME heading. Equal authority is 20.1's
 * `ambiguous` verdict; same heading is what makes them claims about the same thing; different
 * content is what makes them contradict rather than complement. Two documents that agree,
 * or that cover different subjects, are not a conflict and must not be skipped — a gate that
 * skipped those would make a well-organised base unusable.
 *
 * ── The decision BINDS the evidence ─────────────────────────────────────────────
 *
 * The returned `evidence` is exactly what was offered to the model and approved by it, and
 * 20.8's grounded prompt must be built from that same set. Letting generation draw from a
 * wider set than the gate judged would mean the gate approved one set of facts and the reply
 * was written from another — the approval would be decorative. Returning it here makes that
 * binding explicit rather than something two later stages have to remember.
 *
 * ── `confidence` is recorded, never gated on ────────────────────────────────────
 *
 * §12's shape carries a confidence number, so it is parsed and validated. It is not used as a
 * threshold, and this is a decision rather than an omission: a model's self-reported
 * confidence is uncalibrated, and in practice small models emit 0.95 for a confident answer
 * and 0.9 for a guess. A threshold built on that either never fires — pointless — or fires
 * arbitrarily, skipping answerable comments at random. An uncalibrated number that silently
 * decides whether a viewer gets an answer is worse than no number at all. It is surfaced for
 * diagnostics and for 20.24's UI instead.
 *
 * PURE: no chrome, no DOM, no network. `complete` is injected, as everywhere else in this
 * phase.
 */

import { KNOWLEDGE_ERROR } from './knowledge-schema.js';
import { RETRIEVAL_STATUS } from './knowledge-retrieval.js';
import { resolveSectionConflict } from './knowledge-conflicts.js';
import { structuredCallOptions } from './reasoning-budget.js';

/** Every outcome this gate can produce. */
export const ANSWERABILITY = Object.freeze({
  /** The knowledge supports an answer. Generation may proceed. */
  CAN_ANSWER: 'CAN_ANSWER',
  /** §24's deliberate skip: understood, asked, and not supported. The feature working. */
  NO_SUPPORTED_ANSWER: 'NO_SUPPORTED_ANSWER',
  /** Two equal-authority documents contradict each other. */
  CONFLICTING_KNOWLEDGE: 'CONFLICTING_KNOWLEDGE',
  /** Retrieval produced nothing to judge. Carried through rather than reinterpreted. */
  NO_RELEVANT_KNOWLEDGE: 'NO_RELEVANT_KNOWLEDGE',
  /** The model could not be read. Fail closed, and say so. */
  UNDETERMINED: 'UNDETERMINED',
});

/** Limits for what is shown to the model, and for the request. */
export const ANSWERABILITY_DEFAULTS = Object.freeze({
  // §11 says "Top 3 relevant sections" and that the number should be configurable. Five is
  // the same ballpark: enough for a price that is split across a heading and a table, few
  // enough that the model is not asked to weigh a whole base.
  maxSections: 5,
  // Per section. Overflow is DROPPED, never truncated — see below.
  maxSectionChars: 600,
  /**
   * Size of the JSON verdict this call has to be able to emit — NOT the request ceiling.
   *
   * Phase 20.24: the request ceiling is this plus the reasoning headroom, applied by
   * `structuredCallOptions()`. Measured against the model in use, this stage spent 399 tokens
   * thinking and was cut off with an EMPTY `content` at the old 300-token ceiling, so the
   * gate returned UNDETERMINED — which fails CLOSED, i.e. every comment went unanswered and
   * the knowledge base read as knowing nothing at all.
   */
  maxTokens: 300,
});

/**
 * Decoding options for the LM Studio call.
 *
 * Phase 20.24 — this carries only the DECISION properties. The ceiling is per-call rather than
 * here because it is derived from `ANSWERABILITY_DEFAULTS.maxTokens`, which is overridable per
 * invocation; a frozen constant would have silently ignored the override. The two are composed
 * by `structuredCallOptions()` at the call site, which is also where the reasoning headroom
 * and the thinking-text opt-out are applied.
 */
export const ANSWERABILITY_OPTIONS = Object.freeze({
  temperature: 0,
});

// ─── Conflict detection ────────────────────────────────────────────────────────

/**
 * Decide whether retrieved sections contradict each other in an unresolvable way.
 *
 * §18's rule lives in `knowledge-conflicts.js` (Phase 20.12) and is delegated to, not
 * reimplemented. The gate needs the per-comment decision and the audit needs the base-wide
 * one, from the SAME comparator and the same notion of what counts as a contradiction: two
 * copies drift silently, and the drift shows up as a user who fixes a conflict the gate does
 * not agree with.
 *
 * Only ENABLED documents compete, only a shared heading with DIFFERENT content counts, and
 * identical content is agreement — a user keeping a backup copy of a price list must not make
 * every price question unanswerable.
 *
 * @param {Array<Object>} sections - the retrieved sections (20.5 results)
 * @returns {{conflicting: boolean, documents: Array<Object>, reason: string}}
 */
export function detectConflict(sections) {
  const outcome = resolveSectionConflict(sections);
  return {
    conflicting: outcome.conflicting,
    documents: outcome.documents,
    reason: outcome.reason,
    heading: outcome.heading
  };
}

// ─── Evidence ──────────────────────────────────────────────────────────────────

/**
 * Bound and select the evidence shown to the model.
 *
 * OVERFLOW IS DROPPED, never truncated, for the same reason 20.5 drops shortlist overflow:
 * a half-quoted section is a grounding hazard, and §2 prefers skipping to a partial claim. A
 * section cut mid-number is worse than no section at all, because the model is being asked
 * whether the knowledge supports an answer and a truncated price supports a wrong one.
 *
 * @param {Array<Object>} results - 20.5 results
 * @param {Object} [options]
 * @returns {{offered: Array<Object>, dropped: number}}
 */
export function selectEvidence(results, options = {}) {
  const config = { ...ANSWERABILITY_DEFAULTS, ...(options || {}) };
  const usable = (Array.isArray(results) ? results : []).filter(Boolean);

  const offered = [];
  let dropped = 0;

  for (const entry of usable) {
    if (offered.length >= config.maxSections) { dropped++; continue; }

    const content = String(entry.content || '');
    if (content.length > config.maxSectionChars) { dropped++; continue; }

    offered.push({
      evidenceId: String(entry.evidenceId || ''),
      documentId: String(entry.documentId || ''),
      filename: String(entry.filename || ''),
      headingPath: Array.isArray(entry.headingPath) ? entry.headingPath.slice() : [],
      content
    });
  }

  return { offered, dropped };
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

/**
 * Build the answerability prompt.
 *
 * The model is shown the comment and the retrieved sections and asked to judge sufficiency.
 * It is NOT shown the intent — the same reasoning as 20.5's reranker. Naming the intent
 * ("this is a price question") biases the judge toward finding a price, and a biased judge
 * here is the most expensive possible bias: it is the last gate before generation.
 *
 * The prompt forbids answering, for the same reason 20.6's does. A judge asked to decide
 * whether it "can" help will help.
 *
 * @param {string} commentText
 * @param {Array<Object>} evidence
 * @returns {Array<{role: string, content: string}>}
 */
export function buildAnswerabilityMessages(commentText, evidence) {
  const sections = (Array.isArray(evidence) ? evidence : []).filter(Boolean);
  const catalogue = sections
    .map((e) => `- ${e.filename || 'knowledge'}${e.headingPath && e.headingPath.length ? ' → ' + e.headingPath.join(' → ') : ''}\n  ${e.content}`)
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You decide whether a set of knowledge sections contains the information a comment is asking about. ' +
        'You understand Egyptian Arabic, Modern Standard Arabic, paraphrases and spelling variations. ' +
        'The comments are on the official channel for "كتب التفوق", so general subject mentions like "كتاب الكيمياء" or "كتاب الفيزياء" refer to that subject\'s book (e.g. كتاب التفوق في الكيمياء). ' +
        'Judge only whether the given sections contain the answer. Never answer the comment yourself, ' +
        'and never supply a price, a date or any other fact from your own knowledge. ' +
        'Identify what product or topic the commenter is asking about and what fact they need. ' +
        'Phrases like "هو عندكو بكام" or "سعره عندكم كام" mean "what is your price for this book?". ' +
        'If the commenter mentions other stores, bookstores, or outside prices as background comparison (e.g. "جبت من مكتبة كذا بـ... هو عندكو بكام"), the question is simply asking for the book\'s price. ' +
        'Answer true if the sections contain the price or information for that book. ' +
        'If the comment asks about something the sections do not mention — such as a shipping duration ' +
        'when only shipping prices are given — answer false. ' +
        'Answer with JSON only, no explanation, no markdown: ' +
        '{"canAnswer":true,"confidence":0.9,"reason":"<short reason>"} or {"canAnswer":false,"reason":"<what is missing>"}'
    },
    {
      role: 'user',
      content:
        'Comment:\n' +
        String(commentText == null ? '' : commentText) +
        '\n\nKnowledge sections:\n' +
        catalogue +
        '\n\nJSON only.'
    }
  ];
}

// ─── Parsing ───────────────────────────────────────────────────────────────────

/** First `{` to last `}`, as everywhere else in this phase. */
function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  return text.slice(start, end + 1);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Interpret a model response as a sufficiency verdict.
 *
 * `canAnswer` is read as a STRICT BOOLEAN, exactly as `parseSemanticMatchResult` reads
 * `matched`. A truthy `1` or the string `"true"` is not accepted: this gate grants permission
 * to state a fact, so an ambiguous reading of the model's own output must not be allowed to
 * lean towards "yes".
 *
 * @param {string} raw
 * @returns {{ok: boolean, canAnswer: boolean, confidence: (number|null), reason: string}}
 */
export function parseAnswerabilityResult(raw) {
  const failure = (reason) => ({ ok: false, canAnswer: false, confidence: null, reason });

  const json = extractJson(raw);
  if (!json) return failure('no JSON object in response');

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return failure('invalid JSON');
  }

  if (!isPlainObject(parsed)) return failure('unexpected schema');
  if (typeof parsed.canAnswer !== 'boolean') return failure('canAnswer is not a boolean');

  // Recorded, never gated on — see the file header. Validated rather than trusted blindly so
  // a nonsense value cannot reach the UI or a later log line.
  let confidence = null;
  if (parsed.confidence !== undefined && parsed.confidence !== null) {
    const value = Number(parsed.confidence);
    confidence = Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }

  // §12 shows a reason on both outcomes, and §31 requires a useful one. Optional, though:
  // a verdict without a reason is still a verdict, and the answerability code already tells
  // the caller whether it was a supported skip or a model failure.
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

  return { ok: true, canAnswer: parsed.canAnswer, confidence, reason };
}

// ─── Entry point ───────────────────────────────────────────────────────────────

/**
 * Decide whether the retrieved knowledge supports an answer to this comment.
 *
 * NEVER REJECTS. Every failure path returns a verdict, because a throwing gate would take
 * down a comment that could still have been skipped cleanly.
 *
 * Order matters: conflict, then evidence, then the model. A conflict is settled without
 * spending a request, and the model is never asked to judge a set that is already known to be
 * self-contradictory.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Array<Object>} params.results - 20.5 results
 * @param {string} [params.retrievalStatus] - 20.5's status, to tell an empty base from a
 *        populated one that simply matched nothing.
 * @param {Function} [params.complete] - async (messages, options) => {text}, injected.
 * @param {Object} [params.options] - overrides for ANSWERABILITY_DEFAULTS
 * @returns {Promise<{status: string, code: string, reason: string, confidence: (number|null),
 *   evidence: Array<Object>, offeredCount: number, droppedCount: number}>}
 */
export async function checkAnswerability({ commentText, results, retrievalStatus, complete, options = {} } = {}) {
  const config = { ...ANSWERABILITY_DEFAULTS, ...(options || {}) };

  const verdict = (status, code, reason, extra = {}) => ({
    status,
    code,
    reason,
    confidence: null,
    evidence: [],
    offeredCount: 0,
    droppedCount: 0,
    ...extra
  });

  // Nothing was retrieved. Passed through as NO_RELEVANT_KNOWLEDGE rather than folded into
  // NO_SUPPORTED_ANSWER, because §32 buckets them differently and the distinction is the
  // difference between "your base has no shipping text" and "your base has no shipping
  // DURATION".
  const usableResults = (Array.isArray(results) ? results : []).filter(Boolean);
  if (usableResults.length === 0) {
    // An empty result because the INDEX was unusable is a different failure from an empty
    // result because nothing matched, and §32 files them under different categories. Folding
    // them together would report a stale or broken index as a healthy "no relevant
    // knowledge", which is the same misreading AGENTS.md records for a missed trigger match.
    if (retrievalStatus === RETRIEVAL_STATUS.UNAVAILABLE) {
      return verdict(
        ANSWERABILITY.NO_RELEVANT_KNOWLEDGE,
        KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED,
        'the knowledge index was not usable, so there was nothing to judge'
      );
    }

    return verdict(
      ANSWERABILITY.NO_RELEVANT_KNOWLEDGE,
      KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      retrievalStatus
        ? `retrieval returned no usable sections (${retrievalStatus})`
        : 'no knowledge sections were retrieved'
    );
  }

  // §18: settled locally, never by the model.
  const conflict = detectConflict(usableResults);
  if (conflict.conflicting) {
    return verdict(
      ANSWERABILITY.CONFLICTING_KNOWLEDGE,
      KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE,
      conflict.reason,
      { offeredCount: usableResults.length }
    );
  }

  const { offered, dropped } = selectEvidence(usableResults, config);
  if (offered.length === 0) {
    // Sections existed but none fit the budget. That is a retrieval-shaped problem, not a
    // knowledge one, and reporting it as "no supported answer" would blame the user's Markdown.
    return verdict(
      ANSWERABILITY.NO_RELEVANT_KNOWLEDGE,
      KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      dropped > 0
        ? `all ${dropped} section(s) exceeded the ${config.maxSectionChars} character limit`
        : 'no section could be offered',
      { droppedCount: dropped }
    );
  }

  if (typeof complete !== 'function') {
    // Fail CLOSED, per the file header. But this is a wiring problem, not a model problem,
    // so it reports the model failure code rather than pretending the knowledge lacks the
    // answer.
    return verdict(
      ANSWERABILITY.UNDETERMINED,
      KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED,
      'no completion function was provided, so sufficiency could not be judged',
      { offeredCount: offered.length, droppedCount: dropped }
    );
  }

  let response;
  try {
    response = await complete(buildAnswerabilityMessages(commentText, offered), {
      // Phase 20.24 — `config.maxTokens` is the size of the verdict; the ceiling sent is that
      // plus the reasoning headroom. A bare `maxTokens` here is the exact shape of the bug
      // this fixes, so it goes through the one owner instead.
      ...structuredCallOptions({ maxTokens: config.maxTokens, operation: 'ANSWERABILITY' })
    });
  } catch (error) {
    // Phase 20.24 — an exhausted thinking budget is named apart from a transport failure.
    // This gate fails CLOSED, so an unreachable model and a truncated one both cost the user
    // every answer; they need different fixes and must not read as the same line in a log.
    const reason = error && error.isReasoningBudget
      ? 'the model spent the whole token budget thinking and returned no verdict'
      : 'LM Studio call failed: ' + (error && error.message ? error.message : 'unknown error');
    return verdict(
      ANSWERABILITY.UNDETERMINED,
      KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED,
      reason,
      { offeredCount: offered.length, droppedCount: dropped }
    );
  }

  const raw = response && typeof response.text === 'string' ? response.text : '';
  const parsed = parseAnswerabilityResult(raw);

  if (!parsed.ok) {
    // Unreadable → undetermined, NOT "cannot answer". The distinction is the difference
    // between the base lacking a shipping duration and the model failing to answer.
    return verdict(
      ANSWERABILITY.UNDETERMINED,
      KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED,
      parsed.reason,
      { offeredCount: offered.length, droppedCount: dropped }
    );
  }

  if (!parsed.canAnswer) {
    return verdict(
      ANSWERABILITY.NO_SUPPORTED_ANSWER,
      KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER,
      // §24's deliberate skip. The model's reason is kept because it is the single most
      // useful line for a user wondering why a comment got no reply.
      parsed.reason || 'the retrieved knowledge does not contain what the comment asks for',
      { offeredCount: offered.length, droppedCount: dropped }
    );
  }

  return {
    status: ANSWERABILITY.CAN_ANSWER,
    code: '',
    reason: parsed.reason || 'the retrieved knowledge supports an answer',
    confidence: parsed.confidence,
    // The approved set, bound to this decision. 20.8 builds its grounded prompt from THIS.
    evidence: offered,
    offeredCount: offered.length,
    droppedCount: dropped
  };
}
