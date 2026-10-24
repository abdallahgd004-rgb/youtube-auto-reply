/**
 * AI Intent Understanding — Phase 20.6
 *
 * Turns a comment into `{intent, entities}` per §9, so downstream stages stop working from
 * raw Arabic alone. This is the first stage that reads the comment for MEANING rather than
 * for keywords.
 *
 * ── The one rule that governs this file ──────────────────────────────────────────
 *
 * §42: "The model is responsible for understanding and wording. The Knowledge Base is
 * responsible for facts." §9 says the same about this output specifically: it "is not
 * itself the source of truth."
 *
 * That is easy to state and easy to break, so it is enforced structurally rather than by
 * convention:
 *
 *   - `intent` is a member of a CLOSED vocabulary. It cannot carry a value.
 *   - entity values are STRINGS ONLY. An object or array is rejected outright rather than
 *     coerced, because `{"subject":{"name":"كيمياء","price":300}}` stringified into a
 *     retrieval term is a fabricated price laundered into the pipeline as "understanding".
 *   - `entities` never reach a reply. They become `searchTerms`, which are retrieval input
 *     and nothing else; which sections those terms select is decided by 20.5, and whether
 *     the selected sections actually support an answer is decided by 20.7 and 20.10.
 *
 * ── Why a failure here is NOT a failure of the comment ─────────────────────────
 *
 * This is deliberately NOT a safety boundary, and it is the sharpest difference from
 * `semantic-matcher.js`. There, an unreadable answer must mean "do not reply", so
 * `ok:false` blocks the path. Here it must not: retrieval already works from the comment
 * text alone (20.5 takes `commentText`), so a failed intent call costs one enrichment and
 * nothing else. Treating `INTENT_PARSE_FAILED` as fatal would mean a chatty model disables
 * grounded replies entirely — trading a working feature for a diagnostic.
 *
 * So `ok:false` means "the structured output was not valid, here is why", and the caller
 * proceeds with the raw comment. It is NOT "do not reply". The code is still reported
 * because §32 requires a useful skip/failure reason and "the model failed here" is
 * genuinely different from "the knowledge base has no price".
 *
 * ── All-or-nothing ─────────────────────────────────────────────────────────────
 *
 * A partially valid answer is discarded rather than half-applied. `intent` and `entities`
 * are interpreted together, so accepting one and dropping the other yields a combination
 * the model never actually asserted; and with `intent` alone the caller still has the
 * comment. Every failure therefore returns the SAME shape — `UNKNOWN`, `{}`, `''` — so no
 * caller can accidentally branch on a half-populated result.
 *
 * PURE: no chrome, no DOM, no network. `complete` is injected, exactly as in
 * `semantic-matcher.js`, so this adds no second HTTP client.
 */

import { KNOWLEDGE_ERROR } from './knowledge-schema.js';
import { toRetrievalTerms } from './knowledge-retrieval.js';
import { structuredCallOptions } from './reasoning-budget.js';

// ── Vocabulary ─────────────────────────────────────────────────────────────────

/**
 * The intents this phase understands.
 *
 * CLOSED on purpose — that closure IS the validation of `intent` (§20.6 "Validate the
 * structured output before using it"). An open vocabulary would mean any string the model
 * emitted became a valid intent, which is validation that cannot fail.
 *
 * The set is sized to what a knowledge base for a channel actually gets asked. It is NOT a
 * taxonomy of every possible comment: `COMPLAINT`, `PRAISE` and `OTHER` exist so that a
 * comment with nothing to retrieve is classified as such instead of being forced into a
 * fact-seeking intent, which is what makes 20.7's answerability gate honest.
 *
 * `book_price` is §9's own example and is deliberately the spelling of record, so the
 * documented output and the code agree.
 */
