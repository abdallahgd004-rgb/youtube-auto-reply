// Knowledge Diagnostics — the Knowledge base's structured events (Phase 20.19)
//
// WHY A SEPARATE MODULE, AND WHY IT LIVES HERE
//
// The ten knowledge modules (20.3–20.13) emit nothing at all. That was a deliberate
// choice while they were being built one at a time — they are pure, platform-agnostic
// and directly tested — but it left the one thing a user cannot reconstruct after the
// fact missing entirely: why a comment was answered from the base, or why it was not.
//
// The events are emitted from the service worker rather than from inside those ten
// modules because everything they need is ALREADY returned across their boundaries:
// `retrieval` carries counts and a reason, the gate carries its verdict and confidence,
// the validator carries the specific unsupported claims, and the regeneration loop keeps
// a per-attempt `history`. Reaching into the modules to log would mean changing ten
// return shapes to carry diagnostics nothing consumes — and a logging change that can
// alter a return value is a bug waiting to be written. One module owns the vocabulary,
// and one call site per stage reports through it.
//
// The alternative — each module importing debug.js — was rejected for a second reason:
// `src/core/dev-log.js` is installed by whichever context loads first, and a pure module
// that reads `globalThis.YTAR_DEVLOG` at evaluation time silently loses its engine if it
// is imported before dev-log.js runs (see the identical problem in processing-stats.js).
// Reading the global LAZILY inside `emit()` cannot fail that way.
//
// NEVER THROWS. A diagnostic must not be able to break the reply path, so every emit is
// wrapped: the worst outcome is a missing entry in a log the user opted into.

import './dev-log.js';

import { ERROR_CATEGORY, categorizeKnowledgeError } from './knowledge-schema.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────────

/**
 * The event names, in one frozen place.
 *
 * Not string literals at the call sites: §20.19's events are what 20.24's diagnostics UI
 * and any future support tooling will filter on, and a typo in one of a dozen scattered
 * literals produces an entry that simply never appears — no error, no visible symptom.
 */
export const KNOWLEDGE_EVENT = Object.freeze({
  RETRIEVAL: 'KNOWLEDGE_RETRIEVAL',
  ANSWERABILITY: 'KNOWLEDGE_ANSWERABILITY',
  EVIDENCE: 'KNOWLEDGE_EVIDENCE',
  GROUNDING: 'KNOWLEDGE_GROUNDING',
  SKIP: 'KNOWLEDGE_SKIP',
  CONFLICT: 'KNOWLEDGE_CONFLICT',
  REPLY_GENERATED: 'KNOWLEDGE_REPLY_GENERATED',
  DOCUMENTS_CHANGED: 'KNOWLEDGE_DOCUMENTS_CHANGED',
  RELOADED: 'KNOWLEDGE_RELOADED'
});

/**
 * Level per event.
 *
 * The split is about WHO NEEDS THE ENTRY, not how important it sounds:
 *
 *   INFO   the run-level outcome — a reply, or a skip and its §32 code. These must appear
 *          at the default verbosity, because "why was nothing answered" is the question a
 *          user opens diagnostics to ask.
 *   WARN   rare and actionable: a grounding rejection (the reply asserted something the
 *          base does not support) and a detected conflict. Both mean a human should look.
 *   DEBUG  the per-stage forensics — retrieval counts, the gate's confidence, which
 *          evidence was approved. Verbose only, and deliberately so: §20.21 is about cost,
 *          and a diagnostics buffer is the cheapest place to be frugal.
 */
export const KNOWLEDGE_DIAG_LEVEL = Object.freeze({
  RETRIEVAL: 'debug',
  ANSWERABILITY: 'debug',
  EVIDENCE: 'debug',
  GROUNDING_ACCEPTED: 'debug',
  GROUNDING_REJECTED: 'warn',
  SKIP: 'info',
  CONFLICT: 'warn',
  REPLY_GENERATED: 'info',
  DOCUMENTS_CHANGED: 'info',
  RELOADED: 'info'
});

// ─── Caps ───────────────────────────────────────────────────────────────────────

