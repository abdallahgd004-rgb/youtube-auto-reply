// Processing Status — live counters and the current processing stage
//
// Platform-agnostic by design: no `chrome.*`, no DOM, no network. The service worker
// is the only writer, and the Popup only ever reads a sanitized snapshot through
// `getProcessingState()`.
//
// SCOPE: observability only. Nothing here influences matching, queueing, generation,
// dry-run or posting — it counts events that already happened and names the step the
// pipeline is really in. If this module were deleted, replies would behave identically.
//
// STATE LIFETIME: in-memory only, exactly like the in-session reply deduplicator and
// the job queue. A service-worker restart therefore resets every counter to zero and
// the stage back to `idle`, which is what the Popup must show in that case.

import './dev-log.js';
import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip } from './knowledge-schema.js';

/**
 * The processing stages, in pipeline order.
 *
 * Frozen so a typo cannot invent a stage: anything outside this set is rejected by
 * recordStage() and leaves the current stage untouched.
 */
export const STAGE = Object.freeze({
  READING_COMMENTS: 'reading_comments',
  CHECKING_MATCHES: 'checking_matches',
  // LM Studio performs the matching now, so the stage that means "the model is
  // deciding" gets its own name. CHECKING_MATCHES is kept because it is still the
  // stage the content script reports and older snapshots/tests reference it.
  SEMANTIC_MATCHING: 'semantic_matching',
  // ── Phase 20.18: the Knowledge pipeline's own stages ────────────────────────
  // One stage per STEP, not one "thinking" stage for the whole path. Each of these
  // is a separate round trip to LM Studio, and a Knowledge reply costs up to six, so
  // a single label would leave a user staring at "Waiting for LM Studio" for ten
  // seconds with no way to tell a slow rerank from a slow generation — which is the
  // whole question the existing stage line exists to answer.
  KNOWLEDGE_INDEX: 'knowledge_index',
  KNOWLEDGE_INTENT: 'knowledge_intent',
  KNOWLEDGE_RETRIEVAL: 'knowledge_retrieval',
  KNOWLEDGE_ANSWERABILITY: 'knowledge_answerability',
  KNOWLEDGE_GENERATION: 'knowledge_generation',
  PREPARING_REPLY: 'preparing_reply',
  WAITING_FOR_LM: 'waiting_for_lm',
  OPENING_REPLY_BOX: 'opening_reply_box',
  INSERTING_REPLY: 'inserting_reply',
  HEARTING_COMMENT: 'hearting_comment',
  SUBMITTING_REPLY: 'submitting_reply',
  COMPLETED: 'completed',
  IDLE: 'idle',
  ERROR: 'error',
});

/**
 * Human-readable label for each stage, shared with the Popup so the wording lives in
 * exactly one place.
 */
export const STAGE_LABELS = Object.freeze({
  [STAGE.READING_COMMENTS]: 'Reading comments',
  [STAGE.CHECKING_MATCHES]: 'Checking for matches',
  [STAGE.SEMANTIC_MATCHING]: 'Semantic matching',
  [STAGE.KNOWLEDGE_INDEX]: 'Loading the knowledge base',
  [STAGE.KNOWLEDGE_INTENT]: 'Understanding the question',
  [STAGE.KNOWLEDGE_RETRIEVAL]: 'Searching the knowledge base',
  [STAGE.KNOWLEDGE_ANSWERABILITY]: 'Checking what the knowledge supports',
  [STAGE.KNOWLEDGE_GENERATION]: 'Writing the grounded reply',
  [STAGE.PREPARING_REPLY]: 'Preparing reply',
  [STAGE.WAITING_FOR_LM]: 'Waiting for LM Studio',
  [STAGE.OPENING_REPLY_BOX]: 'Opening reply box',
  [STAGE.INSERTING_REPLY]: 'Inserting reply',
  [STAGE.HEARTING_COMMENT]: 'Hearting comment',
  [STAGE.SUBMITTING_REPLY]: 'Submitting reply',
  [STAGE.COMPLETED]: 'Completed',
  [STAGE.IDLE]: 'Idle',
  [STAGE.ERROR]: 'Error',
});