export const INTENT = Object.freeze({
  /** The price of a product. §38 Tests 1 and 2. */
  BOOK_PRICE: 'book_price',
  /** Whether something is in stock or obtainable. */
  AVAILABILITY: 'availability',
  /** Shipping — cost, duration, destinations. §38 Test 3. */
  SHIPPING: 'shipping',
  /** Which edition, grade or year-level applies. */
  EDITION: 'edition',
  /** What a book or product covers, chapter contents, syllabus. */
  CONTENT: 'content',
  /** Where or how to buy. */
  PURCHASE: 'purchase',
  /** How to reach the channel, or a person. */
  CONTACT: 'contact',
  /** A complaint. Usually nothing factual to answer. */
  COMPLAINT: 'complaint',
  /** Praise, with no question in it. */
  PRAISE: 'praise',
  /** A real question that is none of the above. */
  OTHER: 'other',
  /** No intent could be established. */
  UNKNOWN: 'unknown',
});

/** Every valid intent value, for membership tests. */
const INTENT_VALUES = new Set(Object.values(INTENT));

/**
 * Intents that are asking for information the knowledge base could supply.
 *
 * Used to label an intent as fact-seeking without making that a DECISION. `analyzeIntent`
 * never returns "this comment is answerable" — that is 20.7's job, against actual retrieved
 * sections, and deciding it here would mean deciding it without having read the knowledge.
 */
const FACT_SEEKING_INTENTS = new Set([
  INTENT.BOOK_PRICE,
  INTENT.AVAILABILITY,
  INTENT.SHIPPING,
  INTENT.EDITION,
  INTENT.CONTENT,
  INTENT.PURCHASE,
  INTENT.CONTACT,
  INTENT.OTHER,
]);

// ── Limits ─────────────────────────────────────────────────────────────────────

/**
 * Caps on the model's output.
 *
 * These are not politeness limits — each one bounds a way a small model turns this call
 * into a way of shipping arbitrary text into the pipeline.
 *
 * A comment is bounded by YouTube; an entity value is not supposed to be longer than a
 * few words of it. Exceeding these means the model stopped answering the question and
 * started dumping context — and the response is REJECTED rather than truncated, because a
 * silently cut value ("كتاب الكيمياء 3 ثانوي كتاب التفوق…" → 80 characters) is a CORRUPTED
 * entity, and a corrupted retrieval term is worse than no entity at all: it looks like
 * understanding and steers 20.5 toward the wrong section while the caller believes the
 * comment was understood. Failing costs one enrichment and leaves the raw comment intact.
 */
export const MAX_INTENT_ENTITIES = 12;
export const MAX_ENTITY_VALUE_CHARS = 80;
export const MAX_REQUEST_CHARS = 120;

/** Size of the JSON answer this call has to be able to emit: a slug plus a few entities. */
export const INTENT_ANALYSIS_PAYLOAD_TOKENS = 200;

/**
 * Request options for the LM Studio call.
 *
 * Phase 20.24 — the ceiling is owned by `core/reasoning-budget.js`; `maxTokens` here is only
 * the size of the ANSWER. The original comment on this block said 200 was "bounded well below
 * the 1500 reply budget" to leave room for thinking — which is the right instinct attached to
 * the wrong number, because the room for thinking has to be ADDED to the payload rather than
 * carved out of it. Measured against the model in use, this call spent 184 of its 200 tokens
 * thinking and finished with sixteen to spare: a pass that was one longer comment away from
 * being an empty response on every single comment.
 */
export const INTENT_ANALYSIS_OPTIONS = Object.freeze(
  structuredCallOptions({ maxTokens: INTENT_ANALYSIS_PAYLOAD_TOKENS, operation: 'INTENT_ANALYSIS' })
);

// ── Prompt ─────────────────────────────────────────────────────────────────────

/**
 * Build the intent prompt.
 *
 * Kept as short as reliability allows, for the same reasons as the semantic-match prompt:
 * no request to explain, no chain-of-thought, no request to answer the comment. Every one of
 * those invites prose into the output and costs tokens for information nobody uses.
 *
 * The intent list is given as a closed enumeration rather than described, because "choose
 * one of these" is a question a small model answers reliably and "classify the intent" is
 * one it answers with an invented fourth category.
 *
 * @param {string} commentText
 * @returns {Array<{role: string, content: string}>}
 */