/**
 * The buffer holds 500 entries and nothing is persisted, so an event that carries 40
 * evidence ids can evict the surrounding context of everything after it. The counts stay
 * exact; only the lists are truncated, and the truncation is recorded rather than silent.
 */
const MAX_IDS = 8;
const MAX_SOURCES = 6;
const MAX_ATTEMPTS_LOGGED = 3;

/**
 * Conflict events are per-pair, so a base with many disagreements could emit hundreds.
 * 20.12's own audit caps its report; this caps the LOG separately because the two are
 * different consumers with different budgets.
 */
const MAX_CONFLICT_EVENTS = 20;

// ─── Emit ───────────────────────────────────────────────────────────────────────

/**
 * Read the engine lazily and write one entry.
 *
 * `null` when the engine is absent (the classic content scripts load dev-log.js as a
 * script, and a caller may run before it has executed). Returning false rather than
 * throwing is deliberate: every caller is on the reply path.
 *
 * @returns {boolean} whether an entry was written
 */
function emit(event, level, fields) {
  try {
    const devlog = typeof globalThis !== 'undefined' ? globalThis.YTAR_DEVLOG : null;
    if (!devlog || typeof devlog.log !== 'function') return false;

    devlog.log({
      component: devlog.COMPONENT && devlog.COMPONENT.BACKGROUND,
      event,
      level: devlog.LEVEL && devlog.LEVEL[level.toUpperCase()],
      // The base-wide conflict audit has a run but no comment, so these are defaulted
      // rather than required: an entry with an empty commentId is still correlatable by
      // runId, which is what an index-level event has.
      runId: fields.runId || '',
      commentId: fields.commentId || '',
      data: fields.data || {}
    });
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Payload helpers ────────────────────────────────────────────────────────────

/** The first `max` entries, plus how many were dropped. Never silently truncated. */
function capList(items, max) {
  const list = Array.isArray(items) ? items : [];
  const head = list.slice(0, max);
  return {
    list: head,
    dropped: list.length > max ? list.length - max : 0
  };
}

const str = (value, fallback) => (typeof value === 'string' ? value : (fallback || ''));
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Whether a §32 code means "the base correctly declined", straight from its owner. */
function expectedFlag(code) {
  return categorizeKnowledgeError(code) === ERROR_CATEGORY.EXPECTED_SKIP;
}

// ─── Emitters ───────────────────────────────────────────────────────────────────

/**
 * §20.19 Retrieval — what came back, and what was offered and rejected to get there.
 *
 * `consideredCount`/`offeredCount`/`resultCount` are the numbers that answer "why did it
 * pick that file": a large drop between them is a shortlist problem, not a base problem.
 */
export function emitRetrieval(options) {
  // A default parameter does NOT cover `null`, only `undefined` — and `null` is what a bad
  // caller actually passes. Normalising here is what makes "never throws" true rather
  // than merely intended.
  const { runId = '', commentId = '', retrieval } = options || {};
  const r = retrieval || {};
  const results = Array.isArray(r.results) ? r.results : [];
  const ids = capList(results.map((item) => str(item && item.evidenceId)), MAX_IDS);

  return emit(KNOWLEDGE_EVENT.RETRIEVAL, KNOWLEDGE_DIAG_LEVEL.RETRIEVAL, {
    runId,
    commentId,
    data: {
      status: str(r.status),
      state: str(r.state),
      consideredCount: num(r.consideredCount),
      offeredCount: num(r.offeredCount),
      resultCount: results.length,
      resultIds: ids.list,
      idsDropped: ids.dropped,
      code: str(r.code),
      reason: str(r.reason)
    }
  });
}

/**
 * §20.19 Answerability — the sufficiency verdict.
 *
 * `confidence` is recorded and never gated on (20.7's decision): a model's own confidence
 * is uncalibrated, and here it is being logged for a human to judge, not used as a
 * threshold. `evidenceCount` is 0 on every non-CAN_ANSWER outcome, which is itself the
 * useful signal — an approval with zero evidence should never happen, and if it ever
 * does, the count makes it obvious.
 */
export function emitAnswerability(options) {
  const { runId = '', commentId = '', gate } = options || {};
  const g = gate || {};
  return emit(KNOWLEDGE_EVENT.ANSWERABILITY, KNOWLEDGE_DIAG_LEVEL.ANSWERABILITY, {
    runId,
    commentId,
    data: {
      status: str(g.status),
      confidence: typeof g.confidence === 'number' ? g.confidence : null,
      evidenceCount: Array.isArray(g.evidence) ? g.evidence.length : 0,
      code: str(g.code),
      reason: str(g.reason)
    }
  });
}

/**
 * §20.19 Evidence — WHICH knowledge answered, named as file and heading.
 *
 * This is the event that makes the feature explainable to a human: the ids alone are
 * opaque, so the sources are resolved back to `filename` + heading path. Resolution goes
 * through the retrieval results rather than the index, because that is the only pair of
 * structures that agree on the ids — re-reading the index here could report a heading the
 * run did not actually use.
 *
 * NO CONTENT. The section bodies are the user's knowledge and are already reachable from
 * the index; copying them into a 500-entry ring buffer on every comment buys nothing and
 * widens where a reply's supporting material can be found later.
 */
export function emitEvidence(options) {
  const { runId = '', commentId = '', evidence, results } = options || {};
  const ids = Array.isArray(evidence) ? evidence : [];
  const byId = new Map();
  for (const item of Array.isArray(results) ? results : []) {
    if (item && item.evidenceId) byId.set(item.evidenceId, item);
  }

  const capped = capList(ids, MAX_IDS);
  const sources = capped.list.map((id) => {
    const match = byId.get(id) || {};
    return {
      evidenceId: id,
      documentId: str(match.documentId),
      filename: str(match.filename),
      headingPath: Array.isArray(match.headingPath) ? match.headingPath.join(' > ') : ''
    };
  });

  return emit(KNOWLEDGE_EVENT.EVIDENCE, KNOWLEDGE_DIAG_LEVEL.EVIDENCE, {
    runId,
    commentId,
    data: {
      evidenceCount: ids.length,
      evidenceIds: capped.list,
      idsDropped: capped.dropped,
      sources
    }
  });
}

/**
 * §20.19 Grounding validation — every attempt, and what the reply claimed.
 *
 * The attempt history is capped at three because §17's hard ceiling is three: logging
 * more is impossible, so a longer list would be dead weight rather than a real cap.
 *
 * The rejected REPLY TEXT goes out as `preview`, not as a field of its own. dev-log
 * gates `preview` behind VERBOSE, so a rejected reply is diagnosable on demand without
 * every grounded reply's text sitting in an in-memory buffer at the default verbosity.
 * A published reply's text is already recorded by the activity log, so it is not
 * duplicated here at all.
 */
export function emitGrounding(options) {
  const { runId = '', commentId = '', generated } = options || {};
  const g = generated || {};
  const status = str(g.status);
  const rejected = status !== 'PUBLISHABLE';

  const history = Array.isArray(g.history) ? g.history : [];
  const capped = capList(history, MAX_ATTEMPTS_LOGGED);

  return emit(
    KNOWLEDGE_EVENT.GROUNDING,
    rejected ? KNOWLEDGE_DIAG_LEVEL.GROUNDING_REJECTED : KNOWLEDGE_DIAG_LEVEL.GROUNDING_ACCEPTED,
    {
      runId,
      commentId,
      data: {
        status,
        attempts: num(g.attempts),
        code: str(g.code),
        reason: str(g.reason),
        attemptCount: history.length,
        attemptsDropped: capped.dropped,
        history: capped.list.map((entry) => ({
          attempt: num(entry && entry.attempt),
          outcome: str(entry && entry.outcome),
          layer: str(entry && entry.layer),
          code: str(entry && entry.code)
        })),
        // Only the rejected text: this is what a user needs to see to judge whether the
        // validator was right, and it is what cannot be recovered from anywhere else.
        preview: rejected ? str(g.preview || (history[history.length - 1] || {}).reply, '') : ''
      }
    }
  );
}

/**
 * §20.19 Skips — the §32 code, its category, and whether the base declined correctly.
 *
 * `expected` and `category` come from §32's owner rather than being derived here. That
 * matters for more than tidiness: the Side Panel's tint and its failure counter are both
 * driven by the same classification, and a second comparison in a logging module would be
 * a third place for the two to disagree.
 */
export function emitSkip(options) {
  const {
    runId = '',
    commentId = '',
    code,
    intent,
    retrievalState,
  evidenceCount,
    attempts,
    reason
  } = options || {};
  const resolved = str(code);
  return emit(KNOWLEDGE_EVENT.SKIP, KNOWLEDGE_DIAG_LEVEL.SKIP, {
    runId,
    commentId,
    data: {
      code: resolved,
      category: categorizeKnowledgeError(resolved),
      expected: expectedFlag(resolved),
      intent: str(intent),
      retrievalState: str(retrievalState),
      evidenceCount: num(evidenceCount),
      attempts: num(attempts),
      reason: str(reason)
    }
  });
}

/**
 * §20.19 Conflicts — 20.12's base-wide audit, made observable.
 *
 * `auditKnowledgeConflicts()` was written in 20.12, described in AGENTS.md as the base-wide
 * counterpart to the gate's per-comment decision, and called by NOTHING until now — so the
 * audit has never actually run in the extension. Blocking conflicts are what a user must
 * resolve by hand, and this is the only place that surfaces one proactively; the gate's
 * own verdict only explains a comment that happened to ask.
 *
 * Blocking and shadowed are separate arrays in 20.12 and stay separate here. Merging them
 * would file a shadowed file as something to fix, and a user who "fixed" a correct
 * precedence decision would be chasing a problem the extension invented.
 *
 * @returns {number} how many events were written
 */
export function emitConflicts(options) {
  const { runId = '', audit } = options || {};
  const a = audit || {};
  const blocking = Array.isArray(a.conflicts) ? a.conflicts : [];
  const shadowed = Array.isArray(a.shadowed) ? a.shadowed : [];
  const total = blocking.length + shadowed.length;

  let written = 0;
  let emitted = 0;

  /**
   * The two severities carry DIFFERENT shapes and this must not paper over that:
   * a blocking entry describes a PAIR (`documents` + `resolutions`), while a shadowed one
   * describes a single loser against a named `winner`. Reading `documentId` off a
   * blocking entry yields an empty string and logs a conflict with no filenames in it —
   * which is the one event a user most needs to be complete, because it is the one that
   * sends them to their Markdown.
   */
  const push = (entry, fallbackSeverity) => {
    if (emitted >= MAX_CONFLICT_EVENTS) return;
    emitted++;
    const e = entry || {};

    const isBlocking = Array.isArray(e.documents) && e.documents.length > 0;
    const documents = isBlocking ? e.documents : [];

    const payload = {
      severity: str(e.severity, fallbackSeverity),
      heading: str(e.heading),
      reason: str(e.reason),
      documentCount: num(a.documentCount),
      hasBlockingConflicts: a.hasBlockingConflicts === true,
      truncated: emitted === MAX_CONFLICT_EVENTS && total > emitted
    };

    if (isBlocking) {
      // The precedence fields are the whole explanation for WHY neither document wins,
      // so they are logged rather than left to the user to reconstruct.
      payload.documents = capList(
        documents.map((document) => ({
          id: str(document && document.id),
          filename: str(document && document.filename),
          priority: num(document && document.priority),
          version: num(document && document.version),
          updatedAt: num(document && document.updatedAt),
          enabled: document ? document.enabled !== false : false
        })),
        MAX_SOURCES
      ).list;
      // 20.12 builds these as RESOLUTIONS, and they say what does not decide a conflict
      // as well as what does — which is the advice people get wrong.
      payload.resolutions = Array.isArray(e.resolutions) ? e.resolutions.slice(0, 6) : [];
    } else {
      payload.documentId = str(e.documentId);
      payload.filename = str(e.filename);
      payload.winner = str(e.winner);
    }

    if (
      emit(KNOWLEDGE_EVENT.CONFLICT, KNOWLEDGE_DIAG_LEVEL.CONFLICT, { runId, data: payload })
    ) {
      written++;
    }
  };

  for (const entry of blocking) push(entry, 'blocking');
  for (const entry of shadowed) push(entry, 'shadowed');

  return written;
}

/**
 * Phase 20.20 — a knowledge file changed in storage, so the base is no longer what the
 * worker last indexed.
 *
 * WHY THIS EXISTS WHEN THE FINGERPRINT ALREADY HANDLES IT. §20's automatic path works
 * without any listener: `getKnowledgeIndex()` recomputes the fingerprint from storage on
 * every read and rebuilds when it differs, so new knowledge becomes available on its own.
 * That is the safety property and it is untouched. What was missing is the *notice* — a
 * user who edits a file gets no indication anything happened, and the first thing that
 * reveals it is a comment that took noticeably longer than usual.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, because both would be mistakes:
 *
 *  - It does not clear the in-memory cache. `getKnowledgeIndex()` compares the cached
 *    fingerprint against one recomputed from storage on every call, so a stale index
 *    cannot be served. Clearing here would imply the fingerprint check is insufficient, and
 *    a future reader who "optimised away" the comparison on the strength of a listener
 *    would reopen the stale-knowledge hole 20.4 exists to close.
 *  - It does not rebuild eagerly. Pasting a file fires many change events, and rebuilding
 *    per event would do a large amount of work that no reply may ever need. The rebuild is
 *    lazy and unavoidable; the notice is what the listener is for.
 *
 * INFO rather than DEBUG: it is the answer to "why did my edit seem to do nothing?".
 */
export function emitDocumentsChanged(options_) {
  const o = options_ || {};
  const list = Array.isArray(o.changes) ? o.changes : [];
  const added = o.newValue || oldValue || [];

  return emit(KNOWLEDGE_EVENT.DOCUMENTS_CHANGED, KNOWLEDGE_DIAG_LEVEL.DOCUMENTS_CHANGED, {
    runId: o.runId || '',
    data: {
      // The filenames are what makes the entry actionable; a bare "documents changed"
      // would not tell a user which file they just edited.
      changedFiles: capList(
        list.map((change) => str(change && change.filename) || str(change && change.id)).filter(Boolean),
        MAX_SOURCES
      ).list,
      changedCount: list.length,
      documentCount: Array.isArray(added) ? added.length : 0,
      // The exact reason the store reports for the write: added, updated, removed or
      // enabled-toggled. Surfaced rather than inferred so a rename is not described as an
      // edit.
      operation: str(o.operation)
    }
  });
}

/**
 * Phase 20.20 — a manual re-index finished, successfully or not.
 *
 * INFO on both outcomes. A manual reload is a user action, so silence afterwards is the
 * wrong answer either way: the point of pressing the button is to find out what happened.
 */
export function emitReloaded(options_) {
  const o = options_ || {};
  const i = o.index || {};
  const st = o.status || {};

  return emit(KNOWLEDGE_EVENT.RELOADED, KNOWLEDGE_DIAG_LEVEL.RELOADED, {
    runId: o.runId || '',
    commentId: o.commentId || '',
    data: {
      ok: i.retrievable === true,
      state: str(i.state || st.state),
      documentCount: num(st.documentCount || i.documentCount),
      sectionCount: num(st.sectionCount),
      code: str(i.code),
      error: str(i.message || st.error),
      // 'manual' today. Named so the entry stays interpretable if an automatic trigger is
      // ever added alongside the button.
      trigger: str(o.triggeredBy, 'manual')
    }
  });
}

/**
 * §20.19 The run-level outcome, kept for parity with the pre-20.19 worker event.
 *
 * Replaces a hand-built entry in the service worker so that EVERY knowledge event has the
 * same component, level and correlation fields. Two shapes for one event is how a log
 * reader ends up filtering on the wrong one.
 */
export function emitReplyGenerated(options) {
  const { runId = '', commentId = '', result } = options || {};
  const r = result || {};
  return emit(KNOWLEDGE_EVENT.REPLY_GENERATED, KNOWLEDGE_DIAG_LEVEL.REPLY_GENERATED, {
    runId,
    commentId,
    data: {
      intent: str(r.intent),
      attempts: num(r.attempts),
      retrievalState: str(r.retrievalState),
      evidenceCount: num(r.evidenceCount),
      reason: str(r.reason)
    }
  });
}