/**
 * Human-readable label for every §32 knowledge code, for the Side Panel's skip-reason
 * breakdown.
 *
 * The wording carries the distinction AGENTS.md insists on: a reason phrased as a
 * failure sends the user into their Markdown files, and a reason phrased as "no answer"
 * hides a real fault. So "the knowledge does not support an answer" and "we could not read
 * the model's check" are separate lines that never read alike.
 *
 * Lives here rather than in the Popup for the same reason `STAGE_LABELS` does: the panel
 * must not own the vocabulary, or the worker and the UI drift into describing the same
 * event differently.
 */
export const SKIP_REASON_LABELS = Object.freeze({
  [KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER]: 'No answer the knowledge supports',
  [KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE]: 'Nothing relevant in the knowledge base',
  [KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE]: 'Knowledge base contradicts itself',
  [KNOWLEDGE_ERROR.INVALID_KNOWLEDGE_DOCUMENT]: 'A knowledge document could not be read',
  [KNOWLEDGE_ERROR.INTENT_PARSE_FAILED]: 'The model did not return a readable intent',
  [KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED]: 'The answerability check was unreadable',
  [KNOWLEDGE_ERROR.GENERATION_FAILED]: 'The model did not return a usable reply',
  [KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED]: 'The grounding check was unreadable',
  [KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED]: 'The reply claimed something unsupported',
  [KNOWLEDGE_ERROR.REPLY_VALIDATION_FAILED]: 'The reply failed the existing validator',
  [KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED]: 'The knowledge index is not usable',
});

/**
 * Total-time measurement.
 *
 * The run timer answers "how long did the whole run take?", which is NOT any single
 * stage's duration: it starts when the run's first comment is detected and stops only
 * when the last comment of that run reaches a terminal state — including the queue's
 * own delays and the content script's open/insert/submit steps.
 *
 * MONOTONIC CLOCK: elapsed time is measured with `performance.now()` where available
 * and falls back to `Date.now()` only if it is not. Wall-clock time is wrong for this
 * job because the machine can be suspended, the clock can be adjusted by NTP, and a
 * YouTube tab can be backgrounded for minutes — any of which can make two wall-clock
 * timestamps subtract to a negative or wildly inflated duration.
 */
const perf = (typeof performance !== 'undefined' && performance) || null;

/**
 * The diagnostic log, reached through the classic-script engine that core/debug.js
 * installs. This module is imported directly by the tests as well as by the worker,
 * so the engine is read defensively: if it is somehow absent, every diagnostic call
 * below becomes a no-op and the counters behave exactly as they did before.
 */
const DEVLOG = (typeof globalThis !== 'undefined' && globalThis.YTAR_DEVLOG) || null;

/** Emit a diagnostic entry, or do nothing if the engine was never installed. */
function diag(component, event, fields) {
  if (!DEVLOG) return null;
  return DEVLOG.log(Object.assign({ component, event }, fields || {}));
}