export function buildIntentAnalysisMessages(commentText) {
  const intents = Object.values(INTENT).join(', ');

  return [
    {
      role: 'system',
      content:
        'You read YouTube comments and describe what each one is asking for. ' +
        'You understand Egyptian Arabic, Modern Standard Arabic, paraphrases and spelling variations. ' +
        'Never answer the comment yourself, and never state a price, date or any other fact — ' +
        'other systems look the facts up. ' +
        `Choose exactly one intent from this list: ${intents}. ` +
        'Put the subject, product, grade or year-level the comment mentions in "entities". ' +
        'Use "unknown" for the intent and empty entities if you cannot tell. ' +
        'Answer with JSON only, no explanation, no markdown: ' +
        '{"intent":"<one from the list>","entities":{"<key>":"<value>"}}'
    },
    {
      role: 'system',
      content:
        'Entity values must be short plain text copied from the comment, such as a subject, ' +
        'product name, grade or year-level. Never put an object, a list or a number as a value, ' +
        'and never put a price or any answer in one.'
    },
    {
      role: 'user',
      content:
        'Comment:\n' +
        String(commentText == null ? '' : commentText) +
        '\n\nJSON only.'
    }
  ];
}

// ── Parsing and validation ─────────────────────────────────────────────────────

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that a bare `JSON.parse` would fail on
 * correct answers. First `{` to last `}` is the same tolerance `semantic-matcher.js` and
 * 20.5's rerank parser use.
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

/** A plain object — not null, not an array. */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fold a model-written intent into a vocabulary member.
 *
 * Tolerates the shapes a model actually produces for the same intent — `"Book Price"`,
 * `"book-price"`, `"book price"` — because rejecting those would reject the correct answer
 * over punctuation. It cannot widen the vocabulary: anything unrecognised becomes
 * `UNKNOWN`, which is a real classification ("this comment is not one I understand"), not
 * an error.
 *
 * @param {*} value
 * @returns {string} a member of INTENT
 */
export function normalizeIntent(value) {
  if (typeof value !== 'string') return INTENT.UNKNOWN;

  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return INTENT_VALUES.has(slug) ? slug : INTENT.UNKNOWN;
}

/**
 * Validate the `entities` object.
 *
 * The rules encode one distinction: **absent is not invalid, wrongly-typed is.**
 *
 *   - `null`/`undefined` → the key has no value. Valid, and dropped.
 *   - `""` → no value. Valid, and dropped.
 *   - string/number/boolean → a value. Coerced to a trimmed string, because the model may
 *     legitimately return `{"quantity":3}` and discarding it would lose real understanding.
 *   - object/array → INVALID, and the whole answer is rejected. This is the rule that
 *     protects §42. A nested structure is how a model smuggles a composed claim past a
 *     string-only check, and this stage is precisely where "the model decided a fact" has
 *     to stop.
 *
 * @param {*} value
 * @returns {{ok: boolean, entities: object, reason: string}}
 */
function validateEntities(value) {
  if (value === undefined || value === null) return { ok: true, entities: {}, reason: '' };
  if (!isPlainObject(value)) return { ok: false, entities: {}, reason: 'entities is not an object' };

  const keys = Object.keys(value);
  if (keys.length > MAX_INTENT_ENTITIES) {
    return {
      ok: false,
      entities: {},
      reason: `${keys.length} entities exceeds the ${MAX_INTENT_ENTITIES} allowed`
    };
  }

  const entities = {};
  for (const key of keys) {
    // A key has to be nameable to be usable downstream, and an empty one is a formatting
    // artefact of the model rather than something a caller can key on.
    const name = String(key).trim();
    if (!name) return { ok: false, entities: {}, reason: 'an entity key was empty' };

    const raw = value[key];
    if (raw === undefined || raw === null) continue;

    if (typeof raw === 'object') {
      return {
        ok: false,
        entities: {},
        reason: `entity "${name}" is an object or list, which cannot be validated as an entity value`
      };
    }
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      return { ok: false, entities: {}, reason: `entity "${name}" has an unusable value type` };
    }

    const text = String(raw).trim();
    if (!text) continue;

    if (text.length > MAX_ENTITY_VALUE_CHARS) {
      return {
        ok: false,
        entities: {},
        reason: `entity "${name}" is ${text.length} characters, over the ${MAX_ENTITY_VALUE_CHARS} allowed`
      };
    }

    entities[name] = text;
  }

  return { ok: true, entities, reason: '' };
}

