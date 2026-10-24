/**
 * Hallucination Rejection — Phase 20.11
 *
 * §17's bounded regeneration. A reply that fails grounding validation gets one more attempt
 * with tighter evidence and told specifically what it got wrong; if that also fails, the
 * comment is skipped. §17 is explicit that this must never be an unlimited loop, and the
 * bound here is enforced structurally rather than by trusting the caller.
 *
 * ── What gets retried, and what does not ──────────────────────────────────────
 *
 * ONLY a grounding REJECTION is retried. That is §17's diagram exactly, and the distinction
 * is a cost one:
 *
 *   - GROUNDING_VALIDATION_FAILED means the model produced a reply that said something the
 *     knowledge does not support. A different attempt, with less to work with and told what it
 *     got wrong, has a real chance of doing better. This is the retry.
 *   - GROUNDING_CHECK_FAILED means the VALIDATOR could not be read, and GENERATION_FAILED
 *     means the model did not return §15's shape. Both are the model or the transport failing,
 *     not the answer being wrong. Retrying those spends a second full round of calls to find
 *     out the same thing, and on an unreachable LM Studio it does it again for nothing.
 *
 * So the other two are reported as they are. §17 asks for regeneration after a validation
 * failure, and turning a malformed-response problem into a retry loop is how a transient
 * formatting blip becomes a queue that runs four times slower for no gain.
 *
 * ── The bound is a CONSTANT, not a parameter ─────────────────────────────────
 *
 * `maxAttempts` can be lowered by a caller but never raised past `HARD_MAX_ATTEMPTS`. If the
 * bound were merely a default, one caller passing a large value reintroduces the unlimited
 * loop the milestone exists to forbid — and §17's requirement is that safety is more important
 * than forcing a reply, so the ceiling is not negotiable. Three attempts (one generation and
 * two regenerations) is already generous: the first retry carries concrete feedback, and a
 * second one mostly repeats it.
 *
 * ── "Stricter evidence" means NAMED CORRECTIONS, not fewer sections ───────────
 *
 * §17's wording is "regenerate with stricter evidence", and the obvious reading is to hand the
 * retry a smaller evidence set. That was implemented, and it is wrong — for the same reason
 * 20.9 must not validate against only the cited sections.
 *
 * Narrowing to the cited sections STARVES the retry. The previous reply typically got the
 * price right from a section it did not cite, and the section that invited the invention from
 * one it did. Remove the uncited ones and the correctly-sourced price becomes an unsupported
 * number in the next prompt, so the retry produces a vaguer reply, or an unsupported one, and
 * the comment is skipped after a second rejection that a NARROWER prompt caused. The evidence
 * has to stay whole.
 *
 * What actually makes the retry stricter is being told precisely what it got wrong: "do not
 * state the number 400". A retry told only to be more careful produces a differently-worded
 * wrong answer, which fails validation again and burns the remaining attempts for nothing.
 * The grounding rules already forbid inventing anything, so the correction does not need
 * second permission to do what the rules already require — it just names the specific failure.
 *
 * ── A repeat of the same reply ends it early ─────────────────────────────────
 *
 * If an attempt returns the same reply as the one before it, retrying again cannot help — the
 * model is producing the same text, and the same text fails the same way. It stops there rather
 * than spending the remaining attempts to reach the same verdict.
 *
 * ── Cost, and what the caller must account for ──────────────────────────────
 *
 * Every attempt is a fresh generation call plus up to two validation calls. `attempts` is
 * returned so the queue can charge rate limits PER ATTEMPT rather than per comment; budgeting
 * one call per comment would let a batch of hallucinating comments spend several times the
 * configured cap without any of it being visible. Nothing here schedules or posts anything —
 * that is 20.16's existing queue, reused rather than duplicated.
 *
 * PURE apart from the injected completion function.
 */

import { generateGroundedReply, GENERATION_STATUS } from './evidence-aware-output.js';
import { validateGrounding, GROUNDING_STATUS, GROUNDING_LAYER } from './grounding-validator.js';
import { KNOWLEDGE_ERROR } from './knowledge-schema.js';
import { normalizeArabic } from './matchers/arabic-normalizer.js';

/** Why the loop stopped. */
export const REPLY_STATUS = Object.freeze({
  /** A reply passed grounding validation and may be published. */
  PUBLISHABLE: 'PUBLISHABLE',
  /** Every attempt was rejected on grounding. §17's skip. */
  REJECTED: 'REJECTED',
  /** Stopped early because an attempt repeated the previous reply. */
  REPEATED: 'REPEATED',
  /** The attempt could not be made at all: generation or the validator failed. */
  FAILED: 'FAILED',
});

/** The ceiling. Not configurable, and see the header. */
export const HARD_MAX_ATTEMPTS = 3;

export const REGENERATION_DEFAULTS = Object.freeze({
  /** One generation plus one regeneration, which is §17's diagram. */
  maxAttempts: 2,
});

/**
 * Turn a grounding verdict into instruction lines for the retry.
 *
 * Prefers the validator's own words. A grounding rejection always carries a reason, and using
 * it means the retry is told the same thing the validator objected to rather than a
 * re-interpretation of it.
 *
 * @param {Object} verdict - a validateGrounding() result
 * @returns {string[]}
 */
export function buildCorrectionNotes(verdict) {
  const notes = [];

  for (const atom of (verdict && verdict.unsupported) || []) {
    notes.push(
      atom.kind === 'number'
        ? `the number ${atom.value} — the knowledge does not state it`
        : `any claim about ${atom.value}s — the knowledge does not mention them`
    );
  }
  for (const claim of (verdict && verdict.modelUnsupported) || []) {
    notes.push(String(claim));
  }

  // The reason last, and only if it says something the atoms did not. It is usually the most
  // informative line the validator produced.
  const reason = verdict && verdict.reason ? String(verdict.reason).trim() : '';
  if (reason && !notes.some((note) => reason.includes(note))) notes.push(reason);

  return notes.slice(0, 10);
}