/** High-resolution elapsed-time source, monotonic where the platform provides one. */
function monotonicNow() {
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/**
 * Terminal stages that stay visible after the run that produced them.
 *
 * `idle` and `error` and `completed` are the three outcomes a user wants to read after
 * the work stops: "it finished", "it broke". Every other stage is mid-pipeline and is
 * cleared to `idle` as soon as the last active job ends.
 */
const TERMINAL_STAGES = Object.freeze([
  STAGE.COMPLETED,
  STAGE.ERROR,
]);

/**
 * The outcome a processing attempt ended with, reported by whichever context finished
 * it (the background for everything up to generation, the content script for posting).
 */
export const OUTCOME = Object.freeze({
  MATCHED_AND_GENERATED: 'generated',
  NO_MATCH: 'no_match',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/**
 * Live state. Mutated only through the exported functions below.
 *
 * `handoffs` holds the comment ids whose reply the background has produced and handed
 * to the content script to post. The background deliberately does NOT decrement
 * `active` for those: the posting steps (open box, insert, submit) happen in another
 * context, and pretending the job finished at generation time is exactly the "stage is
 * a guess" bug this module exists to avoid.
 */
const state = {
  commentsDetected: 0,
  matched: 0,
  repliesGenerated: 0,
  repliesSubmitted: 0,
  failedSkipped: 0,
  // ── Phase 20.18: the Knowledge base's own numbers ──────────────────────────
  //
  // `matched` counts TRIGGER matches, so it stays at zero in Knowledge Mode and a
  // grounded reply is invisible in the original five tallies. These three are what makes
  // a Knowledge run readable at all: how often the base was consulted and found
  // something, how often that something was judged sufficient to answer, and how often
  // the base correctly declined.
  knowledgeHits: 0,
  knowledgeAnswerable: 0,
  // Declines that are the feature working (ERROR_CATEGORY.EXPECTED_SKIP). Kept apart
  // from `failedSkipped` on purpose — see recordKnowledgeSkip().
  knowledgeSkipped: 0,
  // §32 code -> how many comments ended there. Keyed by code, not by prose, so the
  // Panel can render the vocabulary it owns and a code with no label can never
  // silently become an empty row.
  knowledgeSkipReasons: {},
  // Phase 22.1 — the LAST few declines, with the reason and the filenames that were
  // offered. `knowledgeSkipReasons` answers "how often", which is the question a run
  // summary is for; it does not answer "why did THIS one decline", and that is the
  // question a user actually opens the panel with. The model's own words are already
  // captured by `failure()` and were previously only reachable in the diagnostic log.
  //
  // Bounded, newest LAST (the panel reads the last one), and text-bounded per field: a
  // reason is model output and a filename is user-supplied, and neither belongs in a
  // counter object that is serialized on every one-second poll.
  knowledgeSkipSamples: [],
  stage: STAGE.IDLE,
  stageUpdatedAt: 0,
  active: 0,
  handoffs: new Set(),
  // Comment ids already counted for THIS run. A MutationObserver burst, or a page
  // reload, can report the same comment again; the "Comments detected" tally must
  // count unique comments, not delivery attempts.
  runCommentIds: new Set(),
  // Run timer. `runStartedAt` is a monotonic reading, `runElapsedMs` is the frozen
  // total once the run ends.
  runStartedAt: 0,
  runElapsedMs: 0,
  runTimerRunning: false,
  // Identifies the run in flight. Owned here because this module is what decides when
  // a run begins and ends.
  runId: '',
  // Last stage reported, so RUN_STAGE_CHANGE can be emitted only on an actual change
  // rather than once per poll.
  lastLoggedStage: '',
};

/** Whether a value is one of the known stages. */
function isStage(value) {
  return typeof value === 'string' && Object.values(STAGE).includes(value);
}

/** Reset everything. Used at module load and by tests between cases. */
export function resetProcessingStats() {
  state.commentsDetected = 0;
  state.matched = 0;
  state.repliesGenerated = 0;
  state.repliesSubmitted = 0;
  state.failedSkipped = 0;
  state.knowledgeHits = 0;
  state.knowledgeAnswerable = 0;
  state.knowledgeSkipped = 0;
  // A NEW object rather than a cleared one: the snapshot hands this map to the Panel,
  // and mutating the object a previous message already serialized is a cross-context
  // aliasing bug for no benefit.
  state.knowledgeSkipReasons = {};
  state.knowledgeSkipSamples = [];
  state.stage = STAGE.IDLE;
  state.stageUpdatedAt = 0;
  state.active = 0;
  state.handoffs = new Set();
  state.runCommentIds = new Set();
  state.runStartedAt = 0;
  state.runElapsedMs = 0;
  state.runTimerRunning = false;
  state.runId = '';
  state.lastLoggedStage = '';
}

/**
 * Current elapsed time of the run in milliseconds.
 *
 * While the run is live this is recomputed on every read, so the Popup's poll shows a
 * number that keeps climbing. Once the run ends the frozen total is returned instead,
 * which is what makes the final duration stay readable.
 *
 * @returns {number} non-negative milliseconds
 */
function currentElapsedMs() {
  if (!state.runTimerRunning) {
    return state.runElapsedMs > 0 ? state.runElapsedMs : 0;
  }
  const elapsed = monotonicNow() - state.runStartedAt;
  return elapsed > 0 ? elapsed : 0;
}

/**
 * Start a measurement if one is not already running.
 *
 * A run that has already finished and then sees a new comment starts a FRESH
 * measurement rather than continuing the old one, so consecutive runs never blend into
 * one another.
 */
function ensureRunStarted() {
  if (state.runTimerRunning) return;
  state.runStartedAt = monotonicNow();
  state.runElapsedMs = 0;
  state.runTimerRunning = true;
  // The id lives here, next to the measurement it names, so every entry emitted while
  // the run is in flight shares it without the caller having to thread it through.
  state.runId = DEVLOG && typeof DEVLOG.newRunId === 'function' ? DEVLOG.newRunId() : '';
  diag(DEVLOG && DEVLOG.COMPONENT.TIMER, 'RUN_START', {
    runId: state.runId,
    level: DEVLOG && DEVLOG.LEVEL.INFO,
    data: { detectedCount: state.commentsDetected }
  });
}

/**
 * Stop the measurement and freeze the total.
 *
 * Called only when the last active comment of the run has finished. Intermediate
 * finishes leave the timer alone, which is what keeps it running across the queue's
 * own delays between comments.
 */
function stopRunIfComplete() {
  if (!state.runTimerRunning) return;
  if (state.active > 0 || state.handoffs.size > 0) return;
  state.runElapsedMs = currentElapsedMs();
  state.runTimerRunning = false;
  // The counters at the moment the run closed. This is the entry that answers "how
  // long did the whole thing take, and what came of it?".
  diag(DEVLOG && DEVLOG.COMPONENT.TIMER, 'RUN_END', {
    runId: state.runId,
    level: DEVLOG && DEVLOG.LEVEL.INFO,
    durationMs: state.runElapsedMs,
    data: {
      elapsedMs: state.runElapsedMs,
      stage: state.stage,
      detectedCount: state.commentsDetected,
      matchedCount: state.matched,
      generatedCount: state.repliesGenerated,
      submittedCount: state.repliesSubmitted,
      failedCount: state.failedSkipped,
      skippedCount: state.failedSkipped
    }
  });
}

/**
 * Record that the background really received a comment from the content script.
 *
 * Counted here — after the payload passed validation and was enqueued — because the
 * definition is "comments received by the background worker", not "comment nodes the
 * page happened to see".
 *
 * DUPLICATES: when a `commentId` is supplied and this run already counted it, nothing
 * is incremented at all — not the tally and not `active`. Counting `active` for a
 * duplicate would leave the run permanently "busy" and the timer would never stop,
 * because only one finish is ever reported for it. Called without an id (older callers,
 * tests) the behaviour is unchanged: always counted.
 *
 * @param {string} [commentId] - used to keep the tally unique within the run
 * @returns {boolean} true if this comment was counted, false if it was a duplicate
 */
export function recordCommentDetected(commentId) {
  const hasId = typeof commentId === 'string' && commentId !== '';

  if (hasId) {
    if (state.runCommentIds.has(commentId)) {
      // The "10 comments became 20 detections" question is answerable from here: a
      // duplicate is reported rather than silently dropped.
      diag(DEVLOG && DEVLOG.COMPONENT.CONTENT, 'COMMENT_DETECTED_DUPLICATE', {
        level: DEVLOG && DEVLOG.LEVEL.DEBUG,
        commentId,
        runId: state.runId,
        data: { reason: 'already counted for this run', activeCount: state.active }
      });
      return false;
    }
    state.runCommentIds.add(commentId);
  }

  state.commentsDetected += 1;
  state.active += 1;

  if (hasId) {
    diag(DEVLOG && DEVLOG.COMPONENT.CONTENT, 'COMMENT_ACCEPTED', {
      level: DEVLOG && DEVLOG.LEVEL.DEBUG,
      commentId,
      data: { uniqueForRun: true, activeCount: state.active }
    });
  }

  // The timer starts HERE, at the first comment of the run, which is the beginning of
  // the run as the user experiences it: everything after this point is measured.
  ensureRunStarted();

  // A fresh comment clears the previous run's terminal stage: the machine is engaged
  // again, so "Completed" from the last comment is no longer the current truth.
  state.stage = STAGE.SEMANTIC_MATCHING;
  state.stageUpdatedAt = Date.now();
  return true;
}

/**
 * Set the current stage. Unknown values are ignored rather than stored, so a bad
 * reporter can never leave the Popup showing a stage the user cannot act on.
 *
 * @param {string} stage
 */
export function recordStage(stage) {
  if (!isStage(stage)) {
    return false;
  }
  state.stage = stage;
  state.stageUpdatedAt = Date.now();

  // Emitted only on a genuine change, so a stage that is re-reported by both contexts
  // does not produce a duplicate line per poll.
  if (stage !== state.lastLoggedStage) {
    const previous = state.lastLoggedStage;
    state.lastLoggedStage = stage;
    diag(DEVLOG && DEVLOG.COMPONENT.TIMER, 'RUN_STAGE_CHANGE', {
      runId: state.runId,
      level: DEVLOG && DEVLOG.LEVEL.DEBUG,
      data: { stage, previousStage: previous || null, elapsedMs: currentElapsedMs() }
    });
  }
  return true;
}

/** A trigger actually matched this comment. */
export function recordMatched() {
  state.matched += 1;
}

/**
 * LM Studio produced a non-empty reply that passed validation.
 *
 * Only ever called after `validateReply()` has accepted real text, so this counts
 * answers, not attempts.
 */
export function recordGenerated() {
  state.repliesGenerated += 1;
}

/**
 * The content script's publish-success detection confirmed the reply went out.
 *
 * In dry-run the submit step is deliberately not performed, so nothing is reported
 * here — the attempt is counted as an intentional skip instead.
 */
export function recordSubmitted() {
  state.repliesSubmitted += 1;
}

/**
 * The attempt ended as a failure or an intentional skip (already handled, duplicate,
 * extension off, publish could not be completed, dry run).
 */
export function recordFailedOrSkipped() {
  state.failedSkipped += 1;
}

/**
 * Phase 20.18 — retrieval returned at least one usable section.
 *
 * "A hit" is deliberately NOT "the comment was answered": it means the knowledge base
 * was consulted and something plausibly related came back. Answering is the gate's
 * decision, counted separately, because the gap between the two is exactly the
 * information the user needs — a high hit count with a low answerable count means the
 * base does not cover their questions, which no other number on the panel reveals.
 */
export function recordKnowledgeHit() {
  state.knowledgeHits += 1;
}

/** Phase 20.18 — the sufficiency gate approved an answer, so a reply may be written. */
export function recordKnowledgeAnswerable() {
  state.knowledgeAnswerable += 1;
}

/**
 * Phase 20.18 — the Knowledge pipeline ended without a reply, and `code` says why.
 *
 * BUCKETING IS THE POINT, and it is 20.1's decision rather than a new one:
 * `categorizeKnowledgeError()` already split the eleven §32 codes, and only
 * EXPECTED_SKIP means "the base correctly declined". Those go to `knowledgeSkipped`
 * alone. Everything else — a failed model call, a contradiction, an unusable index —
 * ALSO increments `failedSkipped`, because those are faults the user can act on and
 * hiding them behind a neutral-looking skip count would be a lie.
 *
 * Before this existed a Knowledge skip incremented NOTHING at all, so a run answered
 * from the base read as "detected 20, matched 0, generated 8, failed 0" and the
 * remaining twelve comments had vanished without a trace.
 *
 * An UNRECOGNISED code is rejected and returns false, matching recordStage(): the Panel
 * has no label for it and cannot render a reason it does not know. A code outside the
 * closed vocabulary is a programming error, and silently inventing a row for it would
 * hide exactly that.
 *
 * @param {string} code - a KNOWLEDGE_ERROR value
 * @returns {boolean} true if the skip was recorded
 */
export function recordKnowledgeSkip(code) {
  if (typeof code !== 'string' || !SKIP_REASON_LABELS[code]) {
    return false;
  }

  if (isExpectedKnowledgeSkip(code)) {
    state.knowledgeSkipped += 1;
  } else {
    // Counted as BOTH: the reason breakdown explains the fault, and the existing
    // five-tally block keeps its long-standing meaning of "this attempt did not
    // produce a reply", which a user relying on Trigger Mode alone also reads.
    state.failedSkipped += 1;
  }

  state.knowledgeSkipReasons[code] = (state.knowledgeSkipReasons[code] || 0) + 1;
  return true;
}

/**
 * How many declines keep their detail for the Panel.
 *
 * Small on purpose. This is a "why did that one" answer, not an archive: a user reads the
 * most recent decline, fixes whatever it names, and moves on. A large buffer would be
 * serialized on every poll and would fill with entries about comments the user has already
 * dealt with.
 */
export const MAX_KNOWLEDGE_SKIP_SAMPLES = 5;

/** Longest reason text kept. Model output is unbounded. */
const MAX_SAMPLE_REASON_CHARS = 300;

/** Longest a filename may be before it is elided. */
const MAX_SAMPLE_FILENAME_CHARS = 80;

/** Most filenames kept — enough to show a conflict, few enough to stay readable. */
const MAX_SAMPLE_FILES = 6;

function sampleNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : -1;
}

/** Most shortlisted sections shown. Eight is enough to see a price that is not in them. */
const MAX_SAMPLE_SHORTLIST = 8;

/**
 * The sections offered to the reranker, reduced to what identifies them.
 *
 * The character count is the part that earns its place: a section over the gate's
 * 600-character ceiling explains a price the user can SEE in their file never reaching the
 * check, and that number is what says so.
 *
 * Junk entries are DROPPED rather than passed through, so the Panel never has to defend
 * against a shape this module can already guarantee.
 */
function sampleShortlist(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of list) {
    if (out.length >= MAX_SAMPLE_SHORTLIST) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const filename = typeof entry.filename === 'string' ? entry.filename.trim() : '';
    const heading = typeof entry.heading === 'string' ? entry.heading.trim() : '';
    if (!filename && !heading) continue;
    out.push({
      filename: sampleFilename(filename),
      heading: sampleText(heading),
      chars: sampleNumber(entry.chars)
    });
  }
  return out;
}

function sampleText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= MAX_SAMPLE_REASON_CHARS) return text;
  return text.slice(0, MAX_SAMPLE_REASON_CHARS) + '…';
}