/**
 * Interpret a model response as structured intent.
 *
 * This is the validation boundary. It returns `ok:true` only when BOTH the intent is a
 * vocabulary member and every entity value is a validated string — anything else is
 * `ok:false` with the whole answer discarded.
 *
 * Note the asymmetry with `parseSemanticMatchResult`: an intent that is merely
 * *unrecognised* is not a failure, because `unknown` is a correct and useful reading. Only
 * a malformed answer fails.
 *
 * @param {string} raw - the assistant text from LM Studio
 * @returns {{ok: boolean, intent: string, entities: object, request: string, reason: string}}
 */
export function parseIntentAnalysisResult(raw) {
  const failure = (reason) => ({
    ok: false,
    intent: INTENT.UNKNOWN,
    entities: {},
    request: '',
    reason
  });

  const json = extractJson(raw);
  if (!json) return failure('no JSON object in response');

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return failure('invalid JSON');
  }

  if (!isPlainObject(parsed)) return failure('unexpected schema');

  if (typeof parsed.intent !== 'string' || !parsed.intent.trim()) {
    return failure('intent is missing');
  }

  const entities = validateEntities(parsed.entities);
  if (!entities.ok) return failure(entities.reason);

  // §8 lists "what information the commenter is requesting" as part of what the system
  // should understand, so it is carried for 20.8's grounded prompt. Optional and never
  // load-bearing: `null` means absent, and a wrong type is rejected for the same reason a
  // wrong-typed entity is.
  let request = '';
  if (parsed.request !== undefined && parsed.request !== null) {
    if (typeof parsed.request !== 'string') return failure('request is not a string');
    request = parsed.request.trim();
    if (request.length > MAX_REQUEST_CHARS) {
      return failure(`request is ${request.length} characters, over the ${MAX_REQUEST_CHARS} allowed`);
    }
  }

  return {
    ok: true,
    intent: normalizeIntent(parsed.intent),
    entities: entities.entities,
    request,
    reason: 'parsed'
  };
}

// ── Retrieval terms ────────────────────────────────────────────────────────────

/**
 * Derive retrieval terms from an intent result.
 *
 * Terms come from entity VALUES only, never from entity keys and never from the intent
 * slug, and that is deliberate:
 *
 *   - The slug is an English identifier (`book_price`) while the knowledge base is written
 *     in Arabic. Folding it into the query adds a term that matches nothing, and worse,
 *     weights every section equally with a term none of them contain. The intent belongs in
 *     20.7's answerability decision, not in a bag of Arabic words.
 *   - Entity VALUES are drawn from the comment, so they are in the comment's language and
 *     `toRetrievalTerms` folds them exactly as it folds the comment — which is the point:
 *     a commenter who writes "الكيمياء" and a heading that reads "كيمياء" become one term.
 *
 * The terms are an ADDITION to the comment's own terms, never a replacement: retrieval must
 * keep working from the raw comment, because that is what survives when this call fails.
 *
 * @param {{entities?: object, intent?: string}} result - an analyzeIntent() result
 * @returns {string[]}
 */