/**
 * The evidence set a retry may draw on: unchanged, and always.
 *
 * Kept as a named function rather than deleted, because "the retry must be given the whole
 * approved set" is a decision someone will want to revisit, and a function makes it explicit
 * and testable instead of an absence. See the header for the narrowing experiment this
 * deliberately does not do.
 *
 * @param {Array<Object>} evidence
 * @returns {Array<Object>}
 */
export function evidenceForRetry(evidence) {
  return (Array.isArray(evidence) ? evidence : []).filter(Boolean);
}

/** Folded form, so two attempts differing only in spacing count as the same reply. */
function replyKey(reply) {
  return normalizeArabic(String(reply == null ? '' : reply).toLowerCase());
}

/**
 * Generate a grounded reply, regenerating once if grounding validation rejects it.
 *
 * NEVER REJECTS. Every path returns a verdict, and only `REPLY_STATUS.PUBLISHABLE` carries a
 * reply — a caller that publishes anything else has a bug, so `reply` is '' everywhere else
 * rather than holding a rejected string someone might post by accident.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Array<Object>} params.evidence - the gate's approved evidence
 * @param {Object} [params.settings]
 * @param {Function} [params.complete] - injected (messages, options) => {text}
 * @param {Object} [params.options]
 * @param {number} [params.options.maxAttempts] - lowered only; clamped to HARD_MAX_ATTEMPTS
 * @param {boolean} [params.options.useModelValidation=true] - layer 2 of 20.10
 * @returns {Promise<{status: string, reply: string, attempts: number, code: string,
 *   reason: string, evidence: Array<Object>, history: Array<Object>}>}
 */
export async function generateAndValidateGrounded({ commentText, evidence, settings, complete, options = {} } = {}) {
  const requested = Number(options && options.maxAttempts);
  const useModelValidation = !(options && options.useModelValidation === false);

  // Clamped in BOTH directions. A non-numeric or absent value falls back to the default, and
  // anything above the ceiling is cut rather than trusted.
  let maxAttempts = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : REGENERATION_DEFAULTS.maxAttempts;
  maxAttempts = Math.min(maxAttempts, HARD_MAX_ATTEMPTS);

  const approved = (Array.isArray(evidence) ? evidence : []).filter(Boolean);
  const history = [];
  const seen = new Set();

  let currentEvidence = approved;
  let corrections = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const generated = await generateGroundedReply({
      commentText,
      evidence: currentEvidence,
      settings,
      complete,
      corrections
    });

    if (generated.status !== GENERATION_STATUS.GENERATED) {
      // Not a grounding rejection, so §17 does not ask for a retry. Reported as-is.
      return {
        status: REPLY_STATUS.FAILED,
        reply: '',
        attempts: attempt,
        code: generated.code || KNOWLEDGE_ERROR.GENERATION_FAILED,
        reason: generated.reason,
        evidence: approved,
        history: history.concat([{
          attempt,
          outcome: GENERATION_STATUS.FAILED,
          code: generated.code || KNOWLEDGE_ERROR.GENERATION_FAILED,
          reason: generated.reason,
          layer: GROUNDING_LAYER.NONE
        }])
      };
    }

    const verdict = await validateGrounding({
      reply: generated.reply,
      evidence: currentEvidence,
      complete,
      options: { useModel: useModelValidation }
    });

    history.push({
      attempt,
      outcome: verdict.status,
      code: verdict.code,
      reason: verdict.reason,
      layer: verdict.layer,
      reply: generated.reply
    });

    if (verdict.status === GROUNDING_STATUS.SUPPORTED) {
      return {
        status: REPLY_STATUS.PUBLISHABLE,
        reply: generated.reply,
        attempts: attempt,
        code: '',
        reason: verdict.reason,
        evidence: currentEvidence,
        history
      };
    }

    // A validator that could not be reached is not a reason to regenerate: the reply may be
    // perfectly fine and the failure is ours, not the answer's. Retrying would spend a second
    // round of calls and, on an outage, land in the same place.
    if (verdict.code === KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED) {
      return {
        status: REPLY_STATUS.FAILED,
        reply: '',
        attempts: attempt,
        code: verdict.code,
        reason: verdict.reason,
        evidence: currentEvidence,
        history
      };
    }

    // Every attempt left is a regeneration, so prepare the next one NOW — and if there is no
    // next one, the loop simply ends and the comment is skipped.
    const key = replyKey(generated.reply);
    if (seen.has(key)) {
      // The model returned the same text twice. The same text fails the same way, so the
      // remaining attempts cannot help and would only cost calls.
      return {
        status: REPLY_STATUS.REPEATED,
        reply: '',
        attempts: attempt,
        code: verdict.code || KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED,
        reason: 'the model repeated the same rejected reply, so further attempts cannot help: ' + verdict.reason,
        evidence: currentEvidence,
        history
      };
    }
    seen.add(key);

    corrections = buildCorrectionNotes(verdict);
    currentEvidence = evidenceForRetry(approved);
  }

  // The loop ended without a supported reply: §17's skip. The code stays
  // GROUNDING_VALIDATION_FAILED, which is a SAFETY category and not §24's expected skip —
  // a hallucination that survived regeneration is something the user should see, not the
  // feature working correctly.
  const last = history[history.length - 1] || {};
  return {
    status: REPLY_STATUS.REJECTED,
    reply: '',
    attempts: maxAttempts,
    code: last.code || KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED,
    reason: last.reason || 'the reply was rejected by grounding validation on every attempt',
    evidence: approved,
    history
  };
}