function sampleFilename(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= MAX_SAMPLE_FILENAME_CHARS) return text;
  // The TAIL is what identifies a path, so the head goes rather than the end.
  return '…' + text.slice(-MAX_SAMPLE_FILENAME_CHARS);
}

/**
 * Keep the detail of one decline, so the Panel can say WHY rather than only how often.
 *
 * Every field is defensive. `reason` is model output, `commentText` is a viewer's comment,
 * and `filenames` comes from the user's own folder — none of it is trusted to be the right
 * shape, because a malformed sample must not be able to throw from inside the counter
 * update that records the skip in the first place.
 *
 * @param {Object} code - the KNOWLEDGE_ERROR that was recorded
 * @param {Object} [detail]
 * @param {string} [detail.reason] - the gate's own words, or the stage's
 * @param {string} [detail.commentText] - the comment, preview only
 * @param {Array<{filename?: string}|string>} [detail.filenames] - files that were offered
 * @returns {boolean} true when a sample was kept
 */
export function recordKnowledgeSkipSample(code, detail = {}) {
  if (typeof code !== 'string' || !SKIP_REASON_LABELS[code]) return false;
  if (!state.knowledgeSkipSamples) state.knowledgeSkipSamples = [];

  const files = Array.isArray(detail.filenames) ? detail.filenames : [];
  const filenames = [];
  for (const entry of files) {
    if (filenames.length >= MAX_SAMPLE_FILES) break;
    const name = typeof entry === 'string' ? entry : entry && entry.filename;
    const cleaned = sampleFilename(name);
    // De-duplicated: a comment asking about one book can match five sections of that
    // same file, and "a.md, a.md, a.md, a.md, a.md" reads as five documents.
    if (cleaned && !filenames.includes(cleaned)) filenames.push(cleaned);
  }

  state.knowledgeSkipSamples.push({
    code,
    label: SKIP_REASON_LABELS[code],
    reason: sampleText(detail.reason),
    commentPreview: sampleText(detail.commentText),
    filenames,
    // Phase 22.1 — the three counts that distinguish "the knowledge does not support an
    // answer" from "the answer was cut before the model saw it". Retrieval drops overflow
    // past its candidate limits and the gate drops any section over its character limit, so
    // a price written inside a long chapter never reaches the prompt and the gate's honest
    // verdict reads as a fact about the user's Markdown. -1 means "not reported", which the
    // Panel renders as nothing rather than as a zero.
    retrievedCount: sampleNumber(detail.retrievedCount),
    offeredCount: sampleNumber(detail.offeredCount),
    droppedCount: sampleNumber(detail.droppedCount),
    // Phase 22.1 — the sections actually offered to the reranker, before it discarded
    // them. Without this, an empty reranking is indistinguishable from an empty base.
    shortlist: sampleShortlist(detail.shortlist),
    // The closed intent vocabulary, e.g. `book_price`. It decides which extra terms the
    // local query gets, so a wrong classification here is a plausible cause of a weak
    // shortlist and the user is the one who can read what the model understood.
    intent: typeof detail.intent === 'string' ? detail.intent.slice(0, 40) : ''
  });

  while (state.knowledgeSkipSamples.length > MAX_KNOWLEDGE_SKIP_SAMPLES) {
    state.knowledgeSkipSamples.shift();
  }
  return true;
}