export function toIntentSearchTerms(result) {
  if (!isPlainObject(result) || !isPlainObject(result.entities)) return [];

  const terms = [];
  for (const value of Object.values(result.entities)) {
    for (const term of toRetrievalTerms(value)) {
      if (!terms.includes(term)) terms.push(term);
    }
  }
  return terms;
}

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Understand what a comment is asking for.
 *
 * NEVER REJECTS. An unreachable LM Studio, a timeout, an empty answer and a malformed
 * answer all return `ok:false` with `INTENT.UNKNOWN` and no entities, because the caller
 * still has the comment text and retrieval still works from it. See the file header for why
 * this is deliberately unlike `semanticMatchTriggers`.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Function} params.complete - async (messages, options) => {text}, injected so this
 *        module reuses the existing API client rather than adding one.
 * @returns {Promise<{ok: boolean, intent: string, entities: object, request: string,
 *   factSeeking: boolean, searchTerms: string[], code: string, reason: string}>}
 */
export async function analyzeIntent({ commentText, complete } = {}) {
  const unusable = (reason) => ({
    ok: false,
    intent: INTENT.UNKNOWN,
    entities: {},
    request: '',
    factSeeking: false,
    searchTerms: [],
    code: KNOWLEDGE_ERROR.INTENT_PARSE_FAILED,
    reason,
    // Every outcome carries `raw`, including the ones with nothing to carry. The parse
    // failure is the one case where the model's own words are worth keeping — they are the
    // only way to tell "it answered in prose" from "it answered with the wrong shape" — and
    // having it on some paths and not others would make the result shape depend on HOW the
    // call failed, which is the kind of asymmetry a caller ends up branching on.
    raw: ''
  });

  const text = String(commentText == null ? '' : commentText).trim();
  if (!text) return unusable('empty comment');
  if (typeof complete !== 'function') return unusable('no completion function');

  let response;
  try {
    response = await complete(buildIntentAnalysisMessages(text), {
      ...INTENT_ANALYSIS_OPTIONS,
      // Named so this request is distinguishable from reranking, classification and
      // generation in the diagnostic log. Without it every knowledge call reads as
      // operation=UNKNOWN, which is exactly the problem AGENTS.md records for
      // semanticMatchTriggers.
      operation: 'INTENT_ANALYSIS'
    });
  } catch (error) {
    // Phase 20.24 — a thinking-model budget overrun is its own cause, not a transport
    // failure. The distinction is kept because this stage fails OPEN (the comment is still
    // processed without an intent), so the only record of a systematic overrun is this
    // reason string; collapsing it into "LM Studio call failed" would leave a whole channel
    // silently unenriched with no clue why.
    const reason = error && error.isReasoningBudget
      ? 'the model spent the whole token budget thinking and returned no intent'
      : 'LM Studio call failed: ' + (error && error.message ? error.message : 'unknown error');
    return unusable(reason);
  }

  const raw = response && typeof response.text === 'string' ? response.text : '';
  if (!raw.trim()) {
    // A reasoning model that spent the whole token budget thinking leaves no content. The
    // same controlled failure semantic-matcher.js treats this as.
    return unusable('empty response');
  }

  const parsed = parseIntentAnalysisResult(raw);
  if (!parsed.ok) {
    return {
      ...unusable(parsed.reason),
      // The model's own words, so a diagnostic can show what was actually returned.
      raw
    };
  }

  return {
    ok: true,
    intent: parsed.intent,
    entities: parsed.entities,
    request: parsed.request,
    factSeeking: FACT_SEEKING_INTENTS.has(parsed.intent),
    searchTerms: toIntentSearchTerms(parsed),
    code: '',
    reason: parsed.reason,
    raw
  };
}

/**
 * Is this intent one that expects an answer from the knowledge base?
 *
 * Exposed for the answerability stage and the processing UI. Deliberately a LABEL, not a
 * decision: `false` here does not authorise skipping, and `true` does not authorise
 * answering. Only 20.7, reading actual retrieved sections, may do either.
 *
 * @param {string} intent
 * @returns {boolean}
 */
export function isFactSeeking(intent) {
  return FACT_SEEKING_INTENTS.has(intent);
}
