/**
 * Hybrid Mode — Phase 20.15
 *
 * §26's order, made explicit: trigger first, and the knowledge pipeline only as a fallback when
 * no trigger matched.
 *
 *   1. Process explicit trigger matches first.
 *   2. If no trigger matches, use Knowledge Mode.
 *   3. If Knowledge Mode cannot support an answer, skip.
 *   4. Do not allow Knowledge Mode to override an explicit fixed reply.
 *   5. Existing fixed-reply behavior remains exact.
 *   6. Existing AI-trigger behavior remains subject to current validation rules.
 *
 * ── Rules 4 and 5 are satisfied by NOT BEING ABLE TO VIOLATE THEM ────────────
 *
 * A matched trigger short-circuits: when `matchTrigger` reports a match, `runKnowledge` is
 * never called. There is no "unless the knowledge reply is better" branch and no priority
 * comparison to get wrong, because the knowledge pipeline has no opportunity to produce a reply
 * at all. That is the reason this is a router rather than a scoring function — a design where
 * the two paths competed would have needed a rule for which wins, and the one that eventually
 * loses is a fixed reply the user wrote out by hand.
 *
 * Rule 5 needs nothing here for the same reason: this module never inspects or reconstructs a
 * reply. It decides which path runs and returns what that path returned.
 *
 * ── Rule 6, and the precedence between multiple matching triggers ─────────────
 *
 * The existing trigger implementation owns matching, fixed replies and the order between
 * multiple matches, and this module is given its VERDICT. It does not reimplement any of it,
 * so §26's "remain compatible with the existing trigger implementation" holds by construction
 * rather than by discipline: there is nothing here that could disagree.
 *
 * ── A trigger FAILURE is not a trigger MISS ──────────────────────────────────
 *
 * `semanticMatchTriggers()` distinguishes `ok:true, matched:false` (a genuine NO_MATCH, which
 * may fall through to knowledge) from `ok:false` (the classifier could not be read). Only the
 * former falls through.
 *
 * This matters because of what the alternative does on a transient outage: treating a failed
 * classification as "no trigger matched" would send every comment to the knowledge base, so an
 * unreachable LM Studio would silently switch the extension's whole behaviour. The verdict is
 * reported as failed instead, which is the loud, recoverable direction.
 *
 * PURE: both paths are injected, so this orchestrates without knowing anything about matching,
 * prompts or models. Phase 20.16 supplies the real implementations.
 */

import { describeReplyMode, REPLY_MODE } from './reply-modes.js';

/** Which path produced the outcome. */
export const ROUTE_SOURCE = Object.freeze({
  /** The existing trigger flow ran and produced a reply. */
  TRIGGER: 'trigger',
  /** The knowledge pipeline ran and produced a reply. */
  KNOWLEDGE: 'knowledge',
  /** Nothing produced a reply. */
  SKIPPED: 'skipped',
});

/**
 * Why the router stopped where it did.
 *
 * Separate from `ROUTE_SOURCE` because the same source can be reached for very different
 * reasons, and §31's diagnostics need those reasons apart: "no trigger matched" is normal,
 * "the classifier failed" is a failure, and "the knowledge cannot answer this" is the phase
 * working.
 */
export const ROUTE_REASON = Object.freeze({
  /** The trigger matched and that is the end of it. */
  TRIGGER_MATCHED: 'TRIGGER_MATCHED',
  /** Trigger Mode: no trigger matched, and the knowledge pipeline does not run in this mode. */
  NO_TRIGGER_MATCH: 'NO_TRIGGER_MATCH',
  /** Hybrid: no trigger matched, so the knowledge pipeline was tried. */
  KNOWLEDGE_FALLBACK: 'KNOWLEDGE_FALLBACK',
  /** The knowledge pipeline ran and produced nothing. §26 rule 3. */
  KNOWLEDGE_NO_ANSWER: 'KNOWLEDGE_NO_ANSWER',
  /**
   * The knowledge path threw.
   *
   * The pipeline is written to be total, so this should not happen — but the router promises
   * never to reject, and that promise has to hold for an injected implementation it does not
   * control. A throw becomes a SKIP and never a reply.
   */
  KNOWLEDGE_FAILED: 'KNOWLEDGE_FAILED',
  /** The classifier could not be read, so nothing was decided. */
  TRIGGER_FAILED: 'TRIGGER_FAILED',
  /** Trigger Mode with no trigger configured, so matching was skipped entirely. */
  NO_TRIGGERS_CONFIGURED: 'NO_TRIGGERS_CONFIGURED',
  /** A caller omitted a path this mode needs. */
  MISCONFIGURED: 'MISCONFIGURED',
});

/**
 * Reduce whatever the trigger implementation returned to the three things this router needs.
 *
 * Deliberately tolerant about the shape, because the service worker's verdict carries a lot
 * this module has no business reading — and deliberately strict about the one distinction that
 * matters, `ok` versus `matched`.
 *
 * @param {*} verdict
 * @returns {{ok: boolean, matched: boolean, reason: string, verdict: *}}
 */
function readTriggerVerdict(verdict) {
  if (verdict === undefined || verdict === null) {
    return { ok: true, matched: false, reason: 'no verdict', verdict: null };
  }
  if (typeof verdict !== 'object') {
    return { ok: false, matched: false, reason: 'the trigger verdict was not an object', verdict };
  }

  const ok = verdict.ok !== false;
  const matched = ok && verdict.matched === true;
  return {
    ok,
    matched,
    reason: typeof verdict.reason === 'string' ? verdict.reason : (ok ? (matched ? 'match' : 'no_match') : 'failed'),
    verdict
  };
}