/**
 * Mark the job as still running, now owned by the content script for the posting
 * steps. `active` is intentionally NOT decremented here.
 *
 * @param {string} commentId
 */
export function handOffToContent(commentId) {
  if (typeof commentId === 'string' && commentId) {
    state.handoffs.add(commentId);
  }
}

/**
 * Mark the job finished, by whichever context owned the last step.
 *
 * When the last active job ends, the stage falls back to `idle` unless it is a
 * terminal one (`completed` / `error`), which is kept so the user can read why the run
 * stopped.
 *
 * @param {string} [commentId] — clears the matching handoff lease when given
 */
export function finishProcessing(commentId) {
  if (typeof commentId === 'string' && commentId) {
    state.handoffs.delete(commentId);
  }
  state.active = Math.max(0, state.active - 1);

  // The run is over only once nothing is active AND nothing is waiting in the content
  // script. An intermediate finish (one comment done, the next still queued) leaves
  // the timer running, so the total spans the whole run rather than one comment.
  stopRunIfComplete();

  if (state.active === 0 && !TERMINAL_STAGES.includes(state.stage)) {
    recordStage(STAGE.IDLE);
  }
}

/**
 * True while at least one comment is still being processed by either context.
 */
export function hasActiveProcessing() {
  return state.active > 0;
}

