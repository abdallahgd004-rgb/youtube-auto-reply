/**
 * Evidence-Aware Output — Phase 20.9
 *
 * Runs the generation call and turns the model's structured answer into a reply plus the
 * knowledge sections it says it used (§15).
 *
 * ── Citations are for EXPLAINABILITY, not for safety ───────────────────────────
 *
 * It would be easy to assume the model's citations decide what gets validated, and that is
 * not how §16 reads. §16 asks whether the reply's factual claims are "supported by the
 * retrieved knowledge" — the whole approved set — so 20.10 validates the TEXT against
 * everything 20.7 approved, not against what the model happened to mention.
 *
 * That matters, because the alternative is a bug in the direction that loses correct
 * replies: validate only against cited sections, and a model that cites one of two sections
 * it used produces a reply that fails validation for a claim that was perfectly grounded.
 * Under-citation would then cost a regeneration and possibly a skip, every time.
 *
 * So the citations are recorded for §15's stated purposes — validation, debugging,
 * explainability, logging, troubleshooting — and `unmappedIds` (cited but never offered) is
 * surfaced as a quality signal rather than a rejection. A bogus citation cannot create a
 * grounding hole, because 20.10 still checks the reply text against the approved set
 * regardless of what the model claimed.
 *
 * It is worth being explicit that this makes citations non-load-bearing for SAFETY. If a
 * future change starts trusting them to narrow validation, it introduces exactly the bug
 * described above.
 *
 * ── A leaked evidence id is stripped, not rejected ──────────────────────────────
 *
 * §15: the ids "do not need to be shown to YouTube commenters". A model that inlines
 * `KNOWLEDGE-BOOKS-CHEMISTRY-السعر` into the reply has produced a cosmetic defect, and
 * discarding a correct answer over it would be the wrong trade. The id is removed from the
 * text and recorded in `strippedIds` so the defect is still visible in diagnostics.
 *
 * Only ids long enough to be unmistakable are stripped. Every id 20.1 builds starts with
 * `KNOWLEDGE-`, but this module must not assume it is handed well-formed input, and
 * replacing a two-character "id" out of an Arabic sentence would damage real text.
 *
 * ── What this module does NOT do ───────────────────────────────────────────────
 *
 * It does not validate the reply's factual claims — that is 20.10's grounding validator,
 * and duplicating it here would be a second answer to §16 that drifts. It does not run the
 * project's existing reply validator (blacklist, length, near-duplicate), which the caller
 * still applies afterwards. And it does not retry: §17's bounded regeneration is 20.11, and
 * a retry loop started here would be unbounded by construction.
 *
 * PURE apart from the injected completion function.
 */

import {
  buildGroundedMessages,
  buildKnowledgeBlock,
  OUTPUT_FORMAT
} from './grounded-prompt-builder.js';
import { KNOWLEDGE_ERROR } from './knowledge-schema.js';

/** Outcome of the generation stage. */
export const GENERATION_STATUS = Object.freeze({
  /** A reply was produced and is ready for 20.10's grounding validation. */
  GENERATED: 'GENERATED',
  /** The model did not return a usable structured answer. */
  FAILED: 'FAILED',
});

/**
 * Bounds on what the model may return.
 *
 * A reply longer than this is either a runaway generation or a dump of the knowledge block,
 * and the existing reply validator will reject it anyway; failing here gives a better reason
 * and saves the caller the wasted validation.
 */
export const MAX_REPLY_CHARS = 700;

/**
 * Ceiling on cited ids.
 *
 * Set above the number of sections 20.7 can offer, because a model that cites more than it
 * was given is not being helpful — but it is capped rather than rejected outright, since the
 * extra ids are recorded as unmapped and 20.10 still checks the text.
 */
export const MAX_CITED_IDS = 24;

/** Shortest id that may be stripped from reply text. See the file header. */
const MIN_STRIPPABLE_ID_CHARS = 8;

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
 * Interpret a model response as §15's structured answer.
 *
 * Only two things are load-bearing: that there is a JSON object, and that `reply` is a
 * non-empty string. The evidence list is validated for TYPE when present but is not required
 * — a model that returned a well-formed reply without citing anything has produced something
 * 20.10 can still validate, and rejecting it here would discard a usable answer to enforce a
 * convention that carries no safety weight.
 *
 * An `evidence` value of the wrong type IS rejected, because that means the model's output
 * shape is not what was asked for at all, and silently treating `{"evidence":"KNOWLEDGE-A"}`
 * as no citations would hide a real non-compliance behind a plausible-looking result.
 *
 * @param {string} raw
 * @returns {{ok: boolean, reply: string, citedIds: string[], reason: string}}
 */