/**
 * Route one comment through the pipeline its mode calls for.
 *
 * NEVER REJECTS. Every path returns a result, because a throwing router would take down a
 * comment that could still have been skipped cleanly.
 *
 * @param {Object} params
 * @param {string} params.mode - a value from REPLY_MODE
 * @param {Function} [params.matchTrigger] - async () => a trigger verdict
 *        ({ok, matched, reason, ...}). NOT called in Knowledge Mode.
 * @param {Function} [params.runKnowledge] - async () => a knowledge outcome
 *        ({reply, status, code, reason}). NOT called when a trigger matched, and not called in
 *        Trigger Mode.
 * @param {string} [params.params.commentText] - forwarded for diagnostics only
 * @returns {Promise<{route: string, reason: string, reply: string, trigger: *, knowledge: *,
 *   knowledgeEntered: boolean}>}
 */
export async function routeComment({ mode, matchTrigger, runKnowledge, commentText = '' } = {}) {
  const described = describeReplyMode(mode);

  const outcome = (route, reason, extra = {}) => ({
    route,
    reason,
    reply: '',
    trigger: null,
    knowledge: null,
    knowledgeEntered: false,
    ...extra
  });

  if (!described.usesTriggers) {
    // Knowledge Mode. The trigger implementation is not consulted at all, so a fixed reply
    // cannot pre-empt it and no trigger is evaluated.
    if (typeof runKnowledge !== 'function') {
      return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.MISCONFIGURED);
    }
    const knowledge = await callKnowledge(runKnowledge, { commentText }, outcome);
    return describeKnowledge(knowledge, outcome, ROUTE_REASON.KNOWLEDGE_FALLBACK, true);
  }

  // Trigger Mode and Hybrid both evaluate the trigger first.
  if (typeof matchTrigger !== 'function') {
    // Hybrid still needs a verdict before it can decide whether to fall back, so a missing
    // matcher is a misconfiguration in either mode that uses triggers.
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.MISCONFIGURED);
  }

  let verdict;
  try {
    verdict = readTriggerVerdict(await matchTrigger({ commentText }));
  } catch (error) {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.TRIGGER_FAILED, {
      trigger: { ok: false, matched: false, reason: 'the trigger matcher threw' }
    });
  }

  // §26 rules 1, 4 and 5: a match is the end of it, and the knowledge pipeline is not entered.
  if (verdict.matched) {
    return outcome(ROUTE_SOURCE.TRIGGER, ROUTE_REASON.TRIGGER_MATCHED, {
      reply: String(verdict.verdict?.reply || ''),
      trigger: verdict.verdict
    });
  }

  // A failed classification is not a miss. See the header: falling through here would switch
  // the extension's behaviour wholesale on a transient outage.
  if (!verdict.ok) {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.TRIGGER_FAILED, {
      trigger: verdict.verdict || { ok: false, matched: false, reason: verdict.reason }
    });
  }

  // Trigger Mode stops here. §25: Trigger Mode is the existing system, unchanged.
  if (!described.usesKnowledge) {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.NO_TRIGGER_MATCH, { trigger: verdict.verdict });
  }

  // Hybrid: §26 rule 2. `knowledgeOnlyAfterNoMatch` is the ordering rule made explicit, so
  // reaching this line is the ONLY way the knowledge pipeline is entered in Hybrid.
  if (typeof runKnowledge !== 'function') {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.MISCONFIGURED, { trigger: verdict.verdict });
  }

  const knowledge = await callKnowledge(runKnowledge, { commentText, trigger: verdict.verdict }, outcome);
  return describeKnowledge(knowledge, outcome, ROUTE_REASON.KNOWLEDGE_FALLBACK, true, verdict.verdict);
}

/**
 * Call the knowledge path without letting it throw.
 *
 * Returns a sentinel the outcome describer recognises, so a throw becomes a reported skip
 * rather than an exception escaping a router that documents itself as total.
 */
async function callKnowledge(runKnowledge, args, outcome) {
  try {
    return await runKnowledge(args);
  } catch (error) {
    return {
      reply: '',
      status: '',
      code: '',
      reason: 'the knowledge path threw: ' + (error && error.message ? error.message : 'unknown error'),
      threw: true
    };
  }
}

/**
 * Turn a knowledge outcome into a route.
 *
 * §26 rule 3: if the knowledge pipeline cannot support an answer, SKIP. The pipeline's own
 * reason is carried through untouched — it distinguishes `NO_SUPPORTED_ANSWER` (the feature
 * working) from a model failure, and collapsing them here would discard exactly the
 * distinction §31 asks the UI to make.
 */
function describeKnowledge(knowledge, outcome, fallbackReason, knowledgeEntered, trigger = null) {
  if (knowledge === undefined || knowledge === null) {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.MISCONFIGURED, { knowledgeEntered, trigger });
  }

  if (knowledge.threw) {
    return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.KNOWLEDGE_FAILED, { knowledge, knowledgeEntered, trigger });
  }

  const reply = String(knowledge.reply || '');
  if (reply) {
    return outcome(ROUTE_SOURCE.KNOWLEDGE, fallbackReason, {
      reply,
      knowledge,
      knowledgeEntered,
      trigger
    });
  }

  return outcome(ROUTE_SOURCE.SKIPPED, ROUTE_REASON.KNOWLEDGE_NO_ANSWER, { knowledge, knowledgeEntered, trigger });
}

export { REPLY_MODE, ROUTE_SOURCE as ROUTE };