/**
 * True while a reply is in the content script's posting steps.
 */
export function hasHandoff() {
  return state.handoffs.size > 0;
}

/**
 * A sanitized snapshot for the Popup.
 *
 * Every field is a primitive, so the result is safe to send over
 * `chrome.runtime.sendMessage` and safe to render. Numbers are coerced to
 * non-negative integers and the stage is validated, so a corrupted value degrades to
 * "0" / "Idle" instead of `NaN` or `undefined` on screen.
 *
* `elapsedMs` is the live run duration while a run is in progress and the frozen total
 * after it finishes; `timerRunning` says which of the two the Popup is looking at.
 *
 * `knowledgeSkipReasons` is rebuilt key-by-key rather than passed through. The Panel
 * renders it as text, and a key that arrived from anywhere other than the eleven-code
 * vocabulary would either render as an empty row or, if the Panel ever interpolated it,
 * become an injection point. Rebuilding here means the closed vocabulary is the only
 * thing that can leave this module — and every entry's shape is decided here rather
 * than being whatever the caller happened to store.
 *
 * @returns {{commentsDetected:number, matched:number, repliesGenerated:number,
 *   repliesSubmitted:number, failedSkipped:number, stage:string, stageLabel:string,
 *   active:boolean, elapsedMs:number, timerRunning:boolean, knowledgeHits:number,
 *   knowledgeAnswerable:number, knowledgeSkipped:number,
 *   knowledgeSkipReasons:Object<string,{count:number,label:string,expected:boolean}>}}
 */