export function parseGroundedOutput(raw) {
  const failure = (reason) => ({ ok: false, reply: '', citedIds: [], reason });

  // A top-level ARRAY is rejected before extraction rather than after. `extractJson` takes the
  // first `{` to the last `}`, so for `[{"reply":"x"}]` — which has no outer brace pair — it
  // hands back the INNER object and the response looks perfectly valid. Being lenient there
  // would be wrong for a reason that has nothing to do with parsing: an array is what a model
  // emits when it is offering SEVERAL candidate replies, and taking the first is a coin flip.
  // §15's shape is an object, and 20.11's regeneration is what handles non-compliance.
  if (String(raw).trim().startsWith('[')) {
    return failure('the response is a JSON array, not the single object §15 specifies');
  }

  const json = extractJson(raw);
  if (!json) return failure('no JSON object in response');

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return failure('invalid JSON');
  }

  // A plain object only. The bare-array case is not hypothetical: `extractJson` takes the
  // first `{` to the last `}`, and for an input like `[{"reply":"x"}]` there is no brace
  // pair at all, so the WHOLE array arrives here as the "JSON". Without the Array check it
  // parses, `parsed.reply` is undefined on an array, and the failure surfaces as a confusing
  // "reply is not a string" instead of a shape error.
  if (!isPlainObject(parsed)) return failure('unexpected schema');
  if (typeof parsed.reply !== 'string') return failure('reply is not a string');
  const reply = parsed.reply.trim();
  if (!reply) return failure('reply is empty');

  // An ABSENT list is valid; a wrongly-typed one is not. Same rule 20.6 applies to entities.
  let citedIds = [];
  if (parsed.evidence !== undefined && parsed.evidence !== null) {
    if (!Array.isArray(parsed.evidence)) return failure('evidence is not a list');
    if (parsed.evidence.some((id) => typeof id !== 'string')) {
      return failure('evidence contains a value that is not an id');
    }
    citedIds = parsed.evidence
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_CITED_IDS);
  }

  return { ok: true, reply, citedIds, reason: 'parsed' };
}

/**
 * Split cited ids into the ones that were offered and the ones that were not.
 *
 * Duplicates are collapsed rather than rejected: a model that cites the same section twice has
 * said the same thing twice, which is untidy and not wrong.
 *
 * @param {string[]} citedIds
 * @param {Array<Object>} evidence - the gate's approved evidence
 * @returns {{mapped: string[], unmapped: string[]}}
 */
export function mapEvidenceIds(citedIds, evidence) {
  const offered = new Set(
    (Array.isArray(evidence) ? evidence : [])
      .map((item) => String(item?.evidenceId || ''))
      .filter(Boolean)
  );

  const mapped = [];
  const unmapped = [];
  for (const raw of Array.isArray(citedIds) ? citedIds : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (!offered.has(id)) {
      if (!unmapped.includes(id)) unmapped.push(id);
      continue;
    }
    if (!mapped.includes(id)) mapped.push(id);
  }

  return { mapped, unmapped };
}

/**
 * Remove leaked evidence ids from the reply text.
 *
 * Only ids at least `MIN_STRIPPABLE_ID_CHARS` long are removed, so a short or malformed id in
 * the model's answer cannot chew a hole in an Arabic sentence. Runs on the RAW id rather than
 * a folded one: folding would let an id written with Arabic-Indic digits be matched by digits
 * that legitimately belong to a price, which is a far worse outcome than a leaked id.
 *
 * @param {string} reply
 * @param {string[]} ids
 * @returns {{reply: string, stripped: string[]}}
 */
export function stripEvidenceIds(reply, ids) {
  const text = String(reply == null ? '' : reply);
  const removable = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || ''))
    .filter((id) => id.length >= MIN_STRIPPABLE_ID_CHARS);

  if (removable.length === 0) return { reply: text, stripped: [] };

  let out = text;
  const stripped = [];
  for (const id of removable) {
    if (!out.includes(id)) continue;
    out = out.split(id).join('');
    stripped.push(id);
  }

  return {
    reply: out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([،.,!؟:])/g, '$1').trim(),
    stripped
  };
}