export function getProcessingState() {
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;

  const stage = isStage(state.stage) ? state.stage : STAGE.IDLE;
  const elapsed = currentElapsedMs();

  const skipReasons = {};
  for (const code of Object.keys(SKIP_REASON_LABELS)) {
    const n = count(state.knowledgeSkipReasons[code]);
    if (n > 0) {
      // One entry carries all three facts about a reason: how many, what it is called,
      // and whether it is a fault. The Panel needs the label (it is a classic script and
      // cannot import this module) and it needs the flag (only the owner may decide what
      // "the base correctly declined" means — a second comparison in the Panel would be a
      // second answer to §24 drifting from this one). Shipping one structure instead of
      // three parallel maps keeps them from being read out of step.
      skipReasons[code] = {
        count: n,
        label: SKIP_REASON_LABELS[code],
        expected: isExpectedKnowledgeSkip(code)
      };
    }
  }

  return {
    commentsDetected: count(state.commentsDetected),
    matched: count(state.matched),
    repliesGenerated: count(state.repliesGenerated),
    repliesSubmitted: count(state.repliesSubmitted),
    failedSkipped: count(state.failedSkipped),
    // Phase 20.18. A Knowledge reply also moves `repliesGenerated`, so these are extra
    // detail on the same run rather than a separate tally of it — the two must be read
    // together, never summed.
    knowledgeHits: count(state.knowledgeHits),
    knowledgeAnswerable: count(state.knowledgeAnswerable),
    knowledgeSkipped: count(state.knowledgeSkipped),
    knowledgeSkipReasons: skipReasons,
    // The detail behind the LAST decline. Serialized whole rather than per code: the
    // Panel shows the most recent one, which is the one the user is looking at.
    knowledgeSkipSamples: Array.isArray(state.knowledgeSkipSamples)
      ? state.knowledgeSkipSamples.slice()
      : [],
    stage,
    stageLabel: STAGE_LABELS[stage],
    active: state.active > 0,
    // Rounded to whole milliseconds: the Popup formats to one decimal place anyway, and
    // a raw float would serialise as a long noisy number in the message payload.
    elapsedMs: Math.round(elapsed),
    timerRunning: state.runTimerRunning,
  };
}