/**
 * Generate a grounded reply and map the evidence it says it used.
 *
 * NEVER REJECTS. Every failure path returns a verdict, because a throwing generator would
 * take down a comment that could still have been skipped cleanly.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Array<Object>} params.evidence - the gate's approved evidence. This is the FULL
 *        approved set and it is what 20.10 validates against; the model's citations do not
 *        narrow it.
 * @param {Object} [params.settings]
 * @param {Function} [params.complete] - async (messages, options) => {text}, injected.
 * @returns {Promise<{status: string, reply: string, evidence: Array<Object>,
 *   offeredIds: string[], citedIds: string[], unmappedIds: string[], strippedIds: string[],
 *   code: string, reason: string}>}
 */
export async function generateGroundedReply({ commentText, evidence, settings, complete, corrections = [] } = {}) {
  const failure = (reason, code = KNOWLEDGE_ERROR.GENERATION_FAILED) => ({
    status: GENERATION_STATUS.FAILED,
    reply: '',
    // The approved set is passed through UNCHANGED even on failure. 20.10 validates the reply
    // text against what the gate approved, and that set is a property of the gate, not of
    // this call — so it does not vary with how generation went.
    evidence: (Array.isArray(evidence) ? evidence : []).filter(Boolean),
    offeredIds: buildKnowledgeBlock(evidence).ids,
    citedIds: [],
    unmappedIds: [],
    strippedIds: [],
    code,
    reason
  });

  const prompt = buildGroundedMessages({
    commentText,
    evidence,
    settings,
    outputFormat: OUTPUT_FORMAT.STRUCTURED,
    // §17's regeneration feedback. Passed straight through: turning a validation verdict into
    // an instruction is the regeneration stage's job, not this one's.
    corrections
  });

  if (!prompt.ok) {
    return failure(prompt.reason, prompt.code || KNOWLEDGE_ERROR.GENERATION_FAILED);
  }

  if (typeof complete !== 'function') {
    return failure('no completion function was provided');
  }

  let response;
  try {
    response = await complete(prompt.messages, {
      // Inherits the configured temperature: a reply's wording is part of what generation is
      // for. Named so a grounded generation is distinguishable from reranking, classification
      // and answerability in the diagnostic log.
      temperature: settings?.lmStudio?.temperature,
      maxTokens: settings?.lmStudio?.maxTokens,
      operation: 'GROUNDED_GENERATION'
    });
  } catch (error) {
    return failure('LM Studio call failed: ' + (error && error.message ? error.message : 'unknown error'));
  }

  const raw = response && typeof response.text === 'string' ? response.text : '';
  const parsed = parseGroundedOutput(raw);

  if (!parsed.ok) {
    // An empty response is the reasoning-model case AGENTS.md records: the budget went on
    // thinking and the content came back empty. Same controlled failure either way.
    return failure(raw.trim() ? parsed.reason : 'empty response');
  }

  if (parsed.reply.length > MAX_REPLY_CHARS) {
    return failure(`the reply is ${parsed.reply.length} characters, over the ${MAX_REPLY_CHARS} allowed`);
  }

  const offeredIds = prompt.evidenceIds;
  const { mapped, unmapped } = mapEvidenceIds(parsed.citedIds, evidence);
  const { reply, stripped } = stripEvidenceIds(parsed.reply, offeredIds);

  if (!reply) {
    // Stripping could in principle empty a reply that was only an id. Better to fail than to
    // hand 20.10 an empty string to validate.
    return failure('the reply was empty after removing a leaked evidence id');
  }

  return {
    status: GENERATION_STATUS.GENERATED,
    reply,
    // The full approved set. See the file header: 20.10 checks the TEXT against all of it,
    // not against the citations, because validating against citations loses correct replies.
    evidence: (Array.isArray(evidence) ? evidence : []).filter(Boolean),
    offeredIds,
    citedIds: mapped,
    unmappedIds: unmapped,
    strippedIds: stripped,
    code: '',
    reason: parsed.reason
  };
}
