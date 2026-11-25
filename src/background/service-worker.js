// Background Service Worker - YouTube Auto Reply Extension
// Phase 6.3: Matching logic with trigger rules
// Phase 9.x: Deduplication — handled-comments store + in-session reply deduplicator

import { getModels, chatCompletion } from './api-client.js';
import { getTriggers } from '../core/trigger-crud.js';
// LM Studio decides whether a comment matches a trigger. The local deterministic
// matchers (src/core/matchers/*) remain in the codebase and are still covered by
// test-runner.html, but they are deliberately not part of the runtime flow — see the
// matching block in processJob() for why.
import { semanticMatchTriggers, flattenTriggerPhrases } from '../core/semantic-matcher.js';
import { buildReplyPrompt } from '../core/prompt-builder.js';
// Phase 19.6 — Fixed Reply mode. LM Studio still decides WHETHER the comment matches
// (that is semantic-matcher.js, unchanged); this decides whether it is also asked to WRITE
// the reply. One call, one decision, so the rule lives in a single place.
import { REPLY_MODES, resolveReplySource } from '../core/fixed-reply.js';
// ── Phase 20.16 — the Knowledge pipeline, wired into THIS queue ─────────────────
//
// There is deliberately NO second queue, no second publishing path and no second validator.
// `runKnowledgePipeline()` below produces exactly the `{text, reasoning}` shape the existing
// block already produces, so validation, activity logging, counters, deduplication, the handoff
// to the content script, the hourly cap, the dry-run gate and publish verification are all
// shared verbatim with a trigger reply.
import { describeReplyMode, REPLY_MODE } from '../core/reply-modes.js';
import { shouldHeartAfterInsert } from '../core/target-reply-hearting.js';
import { routeComment, ROUTE_SOURCE, ROUTE_REASON } from '../core/reply-router.js';
import {
  getKnowledgeIndex,
  getKnowledgeIndexStatus
} from '../core/knowledge-index.js';
// Phase 20.19 — the knowledge diagnostic vocabulary. The pipeline reports through this
// one module rather than building entries inline, so every knowledge event has the same
// component, level and correlation fields.
import {
  emitRetrieval,
  emitDocumentsChanged,
  emitReloaded,
  emitAnswerability,
  emitEvidence,
  emitGrounding,
  emitSkip,
  emitConflicts,
  emitReplyGenerated
} from '../core/knowledge-diagnostics.js';
import { auditKnowledgeConflicts } from '../core/knowledge-conflicts.js';
import { KNOWLEDGE_ERROR } from '../core/knowledge-schema.js';
import {
  watchKnowledgeDocuments,
  getKnowledgeStats,
  getKnowledgeDocuments as readKnowledgeDocuments,
  addKnowledgeDocument,
  updateKnowledgeDocument,
  removeKnowledgeDocument,
  applyFolderSync
} from '../core/knowledge-store.js';
import {
  collectFolderFiles,
  readFolderEntry,
  planFolderSync,
  summarizePlan,
  planHasChanges
} from '../core/knowledge-folder-sync.js';
import {
  loadFolderHandle,
  saveFolderHandle,
  clearFolderHandle,
  queryFolderPermission,
  requestFolderPermission,
  FOLDER_PERMISSION
} from '../core/folder-handle-store.js';
import {
  collectFolderNames,
  clampToAllowedFolder,
  resolveUniquePath,
  buildOutlineMessages,
  parseOutline,
  buildSectionMessages,
  parseSection,
  sourceIsUsable,
  ensureHeading,
  findUnsupportedNumbers,
  findDuplicates,
  writeGeneratedFiles,
  SPLIT_STATUS,
  SPLIT_DEFAULTS
} from '../core/doc-splitter.js';
import { readActiveScope } from '../core/template-scope.js';
import { analyzeIntent } from '../core/intent-analyzer.js';
import { retrieveKnowledge } from '../core/knowledge-retrieval.js';
import { checkAnswerability, ANSWERABILITY } from '../core/answerability-gate.js';
import { generateAndValidateGrounded, REPLY_STATUS } from '../core/hallucination-rejection.js';
import { getSettings } from '../core/storage.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { isLimitReached, recordReply, countRecentReplies, DEFAULT_WINDOW_MS } from '../core/reply-rate-limiter.js';
import { isQueuePaused, setQueuePaused } from '../core/queue-control.js';
// Phase 19.4 — how many recent replies repeat detection compares against, and over
// what window. Both bounds keep the check cheap and keep it about the last few
// minutes rather than all of history.
const REPEAT_CHECK_LIMIT = 20;
const REPEAT_CHECK_WINDOW_MS = 60 * 60 * 1000;

// Phase 9.x — Deduplication imports
import { createFingerprint } from '../core/comment-fingerprint.js';
// Phase 19.8 — the id of the document that sent a comment, captured at message time.
// It is stable for the lifetime of one page load and is a NEW value after a reload, which
// is exactly the boundary "page session" means. See PAGE SESSIONS below.
import { resolvePageSessionId } from '../core/page-session.js';
import { isHandled, markHandled } from '../core/handled-comments.js';
import { createReplyDeduplicator } from '../core/reply-deduplicator.js';
import { validateReply } from '../core/reply-validator.js';

// Phase 22 — comments the creator has already answered, offered back as follow-ups.
// The decision module is pure; the store holds the notice board. Nothing in this import
// is reachable from the publish path, which is the feature's central safety property.
import {
  classifyAnsweredComment,
  buildFollowupMessages,
  parseFollowupResult,
  isNearDuplicateDraft
} from '../core/answered-followups.js';
import {
  recordAnsweredComment,
  listAnsweredComments,
  getAnsweredComment,
  setAnsweredDraft,
  dismissAnsweredComment,
  clearAnsweredComments
} from '../core/answered-followup-store.js';

// Phase 11 — Activity log (observability only; never affects the reply flow)
import { LOG_STATUS, saveLog, getLogs, clearLogs, getRecentGeneratedReplies } from '../core/activity-log.js';

// Processing status (observability only; never affects the reply flow).
// The background owns the counters up to generation and the new read-only action the
// Popup polls; the content script reports the posting stages it is the only context
// that can see.
import {
  STAGE,
  OUTCOME,
  getProcessingState,
  resetProcessingStats,
  recordCommentDetected,
  recordStage,
  recordMatched,
  recordGenerated,
  recordSubmitted,
  recordFailedOrSkipped,
  recordKnowledgeHit,
  recordKnowledgeAnswerable,
  recordKnowledgeSkip,
  recordKnowledgeSkipSample,
  handOffToContent,
  finishProcessing
} from '../core/processing-stats.js';

// Phase 10.2 — One-at-a-time job queue
import { createQueue } from '../core/queue.js';
// Phase 19.3 — persist waiting jobs so an idle service-worker kill does not lose them
import {
  addPendingJob,
  removePendingJob,
  loadPendingJobs,
} from '../core/queue-persistence.js';
import { debugLog, debugWarn, logError, loadDebugSetting } from '../core/debug.js';
// Development Diagnostic Log. Observability only: nothing in this import can change a
// reply, a queue, a prompt or a safety gate.
import {
  YTAR_DEVLOG,
  DEV_LOG_COMPONENT as C,
  DEV_LOG_LEVEL as L,
  newRunId,
  newRequestId
} from '../core/debug.js';

/**
 * The id of the processing run currently in flight.
 *
 * Every diagnostic entry emitted while processing a comment carries it, so a whole
 * run can be reconstructed from the log with one filter. Set when the run's first
 * comment is detected and cleared when the run's last comment reaches a terminal
 * state, which is exactly the window the timer measures.
 */
let currentRunId = '';

// Phase 20.19 — index fingerprints whose conflicts have already been reported, so the
// base-wide audit runs once per base rather than once per comment. A Set, not a counter:
// the fingerprint changes whenever the documents do, and the interesting case is a base
// that is edited and edited again, which a single boolean would suppress after the first.
const auditedFingerprints = new Set();

// ─── Phase 19.8: fingerprint for in-flight replies ─────────────────────────────
/**
 * commentId → { fingerprint, dryRun } for a reply that has been handed to the content
 * script and is not yet finished.
 *
 * WHY THIS EXISTS: `markHandled()` used to be called at generation time, before anything
 * was published. That made a comment permanently unprocessable as soon as a reply was
 * *prepared* — including a dry run, a failure to find the reply box, and a failed submit.
 * The correct moment is the content script reporting a real successful publish, which
 * arrives as REPORT_PROCESSING_STAGE with outcome SUBMITTED.
 *
 * WHY A MAP AND NOT A STORED LOOKUP: the fingerprint is derived from the page URL, which
 * the content script has no copy of at report time (it reports only a comment id). Carrying
 * it across the handoff is the smallest change that keeps the existing fingerprint scheme
 * — no new storage key, nothing persisted.
 *
 * In-memory on purpose: a worker restart clears it, and the correct response to a lost
 * entry is that the comment is processed again, which is the safe direction. Entries are
 * removed on every terminal outcome so the map cannot grow without bound.
 */
const handoffFingerprints = new Map();

/**
 * Mark a comment handled, but only when the publish was real.
 *
 * All three exclusions are load-bearing:
 *   - unknown comment id: the worker restarted mid-handoff, so nothing is known to mark.
 *   - dry run: nothing was posted. A dry run must leave the comment processable, or
 *     testing the extension silently disables it for that comment.
 *   - a missing fingerprint: malformed job; marking nothing is safer than marking wrong.
 *
 * @param {string} commentId
 * @returns {Promise<boolean>} true when a record was written
 */
async function markHandledIfPublished(commentId) {
  const entry = handoffFingerprints.get(commentId);
  // Consumed either way: this is the terminal report for that attempt.
  handoffFingerprints.delete(commentId);

  if (!entry) {
    debugLog(`MARKED_HANDLED skipped for id=${commentId}: no handoff record (worker may have restarted)`);
    return false;
  }
  if (entry.dryRun) {
    debugLog(`MARKED_HANDLED skipped for id=${commentId}: dry run, nothing was published`);
    return false;
  }
  if (!entry.fingerprint) {
    debugLog(`MARKED_HANDLED skipped for id=${commentId}: no fingerprint on the handoff record`);
    return false;
  }

  await markHandled(entry.fingerprint);
  YTAR_DEVLOG.log({
    component: C.BACKGROUND,
    event: 'MARKED_HANDLED',
    runId: currentRunId,
    commentId,
    data: { reason: 'reply published', fingerprint: entry.fingerprint }
  });
  return true;
}
// ─── Phase 18.3 — diagnostics ────────────────────────────────────────────────
// Read the user's diagnostics flag once, so every later debugLog()/debugWarn() call
// is correctly gated. Deliberately not awaited at the top level: the worker must
// finish registering its message listener immediately, and a first reply arriving
// before the read resolves would merely miss its own progress line.
loadDebugSetting().then((enabled) => {
  debugLog(`Background service worker initialized (diagnostics ${enabled ? 'on' : 'off'})`);
  // READY is emitted only after the diagnostics switch has been applied, so a first
  // entry can never be lost to a flag that had not loaded yet.
  workerBoot.done({
    diagnosticsOn: enabled === true,
    verbosity: YTAR_DEVLOG.getConfig().verbosity,
    listenersRegistered: true
  });
});

// ─── Development Diagnostic Log: worker lifecycle ───────────────────────────
/**
 * Records that this worker instance exists and that it has finished wiring itself up.
 *
 * A silent MV3 worker restart is the single most confusing failure mode to debug: the
 * queue appears to lose jobs and the timers look wrong, with nothing in the log. These
 * two events, timestamped, are what make a restart visible.
 */
const workerBoot = YTAR_DEVLOG.startTimer({
  component: C.BACKGROUND,
  event: 'SERVICE_WORKER',
  endEvent: 'SERVICE_WORKER_READY'
});
YTAR_DEVLOG.log({
  component: C.BACKGROUND,
  event: 'SERVICE_WORKER_START',
  data: {
    context: 'service_worker',
    // Read the engine's own state, NOT the `enabled` local: that binding only exists
    // inside loadDebugSetting().then() below. Referencing it here threw
    // "enabled is not defined" at module evaluation, which aborted this worker
    // before it registered any listener — the extension then loaded with no
    // background at all ("Service worker registration failed", status code 15).
    diagnosticsOn: YTAR_DEVLOG.isEnabled(),
    verbosity: YTAR_DEVLOG.getConfig().verbosity,
    extensionVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null
  }
});

const jobQueue = createQueue();

// In-session reply deduplicator (fast path).
// NOTE: This state is lost when the service worker is killed and restarted.
// That is acceptable — the persistent `handledComments` store in chrome.storage.local
// is the real guard; this deduplicator just avoids redundant LM Studio calls within a session.
const replyDedup = createReplyDeduplicator();

// Platform constant for this single-platform MVP (YouTube only).
const PLATFORM_SITE = 'YouTube';

// ─── Phase 10.2 — Sequential job processor ────────────────────────────────
/**
 * Process a single COMMENT_DETECTED job.
 *
 * This is the EXISTING per-comment logic moved verbatim from the listener,
 * preserving every log line, every response field name, and the exactly-once
 * sendResponse behaviour.  The only structural change is that it receives its
 * inputs as properties on `job` instead of reading them from closure variables.
 */
let workerRunning = false;
let rateLimitPaused = false; // suppress repeated pause logging across polls

/**
 * Resolve the minimum inter-job delay, falling back to the configured default.
 *
 * A valid value is a finite number >= 0. `0` is valid and means "no delay".
 * Anything else (missing, undefined, null, NaN, Infinity, negative, string,
 * boolean) falls back to DEFAULT_CONFIG so an invalid setting can never produce
 * a 0ms delay by accident, nor an unbounded or hanging wait.
 *
 * @param {*} rawValue — the untrusted settings value
 * @returns {number} a finite, non-negative delay in milliseconds
 */
function resolveMinDelayMs(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
    return rawValue;
  }
  debugWarn(
    'invalid replyBehavior.minDelayMs, using default:',
    DEFAULT_CONFIG.replyBehavior.minDelayMs
  );
  return DEFAULT_CONFIG.replyBehavior.minDelayMs;
}

/**
 * Resolve the maximum inter-job delay, falling back to the configured default.
 *
 * A valid value is a finite number >= 0. `0` is valid. Anything else falls back to
 * DEFAULT_CONFIG. A value SMALLER than the resolved minimum is treated as
 * inverted-range user error and clamped up to the minimum, so the final random
 * delay can never end up below minDelayMs.
 *
 * @param {*} rawValue — the untrusted settings value
 * @param {number} minDelayMs — the already-resolved minimum, used as the floor
 * @returns {number} a finite, non-negative maximum delay in milliseconds
 */
function resolveMaxDelayMs(rawValue, minDelayMs) {
  let max;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0) {
    max = rawValue;
  } else {
    debugWarn(
      'invalid replyBehavior.maxDelayMs, using default:',
      DEFAULT_CONFIG.replyBehavior.maxDelayMs
    );
    max = DEFAULT_CONFIG.replyBehavior.maxDelayMs;
  }
  if (max < minDelayMs) {
    debugWarn(
      'replyBehavior.maxDelayMs is below minDelayMs, clamping to minDelayMs'
    );
    return minDelayMs;
  }
  return max;
}

/**
 * Pick a random whole-millisecond delay within an inclusive [min, max] range.
 *
 * The `+ 1` makes the range inclusive of `max`, so both endpoints are reachable.
 * The final clamp guards against any caller passing a reversed range, which would
 * otherwise make the multiplier negative and produce a delay outside the range.
 *
 * @param {number} min — inclusive lower bound, a finite number >= 0
 * @param {number} max — inclusive upper bound, a finite number >= min
 * @returns {number} an integer in [min, max]
 */
function randomDelayMs(min, max) {
  const span = max - min + 1;
  const picked = Math.floor(min + Math.random() * span);
  return Math.min(Math.max(picked, min), max);
}

/**
 * Resolve the hourly reply cap, falling back to the configured default.
 *
 * A valid value is a positive finite number. Anything else — missing, undefined,
 * null, NaN, Infinity, zero, negative, string, boolean — falls back to
 * DEFAULT_CONFIG. A cap that resolved to 0 or NaN must never be treated as a real
 * cap, because "limit reached" would then be permanently true and the extension
 * would stop replying forever.
 *
 * @param {*} rawValue — the untrusted settings value
 * @returns {number} a positive finite cap, or 0 meaning "no limit"
 */
function resolveMaxRepliesPerHour(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }
  debugWarn(
    'invalid replyBehavior.maxRepliesPerHour, using default:',
    DEFAULT_CONFIG.replyBehavior.maxRepliesPerHour
  );
  return DEFAULT_CONFIG.replyBehavior.maxRepliesPerHour;
}

/**
 * Start the worker loop if it is not already running.
 *
 * The guard ensures at most one drain-loop runs at any time — jobs are
 * processed strictly FIFO, one-at-a-time.
 */
function ensureWorkerRunning() {
  if (workerRunning) return;
  workerRunning = true;
  (async () => {
    try {
      while (!jobQueue.isEmpty()) {
        // ── Phase 10.6: user pause ───────────────────────────────────────
        // Checked before dequeuing, so pausing never consumes or discards a
        // job. We re-check once per short interval so resuming takes effect
        // promptly without needing the service worker to be restarted.
        if (await isQueuePaused()) {
          YTAR_DEVLOG.log({
            component: C.QUEUE,
            event: 'QUEUE_PAUSED',
            runId: currentRunId,
            data: { queueSize: jobQueue.size(), reason: 'user paused the queue' }
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        // ── Phase 10.5: hourly reply cap ─────────────────────────────────
        // Checked BEFORE dequeuing, so a capped job stays in the queue rather
        // than being consumed and dropped. We wait and re-check on the next
        // iteration, which polls roughly once per min-delay interval and lets
        // the rolling window expire naturally. We never sleep for the whole
        // window, and we never drop the job.
        const rateSettings = await getSettings();
        const replyCap = resolveMaxRepliesPerHour(rateSettings?.replyBehavior?.maxRepliesPerHour);
        if (replyCap > 0 && (await isLimitReached(replyCap))) {
          if (!rateLimitPaused) {
            debugWarn('hourly reply cap reached, pausing queue');
            rateLimitPaused = true;
            YTAR_DEVLOG.log({
              component: C.QUEUE,
              event: 'RATE_LIMIT_HIT',
              runId: currentRunId,
              level: L.WARN,
              data: { cap: replyCap, queueSize: jobQueue.size(), windowMinutes: 60 }
            });
          }
          await new Promise((resolve) => setTimeout(resolve, resolveMinDelayMs(rateSettings?.replyBehavior?.minDelayMs) || 1000));
          continue;
        }
        if (rateLimitPaused) {
          debugLog('hourly reply cap cleared, queue resumed');
          rateLimitPaused = false;
          YTAR_DEVLOG.log({
            component: C.QUEUE,
            event: 'RATE_LIMIT_CLEARED',
            runId: currentRunId,
            data: { queueSize: jobQueue.size() }
          });
        }

        const job = jobQueue.dequeue();
        YTAR_DEVLOG.log({
          component: C.QUEUE,
          event: 'QUEUE_DEQUEUE',
          runId: currentRunId,
          commentId: job.id,
          data: { queueSizeAfter: jobQueue.size() }
        });
        // Phase 19.3 — the job has left the WAITING queue, so stop offering it for
        // recovery. Deliberately before processing: re-running a job that was already
        // in flight could spend a second LM Studio call and, with dry-run off, post
        // twice for one comment. Waiting jobs are what this module is protecting.
        removePendingJob(job.id);
        // One timed span per job, so a slow comment is attributable to that comment.
        const jobTimer = YTAR_DEVLOG.startTimer({
          component: C.QUEUE,
          event: 'QUEUE_JOB',
          endEvent: 'QUEUE_JOB_SUCCESS',
          errorEvent: 'QUEUE_JOB_FAILED',
          runId: currentRunId,
          commentId: job.id
        });
        try {
          await processJob(job);
          jobTimer.done({ hasReply: !!job.reply });
        } catch (error) {
          jobTimer.fail(error);
          logError('job processor: unhandled error, continuing:', error.message);
          try { job.respondOnce({ success: false, error: `Processing failed: ${error.message}` }); }
          catch (_) {}
        }

        // ── Phase 10.4: random delay between jobs (within min/max) ─────
        // Only wait if another job is actually waiting. The delay is measured
        // from THIS point (after the previous job finished), so the previous
        // job's processing time is not counted toward it.
        // sendResponse already fired inside processJob, so the content script
        // is not made to wait out this gap.
        if (!jobQueue.isEmpty()) {
          const settings = await getSettings();
          const minDelayMs = resolveMinDelayMs(settings?.replyBehavior?.minDelayMs);
          const maxDelayMs = resolveMaxDelayMs(settings?.replyBehavior?.maxDelayMs, minDelayMs);
          const delayMs = randomDelayMs(minDelayMs, maxDelayMs);
          // The inter-comment gap is the single biggest contributor to a long run, so
          // it is recorded rather than inferred from two timestamps.
          YTAR_DEVLOG.log({
            component: C.TIMER,
            event: 'INTER_COMMENT_DELAY',
            runId: currentRunId,
            data: { delayMs, minDelayMs, maxDelayMs, remainingJobs: jobQueue.size() }
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      workerRunning = false;
      YTAR_DEVLOG.log({
        component: C.QUEUE,
        event: 'QUEUE_IDLE',
        runId: currentRunId,
        data: { queueSize: jobQueue.size(), pendingJobsOnDisk: 0 }
      });
    }
  })();
}

/**
 * The distinct match modes across a rule list, for the diagnostic entries.
 *
 * Phase 19.9. Worth recording because `matchMode` is NOT consulted by the semantic pass —
 * it asks the model about intent — so a user who configured "exact" reasonably expects it
 * to be honoured and cannot otherwise tell from the log whether it was considered.
 *
 * @param {Object[]} rules
 * @returns {string[]}
 */
function collectMatchModes(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules.map((r) => (r && typeof r.matchMode === 'string' ? r.matchMode : null)).filter(Boolean))];
}

/**
 * Phase 20.16 — run the Knowledge pipeline for one comment.
 *
 * Ordered exactly as §25's Knowledge Mode diagram reads top to bottom, and each stage is
 * handed the output of the one before it:
 *
 *   index (20.4) → intent (20.6) → retrieval (20.5) → answerability (20.7) → grounded reply
 *   with bounded regeneration (20.8–20.11)
 *
 * NEVER REJECTS. Every failure returns a reason so the caller can report the §32 code, because
 * a throw here would be reported as a generic processing failure and would lose the
 * distinction between "the knowledge has no price" and "the model failed".
 *
 * Returns the SAME `{text, reasoning}` shape a trigger reply produces, which is what lets
 * everything downstream be shared verbatim.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {Object} params.settings
 * @param {Function} params.complete - `chatCompletion`, wrapped by the caller
 * @returns {Promise<Object>} a result with `ok`, `text`, `reasoning`, `code` and diagnostics
 */
async function runKnowledgePipeline({ commentText, settings, complete, runId, commentId }) {
  // ── Phase 20.18: the one funnel for "the knowledge path ended without a reply" ──
  //
  // Every skip below goes through here, and this is the ONLY place that records it.
  // Funnelling it means a new stage added to 20.4–20.13 cannot forget to report, and
  // it puts the recording next to the reason the skip happened, so the two cannot
  // disagree.
  //
  // It also matters that this happens HERE rather than at the call site: `failure()`
  // was previously invisible to the counters, so a Knowledge skip incremented nothing
  // at all and the Panel could not tell a declining base from a stopped extension.
  //
  // Phase 22.1: it also records the DETAIL. `knowledgeSkipReasons` answers "how often",
  // which is a run summary; the reason and the filenames that were offered are what
  // answer "why did this one not get answered", and without them a user seeing
  // "Declined by the base: 1" has nowhere to look but their own Markdown.
  const failure = (code, reason, extra = {}) => {
    recordKnowledgeSkip(code);
    recordKnowledgeSkipSample(code, {
      reason,
      commentText,
      // Filenames are resolved HERE rather than passed in: every call site would have to
      // remember to, and the one that matters most (the sufficiency gate) is the one
      // easiest to forget.
      filenames: extra.filenames || (extra.results || []).map((r) => ({ filename: r.filename })),
      // Phase 22.1 — retrieved vs offered vs dropped. Three numbers, because "the sections
      // do not mention it" is only a real diagnosis when nothing was cut on the way.
      retrievedCount: extra.retrievedCount,
      offeredCount: extra.offeredCount,
      droppedCount: extra.droppedCount,
      shortlist: extra.shortlist,
      intent: extra.intent
    });
    // Phase 20.19. Emitted HERE, beside the counter, so the diagnostic and the Side
    // Panel's skip-reason list can never describe the same exit differently. `extra`
    // carries whatever that particular exit knows — the intent, the retrieval state, how
    // many evidence sections the gate approved.
    emitSkip({
      runId,
      commentId,
      code,
      reason,
      intent: extra.intent,
      retrievalState: extra.retrievalState,
      evidenceCount: extra.evidenceCount,
      attempts: extra.attempts
    });
    return {
      ok: false,
      text: '',
      reasoning: '',
      code,
      reason,
      intent: '',
      attempts: 0,
      ...extra
    };
  };

  // ── 20.4: the index, and the freshness gate ───────────────────────────────
  // `getKnowledgeIndex()` is the ONLY way to read one; it rebuilds once per worker wake when
  // the cache is cold, which is required work rather than a caching failure.
  let index;
  recordStage(STAGE.KNOWLEDGE_INDEX);
  try {
    index = await getKnowledgeIndex();
  } catch (error) {
    return failure(KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, `the index could not be read: ${error.message}`);
  }
  // Phase 20.19 — 20.12's base-wide audit, run once per index fingerprint per worker.
  // `auditKnowledgeConflicts()` was written in 20.12 and called by nothing until now, so
  // a blocking conflict has never been surfaced proactively: the gate only ever explains a
  // comment that happened to ask about it. Guarded on the fingerprint because the index
  // itself is cached, and re-auditing an unchanged base once per comment would be pure
  // waste.
  if (index && index.fingerprint && !auditedFingerprints.has(index.fingerprint)) {
    auditedFingerprints.add(index.fingerprint);
    try {
      const audit = auditKnowledgeConflicts(index.sections || []);
      if (audit.conflicts.length || audit.shadowed.length) {
        emitConflicts({ runId, audit });
      }
    } catch (error) {
      // The audit is diagnostics. It must never be the reason a comment goes unanswered,
      // so a failure here is swallowed rather than propagated — and `logError` is used
      // rather than a raw console call, per the one-logging-system rule.
      logError('AUDIT_CONFLICTS: the conflict audit failed:', error.message);
    }
  }

  if (!index || index.retrievable !== true) {
    // Stale, building, failed or empty. 20.4's reason is carried through rather than
    // restated, because it distinguishes "rebuilding after a knowledge edit" from "your
    // documents are unreadable".
    return failure(
      KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED,
      `the knowledge index is not usable (${(index && index.reason) || 'no reason given'})`
    );
  }

  // ── 20.13: the active template's knowledge scope, if it declares one ──────
  const scope = readActiveScope(settings).entries;

  // ── 20.6: intent understanding ────────────────────────────────────────────
  // An enrichment, so a failure here costs one enrichment and nothing else: the comment is
  // still retrievable from its own text.
  recordStage(STAGE.KNOWLEDGE_INTENT);
  const intent = await analyzeIntent({ commentText, complete });

  // ── 20.5: semantic retrieval ──────────────────────────────────────────────
  recordStage(STAGE.KNOWLEDGE_RETRIEVAL);
  const retrieval = await retrieveKnowledge({
    commentText,
    index,
    complete,
    // The intent's terms are ADDED to the comment's own. The reranker still sees the comment
    // alone — naming the intent there would bias the last stage toward answering.
    extraTerms: intent.searchTerms,
    scope
  });

  // A hit is "something usable came back", recorded before the gate runs so the gap
  // between hits and answerable is visible: that gap is a knowledge base that does not
  // cover the channel's questions, which no other number on the panel reveals.
  emitRetrieval({ runId, commentId, retrieval });

  if (retrieval.results && retrieval.results.length > 0) {
    recordKnowledgeHit();
  }

  if (!retrieval.results || retrieval.results.length === 0) {
    return failure(
      retrieval.code || KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
      retrieval.reason || 'nothing relevant was retrieved',
      {
        intent: intent.intent,
        retrievalState: retrieval.state,
        // Phase 22.1 — WHAT WAS OFFERED. "the model found no relevant section in the
        // shortlist" is a true sentence that answers nothing a user can act on, because the
        // question is whether the section holding the answer was in the shortlist at all.
        // `toCandidateShortlist` drops overflow on a character budget, so a price inside a
        // long chapter never gets offered and the user is sent to edit Markdown that
        // already has it.
        shortlist: retrieval.shortlist,
        consideredCount: retrieval.consideredCount,
        offeredCount: retrieval.offeredCount,
        retrievedCount: 0,
        droppedCount: 0
      }
    );
  }

  // ── 20.7: the sufficiency gate ────────────────────────────────────────────
  recordStage(STAGE.KNOWLEDGE_ANSWERABILITY);
  const gate = await checkAnswerability({
    commentText,
    results: retrieval.results,
    retrievalStatus: retrieval.status,
    complete
  });

  emitAnswerability({ runId, commentId, gate });

  if (gate.status === ANSWERABILITY.CAN_ANSWER) {
    recordKnowledgeAnswerable();
    // Named as file + heading, not as evidence ids: the ids are opaque, and "which file
    // answered this comment" is the question the event exists to answer.
    emitEvidence({ runId, commentId, evidence: gate.evidence, results: retrieval.results });
  }

  if (gate.status !== ANSWERABILITY.CAN_ANSWER) {
    // The gate's own code is the §32 code. Conflating NO_SUPPORTED_ANSWER with a failed check
    // is what makes a working knowledge base read as broken.
    return failure(gate.code || KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER, gate.reason, {
      intent: intent.intent,
      retrievalState: retrieval.state,
      gateStatus: gate.status,
      // Phase 22.1 — the files that were ACTUALLY offered to the gate. This is the whole
      // diagnostic: when the base declines a price question, the question is always "did the
      // right file come back", and the filenames are the only evidence of that.
      results: retrieval.results,
      // …and the counts that say WHY the answer was not in them. The gate offers at most
      // five sections and drops any over 600 characters; retrieval drops overflow past
      // 12 candidates / 6,000 characters. A price written inside a long chapter is DROPPED
      // before the model ever sees it, and the gate's honest verdict — "the sections I was
      // given do not mention this" — then reads as "your files have no price", which sends
      // the user to edit Markdown that already has it.
      offeredCount: gate.offeredCount,
      droppedCount: gate.droppedCount,
      retrievedCount: Array.isArray(retrieval.results) ? retrieval.results.length : 0,
      // Phase 22.2 — so the Panel can say "the reranker dropped all of these, and the gate
      // then declined them anyway" instead of leaving two different rejections looking like
      // one unexplained fact.
      shortlist: retrieval.shortlist
    });
  }

  // ── 20.8–20.11: the grounded reply, with bounded regeneration ─────────────
  recordStage(STAGE.KNOWLEDGE_GENERATION);
  const generated = await generateAndValidateGrounded({
    commentText,
    evidence: gate.evidence,
    settings,
    complete
  });

  emitGrounding({ runId, commentId, generated });

  if (generated.status !== REPLY_STATUS.PUBLISHABLE) {
    return failure(generated.code || KNOWLEDGE_ERROR.GENERATION_FAILED, generated.reason, {
      intent: intent.intent,
      retrievalState: retrieval.state,
      attempts: generated.attempts,
      replyStatus: generated.status
    });
  }

  return {
    ok: true,
    // `reasoning` is empty on purpose: the knowledge stages reason in their own JSON, and
    // Phase 19.4's validator only cares whether reasoning LEAKED into the text.
    text: generated.reply,
    reasoning: '',
    code: '',
    reason: generated.reason,
    intent: intent.intent,
    // Surfaced for diagnostics and for 20.18's processing UI. NOT a rate-limit input:
    // `recordReply()` counts posted replies once per comment, which retries do not change.
    attempts: generated.attempts,
    retrievalState: retrieval.state,
    evidenceCount: gate.evidence.length
  };
}

async function processJob(job) {
  const { id, text, fingerprint, pageSessionId, hearted, creatorReplied } = job;

  YTAR_DEVLOG.log({
    component: C.BACKGROUND,
    event: 'COMMENT_PROCESSING_START',
    runId: currentRunId,
    commentId: id,
    level: L.DEBUG,
    data: { textLength: text ? text.length : 0, hasFingerprint: !!fingerprint }
  });

  // ── Task 12.1 — honour the popup's ON/OFF switch ──────────────────────────
  // The popup writes `enabled`, but a YouTube tab reads that flag only once, at page
  // load. So an already-open tab kept detecting comments and this worker kept
  // replying after the user switched the extension OFF, which made the popup toggle
  // cosmetic rather than real.
  //
  // This is the single authoritative gate: while `enabled` is false, no reply is
  // generated regardless of which path the comment arrived by (new tab, existing tab,
  // or a job already sitting in the queue when the user switched it off).
  const currentSettings = await getSettings();
  if (!currentSettings.enabled) {
    debugLog(`COMMENT_DETECTED: DISABLED - not replying to id=${id} (popup is OFF)`);
    saveLog({ status: LOG_STATUS.SKIPPED, site: PLATFORM_SITE, commentId: id, commentText: text });
    recordFailedOrSkipped();
    finishProcessing();
    job.respondOnce({ success: true, id, result: 'DISABLED' });
    return;
  }

  // ── The channel owner's heart: the LAST line before anything is spent ──────────
  //
  // Placed HERE, immediately after the settings read, for two reasons that are really one.
  // It has to be authoritative about the user's switch — a page tab that still had the filter
  // cached on will keep sending `hearted: true` after the creator switches it off, and that
  // tab is not a trusted source. And it has to stay ahead of `semanticMatchTriggers()` far
  // below, so a job that reached the queue carrying this flag spends nothing at all. Reading
  // `currentSettings`, which is already loaded, is what makes the first cheap.
  //
  // `hearted === true` is a STRICT boolean, and it is checked as its own statement rather than
  // merged into a condition, so the line the verifier pins stays exactly this line.
  if (hearted === true) {
    // The creator's switch decides whether this is a skip or an ordinary comment. When the
    // policy is off, the comment is processed normally and this whole block is skipped.
    if (currentSettings?.replyBehavior?.ignoreHeartedComments !== true) {
      debugLog(`COMMENT_DETECTED: heart filter is OFF - processing hearted id=${id} normally`);
    } else {
      debugLog(`COMMENT_DETECTED: SKIPPED_HEARTED - id=${id} (channel owner hearted it)`);
      YTAR_DEVLOG.log({
        component: C.BACKGROUND,
        event: 'SKIP_HEARTED',
        runId: currentRunId,
        commentId: id,
        level: L.DEBUG,
        data: { reason: 'the channel owner hearted this comment', stage: 'processJob' }
      });
      saveLog({ status: LOG_STATUS.SKIPPED, site: PLATFORM_SITE, commentId: id, commentText: text });
      recordFailedOrSkipped();
      finishProcessing();
      job.respondOnce({ success: true, id, result: 'SKIPPED_HEARTED' });
      return;
    }
  }

  // ── The channel owner's existing reply gate ──────────────────────────────────
  if (creatorReplied === true) {
    if (currentSettings?.replyBehavior?.ignoreCreatorRepliedComments !== true) {
      debugLog(`COMMENT_DETECTED: creator-reply filter is OFF - processing id=${id} normally`);
    } else {
      debugLog(`COMMENT_DETECTED: SKIPPED_CREATOR_REPLIED - id=${id} (channel owner already replied)`);
      YTAR_DEVLOG.log({
        component: C.BACKGROUND,
        event: 'SKIP_CREATOR_REPLIED',
        runId: currentRunId,
        commentId: id,
        level: L.DEBUG,
        data: { reason: 'the channel owner already replied to this comment', stage: 'processJob' }
      });
      saveLog({ status: LOG_STATUS.SKIPPED, site: PLATFORM_SITE, commentId: id, commentText: text });
      recordFailedOrSkipped();
      finishProcessing();
      job.respondOnce({ success: true, id, result: 'SKIPPED_CREATOR_REPLIED' });
      return;
    }
  }

  // ── Phase 9.x: Build fingerprint and check handled store ───────────────
  //
  // This is the persistent half of deduplication and the one that legitimately survives a
  // page reload: a record exists only because a reply was really published (see
  // markHandledIfPublished). Being here does not mean "the extension has seen this
  // comment" — it means "this comment was answered".
  if (await isHandled(fingerprint)) {
    debugLog(`COMMENT_DETECTED: SKIP_ALREADY_HANDLED - fp=${fingerprint}`);
    YTAR_DEVLOG.log({
      component: C.BACKGROUND,
      event: 'SKIP_ALREADY_HANDLED',
      runId: currentRunId,
      commentId: id,
      data: {
        reason: 'a reply was published for this comment in an earlier session',
        fingerprint,
        pageSessionId: pageSessionId || null
      }
    });
    saveLog({ status: LOG_STATUS.SKIPPED, site: PLATFORM_SITE, commentId: id, commentText: text });
    recordFailedOrSkipped();
    finishProcessing();
    job.respondOnce({ success: true, id, result: 'SKIPPED_ALREADY_HANDLED' });
    return;
  }

  // ── Phase 20.16 — which pipeline this mode calls for ───────────────────────
  //
  // Resolved ONCE, from the settings read above, and it decides exactly one thing here: whether
  // the trigger matcher runs at all. §25's Knowledge Mode diagram has no trigger stage, so
  // asking the model about triggers in Knowledge Mode would spend a request per comment AND —
  // worse — a classifier blip would abort the comment before the knowledge pipeline was ever
  // reached, silently making the mode useless.
  const describedMode = describeReplyMode(currentSettings.replyBehavior?.replyMode);

  // Fetch trigger rules and perform matching
  let verdict = { success: true, id };
  recordStage(STAGE.SEMANTIC_MATCHING);
  if (describedMode.usesTriggers) {
  try {
    const triggers = await getTriggers();

    // Enabled rules with at least one usable phrase, flattened to the phrase list the
    // model reasons over. The reverse lookup turns the phrase the model returns back
    // into the rule that owns it, so the activity log keeps recording `matchedRule`.
    const { phrases, ruleIdByPhrase } = flattenTriggerPhrases(triggers);

    if (phrases.length === 0) {
      // Configuration guard, not a matching decision: there is nothing to match
      // against, so no request is spent asking the model about an empty list.
      debugLog('COMMENT_DETECTED: NO_MATCH - no enabled trigger phrases');
      verdict.result = 'NO_MATCH';
    } else {
      // ── LM Studio decides the match ──────────────────────────────────────
      // The local deterministic matchers (src/core/matchers/*) are deliberately NOT
      // consulted here, not even as a pre-filter: they cannot read Arabic intent
      // ("بكام" vs "كام سعره؟"), and a local NO_MATCH would silently drop comments
      // the model would have matched. Every comment that reaches this point is asked
      // about exactly once.
      //
      // `chatCompletion` is the existing API client, injected — no second HTTP client.
      const matchTimer = YTAR_DEVLOG.startTimer({
        component: C.SEMANTIC_MATCHER,
        event: 'SEMANTIC_MATCH',
        endEvent: 'SEMANTIC_MATCH_RESULT',
        errorEvent: 'SEMANTIC_MATCH_ERROR',
        runId: currentRunId,
        commentId: id,
        requestId: newRequestId(),
        data: { triggerCount: phrases.length }
      });

      const decision = await semanticMatchTriggers({
        commentText: text,
        phrases,
        complete: chatCompletion,
      });

      if (!decision.ok) {
        // LM Studio unreachable, or the answer could not be read. Fail safe: never a
        // match, never a reply. Recorded as a failure through the existing
        // logging/status system so the user can see why nothing happened.
        logError(`COMMENT_DETECTED: semantic matching failed for id=${id}: ${decision.reason}`);
        YTAR_DEVLOG.error(C.SEMANTIC_MATCHER, 'SEMANTIC_MATCH_FAILED', {
          runId: currentRunId,
          commentId: id,
          message: decision.reason,
          // Phase 19.9 — this entry is the answer to "detected but never matched". The
          // Side Panel only shows a failed/skipped counter, which is indistinguishable from
          // a NO_MATCH there; here the reason, the triggers and the local cross-check are
          // all in one line, so the next occurrence is diagnosable without a repro.
          data: {
            reason: decision.reason,
            triggerCount: phrases.length,
            matchModes: collectMatchModes(triggers),
            normalizedPhrases: decision.diagnostic ? decision.diagnostic.normalizedPhrases : null,
            containsCrossCheck: decision.diagnostic ? decision.diagnostic.containsCrossCheck : null,
            pageSessionId: pageSessionId || null
          }
        });
        saveLog({
          status: LOG_STATUS.FAILED,
          site: PLATFORM_SITE,
          commentId: id,
          commentText: text,
          error: `Semantic matching failed: ${decision.reason}`
        });
        recordStage(STAGE.ERROR);
        recordFailedOrSkipped();
        finishProcessing();
        // The reason is recorded verbatim: it distinguishes "LM Studio unreachable"
        // from "the model answered something unreadable", which are different bugs.
        matchTimer.fail(null, { ok: false, reason: decision.reason, willReply: false });
        job.respondOnce({ success: false, id, error: `Semantic matching failed: ${decision.reason}` });
        return;
      }

      if (decision.matched) {
        const matchedPhrase = decision.trigger;
        const ruleId = ruleIdByPhrase.get(matchedPhrase) || '';
        debugLog(`COMMENT_DETECTED: MATCH - id=${id}, result=MATCH, phrase="${matchedPhrase}"`);
        verdict.result = 'MATCH';
        verdict.matchedPhrase = matchedPhrase;
        verdict.ruleId = ruleId;
        // Phase 19.6 — carry the rule object itself, not just its id, so the reply step
        // below can read replyMode/fixedReply without a second storage read. The list is
        // the same one the phrases were flattened from, and `first rule wins` in
        // flattenTriggerPhrases() means this find() agrees with the phrase→rule mapping.
        verdict.rule = triggers.find((t) => t && t.id === ruleId) || null;
        saveLog({ status: LOG_STATUS.MATCHED, site: PLATFORM_SITE, commentId: id, commentText: text, matchedRule: ruleId || matchedPhrase });
        recordMatched();
        matchTimer.done({
          ok: true,
          matched: true,
          selectedTrigger: matchedPhrase,
          ruleId: ruleId || null,
          // Phase 19.9 — why this matched, in the same entry.
          matchModes: collectMatchModes(triggers),
          containsCrossCheck: decision.diagnostic ? decision.diagnostic.containsCrossCheck : null,
          normalizedPhrases: decision.diagnostic ? decision.diagnostic.normalizedPhrases : null
        });
      } else {
        debugLog(`COMMENT_DETECTED: NO_MATCH - ${decision.reason}`);
        verdict.result = 'NO_MATCH';
        matchTimer.done({
          ok: true,
          matched: false,
          reason: decision.reason,
          // Phase 19.9 — a missed match is the case that needs evidence. `preview` is
          // VERBOSE-gated by the diagnostic engine, so the normalized comment is only
          // echoed when the user has asked for it.
          preview: decision.diagnostic ? decision.diagnostic.normalizedComment : undefined,
          matchModes: collectMatchModes(triggers),
          containsCrossCheck: decision.diagnostic ? decision.diagnostic.containsCrossCheck : null,
          normalizedPhrases: decision.diagnostic ? decision.diagnostic.normalizedPhrases : null
        });
      }
    }
  } catch (error) {
    logError('COMMENT_DETECTED error:', error.message);
    saveLog({ status: LOG_STATUS.FAILED, site: PLATFORM_SITE, commentId: id, commentText: text, error: error.message });
    recordStage(STAGE.ERROR);
    recordFailedOrSkipped();
    finishProcessing();
    job.respondOnce({ success: false, error: `Matching failed: ${error.message}` });
    return;
  }
  } else {
    // Knowledge Mode. No trigger stage at all, and `verdict.result` is left unset so the
    // routing below is reached with no match to short-circuit on.
    debugLog(`COMMENT_DETECTED: reply mode ${describedMode.mode} — trigger matching not run for id=${id}`);
  }

  // ── Phase 20.16 — route: does the Knowledge pipeline run for this comment? ──
  //
  // `routeComment()` decides, and this worker supplies BOTH paths: the trigger path reports the
  // verdict that was just computed (so no second LM Studio request is spent re-matching), and
  // the knowledge path runs 20.4–20.11 once.
  //
  // A trigger MATCH returns immediately without the knowledge path being called, which is what
  // makes a fixed reply un-overridable rather than merely preferred.
  // ── Rule 3, pre-generation half: never spend a second LM Studio call on one comment.
  //
  // Phase 20.17 — this moved ABOVE the routing step, and that is the whole point of the
  // move. It used to sit inside the shared block, where it guarded the TRIGGER generation. In
  // Knowledge Mode the pipeline has already run by then — routing comes first — so the check
  // could no longer prevent the spend it exists to prevent, and the same comment arriving twice
  // in one page load cost a second full round of LM Studio calls. A guard that runs after the
  // expensive thing has already happened is not a guard.
  //
  // Phase 19.8 — scoped to the PAGE SESSION (`pageSessionId`), not the worker lifetime.
  // This fires when the same comment arrives twice within one page load: the observer
  // re-reporting a node, or the initial scan and the observer both seeing it. It must NOT
  // fire merely because the worker outlived a page reload and still remembers the comment
  // — that is the bug this scoping fixes, and it is why the session id is threaded in
  // rather than being re-derived here.
  //
  // `verdict.ruleId` is not set yet at this point, which is correct: the guard is about the
  // COMMENT, not about whether a rule matched.
  if (replyDedup.hasGeneration(verdict.id, job.pageSessionId)) {
    debugLog(
      `COMMENT_DETECTED: SKIP_SESSION_DUPLICATE - a reply was already generated for id=${verdict.id} in this page session`
    );
    YTAR_DEVLOG.log({
      component: C.BACKGROUND,
      event: 'SKIP_SESSION_DUPLICATE',
      runId: currentRunId,
      commentId: id,
      data: {
        reason: 'a reply was already generated for this comment during this page session',
        pageSessionId: pageSessionId || null
      }
    });
    saveLog({
      status: LOG_STATUS.SKIPPED,
      site: PLATFORM_SITE,
      commentId: id,
      commentText: text,
      error: 'Duplicate generation suppressed (comment already generated this session)'
    });
    recordFailedOrSkipped();
    finishProcessing();
    job.respondOnce({ success: true, id, result: 'SKIPPED_DUPLICATE_GENERATION' });
    return;
  }

  let knowledge = null;
  const complete = (messages, options = {}) => chatCompletion(messages, {
    ...options,
    runId: currentRunId,
    commentId: id
  });

  // Not assigned: 20.19 moved the skip event into the pipeline's own funnel, which left
  // the only field this used to read (`knowledgeEntered`) with no reader. `routeComment`
  // still throws nothing and returns the routing decision, so discarding it is safe — but
  // a named-but-unused binding is a question for the next reader, hence the note.
  await routeComment({
    mode: describedMode.mode,
    commentText: text,
    matchTrigger: async () => ({
      ok: true,
      matched: verdict.result === 'MATCH',
      ruleId: verdict.ruleId || null,
      reply: verdict.reply || ''
    }),
    runKnowledge: async () => {
      knowledge = await runKnowledgePipeline({
        commentText: text,
        settings: currentSettings,
        complete,
        runId: currentRunId,
        commentId: id
      });
      return knowledge;
    }
  });

  // Phase 20.19 — the run-level outcome, now the shared emitter rather than a hand-built
  // entry. The SKIP event moved INTO the pipeline's `failure()` funnel, where the reason
  // and the counter are recorded together; emitting it again from here would double every
  // skip and give the log two sources for one fact. Only the success case is reported
  // here, because only the success case is decided out here.
  if (knowledge && knowledge.ok) {
    emitReplyGenerated({ runId: currentRunId, commentId: id, result: knowledge });
  }

  // Only attempt generation when there is something to generate: a trigger MATCH, or a
  // Knowledge pipeline that produced a reply. Everything below is the SHARED block — the same
  // validation, logging, counters, deduplication, handoff, rate limit and dry-run gate that a
  // trigger reply has used since Phase 1.
  if (verdict.result === 'MATCH' || (knowledge && knowledge.ok)) {
    // Phase 20.16 — which producer supplied the reply. A knowledge reply has no rule and is
    // never a fixed reply, so the 19.6 resolution is bypassed rather than consulted.
    const fromKnowledge = !!(knowledge && knowledge.ok);
    let settings;
    let messages;
    // ── Phase 19.6: Fixed Reply mode ───────────────────────────────────────
    // Resolved ONCE, here, and it decides exactly one thing: whether LM Studio is asked
    // to write the reply. It does not change matching (already decided above), and it
    // does not skip anything downstream — the same validation, deduplication, queue,
    // delay, rate limit, dry-run gate and publish verification all still run.
    //
    // A rule that is not in fixed mode, or a pre-19.6 rule with no replyMode at all,
    // resolves to AI here and the code below is byte-for-byte the old path.
    const replySource = resolveReplySource(verdict.rule);
    // A Knowledge reply is neither: it has no trigger rule, and it was already generated by
    // 20.8–20.11 using its own grounded prompt. Resolving it through `resolveReplySource()`
    // would ask whether a trigger has a fixed reply, which is the wrong question.
    const isFixedReply = !fromKnowledge && replySource.mode === REPLY_MODES.FIXED;

    recordStage(STAGE.PREPARING_REPLY);
    try {
      settings = await getSettings();
      // The prompt is only built when it will be used. Building it for a fixed reply would be
      // work whose output is thrown away, and the same is true of a Knowledge reply, whose
      // prompt was built inside the pipeline above.
      if (!isFixedReply && !fromKnowledge) {
        messages = buildReplyPrompt({ text }, settings);
      }
    } catch (error) {
      logError('COMMENT_DETECTED: Prompt build failed:', error.message);
      saveLog({ status: LOG_STATUS.FAILED, site: PLATFORM_SITE, commentId: id, commentText: text, matchedRule: verdict.ruleId, error: error.message });
      recordStage(STAGE.ERROR);
      recordFailedOrSkipped();
      finishProcessing();
      job.respondOnce({ success: false, error: `Prompt build failed: ${error.message}` });
      return;
    }

    try {
      // One place produces `result`, so everything below — validation, logging,
      // counters, deduplication, the handoff to the content script — is shared verbatim
      // between the two modes. That is what keeps a fixed reply from quietly acquiring a
      // second, less-tested publishing path.
      let result;
      if (fromKnowledge) {
        // Third producer of `result`, alongside the fixed-reply and AI branches. Because it
        // lands HERE, every stage below — validation, logging, counters, deduplication, the
        // handoff, the hourly cap, the dry-run gate, publish verification — is shared verbatim
        // with a trigger reply rather than reimplemented for Knowledge Mode.
        result = { text: knowledge.text, reasoning: knowledge.reasoning };
        debugLog(
          `COMMENT_DETECTED: knowledge reply prepared for id=${verdict.id}, ` +
          `intent=${knowledge.intent}, attempts=${knowledge.attempts}, ` +
          `evidence=${knowledge.evidenceCount}, reply length=${result.text.length}`
        );
      } else if (isFixedReply) {
        // The user's own words, used exactly as configured. No LM Studio request is
        // made here — this assignment is the entire bypass, and it is deliberately a
        // single `if` around one call rather than a branch around the whole block.
        result = { text: replySource.text, reasoning: '' };
        // Named events rather than one generic line, because "why did it not ask the
        // model?" is the question this mode raises, and it has to be answerable from
        // the log alone. The reply text itself is NOT logged: its length and the rule it
        // came from are enough, and the text is the user's content, not a diagnostic.
        YTAR_DEVLOG.log({
          component: C.REPLY,
          event: 'REPLY_MODE_FIXED',
          runId: currentRunId,
          commentId: verdict.id,
          data: {
            replyMode: REPLY_MODES.FIXED,
            triggerId: verdict.ruleId || null,
            matchedPhrase: verdict.matchedPhrase,
            replyLength: result.text.length
          }
        });
        YTAR_DEVLOG.log({
          component: C.REPLY,
          event: 'AI_REPLY_GENERATION_SKIPPED',
          runId: currentRunId,
          commentId: verdict.id,
          data: {
            reason: 'the matched trigger uses a fixed reply',
            triggerId: verdict.ruleId || null
          }
        });
        debugLog(
          `COMMENT_DETECTED: REPLY_MODE_FIXED - ai reply generation skipped for id=${verdict.id}, rule=${verdict.ruleId || '(none)'}, reply length=${result.text.length}`
        );
      } else {
        recordStage(STAGE.WAITING_FOR_LM);
        debugLog(`COMMENT_DETECTED: generation attempted for comment id=${verdict.id}`);
        // The full prompt used to be dumped here "temporarily". It printed the system
        // prompt and the raw comment text on every reply and was removed in Phase 18.3:
        // turn on Diagnostics logging to get progress lines, which name the comment id
        // without echoing its text or the prompt.
        result = await chatCompletion(messages, {
          operation: 'REPLY_GENERATION',
          runId: currentRunId,
          commentId: verdict.id
        });
      }

      // ── Task 7.4: validate before anything can be posted ───────────────
      // Pass BOTH text and reasoning so the validator can detect the case
      // where the model's chain of thought leaked into text.
      // Phase 19.4 — blacklist and repeat detection need two extra inputs:
      //   - the user's configured blacklist (falls back to the built-in list), and
      //   - the replies already written recently, so a verbatim repeat is caught.
      // A read failure here must not stop replying, so both degrade to "no checks".
      let recentReplies = [];
      try {
        recentReplies = await getRecentGeneratedReplies(REPEAT_CHECK_LIMIT, REPEAT_CHECK_WINDOW_MS);
      } catch (readError) {
        debugWarn('recent reply read failed, skipping repeat check:', readError.message);
      }

      const validation = validateReply(
        { text: result.text, reasoning: result.reasoning },
        {
          blacklist: settings?.replyBehavior?.blacklist,
          recentReplies,
          // Phase 19.7 — the ONLY check a fixed reply is exempt from. `isFixedReply` is the
          // flag the generation branch above already decided, so the exemption is driven by
          // the reply's actual source rather than by anything the caller can set: an AI
          // reply resolves it to false and keeps the Phase 19.4 repeat protection exactly
          // as before.
          //
          // Why it is needed at all: repeating the configured text is the point of fixed
          // mode. Left in place, the second "بكام" of an hour is rejected as
          // REPEAT_RESPONSE and the user sees 5 matches, 0 replies, 5 failures. Every other
          // check — empty, length, placeholders, code fences, reasoning leak, blacklist —
          // still runs, and everything after validation (dedup, queue, delays, rate limit,
          // dryRun, publish safety) is untouched.
          allowRepeat: isFixedReply
        }
      );
      if (!validation.valid) {
        logError(
          `COMMENT_DETECTED: rejected generated reply for id=${verdict.id}, reason=${validation.reason}`
        );
        job.respondOnce({ success: false, id: verdict.id, error: `Invalid reply: ${validation.reason}` });
        saveLog({ status: LOG_STATUS.FAILED, site: PLATFORM_SITE, commentId: verdict.id, commentText: text, matchedRule: verdict.ruleId, error: `Invalid reply: ${validation.reason}` });
        recordStage(STAGE.ERROR);
        recordFailedOrSkipped();
        finishProcessing();
        return;
      }

      // Log outcome AFTER the reply exists, using the text that will actually be posted.
      //
      // Phase 19.6 — for a fixed reply the CONFIGURED text is used, not
      // `validation.reply`. validateReply() normalizes by trimming, and for an AI reply
      // that is the right thing (model output arrives padded); for a fixed reply it would
      // silently rewrite what the user typed, which is exactly what this mode promises not
      // to do. Validation still runs in full and is still a hard gate — only the returned
      // value is bypassed, never the check.
      const replyText = isFixedReply ? result.text : validation.reply;
      // No preview for a fixed reply: it is the user's own text, and echoing it into the
      // log buys nothing that the length and the rule id do not already say.
      debugLog(
        isFixedReply
          ? `COMMENT_DETECTED: fixed reply prepared for comment id=${verdict.id}, reply length=${replyText.length}`
          : `COMMENT_DETECTED: generation completed for comment id=${verdict.id}, reply length=${replyText.length}, preview="${replyText.substring(0, 100)}..."`
      );
      // ── Phase 20.17 — the publish signal, and the reason Knowledge Mode appeared broken ──
      //
      // `verdict.result` is the WIRE contract with `content.js`, and that script acts on
      // exactly one thing: `response.result === 'MATCH' && response.reply`. A knowledge reply
      // used to arrive with `result` UNSET, so the reply box never opened — the reply was
      // generated, validated, counted as generated, charged to the hourly cap, logged as
      // GENERATED, and then silently never published.
      //
      // Nothing caught it because every suite that exists stops at this boundary: the knowledge
      // modules test themselves, and the packaging check can only see the worker's RESPONSE.
      // The bug lived in a field the two halves agreed nothing about.
      //
      // 'MATCH' here means "there is a reply to publish", NOT "a trigger matched" — that
      // distinction is carried by `matchedRule`, which is null for a Knowledge reply, and by the
      // devlog entry above. Reusing the value keeps content.js, the publish report and
      // markHandledIfPublished on the single Phase 19 path rather than forking the protocol.
      verdict.result = 'MATCH';
      verdict.reply = replyText;
      saveLog({ status: LOG_STATUS.GENERATED, site: PLATFORM_SITE, commentId: verdict.id, commentText: text, matchedRule: verdict.ruleId, generatedReply: replyText });
      recordGenerated();
      // The reply now belongs to the content script for open/insert/submit. The attempt
      // stays `active` until it reports back — closing it here would claim the job
      // finished while the reply was still being typed into YouTube.
      handOffToContent(verdict.id);

      // ── Phase 23.1: should the creator's heart go on this comment? ───────────
      //
      // Decided HERE, in the worker, and only here. This is the authoritative read of
      // `targetReplyHeartingEnabled`, and `currentSettings` comes from the `getSettings()`
      // call above — so the flag reflects the creator's choice at the moment this reply was
      // produced, not whatever a stale Side Panel or tab believed. Nothing downstream can
      // turn it on: the content script performs the click but only ever obeys this flag.
      //
      // It is set on the verdict, which IS the object handed to the content script as the
      // `COMMENT_DETECTED` response, so there is no new message, no second state store and
      // nothing to keep in sync — the decision travels with the reply it belongs to.
      //
      // ALWAYS ASSIGNED, including when false. Omitting it when off would leave the
      // content script reading `undefined`, which reads the same as "not asked to", so the
      // two cases would be indistinguishable in the log.
      verdict.heartAfterInsert = shouldHeartAfterInsert(verdict, currentSettings);
      if (verdict.heartAfterInsert) {
        debugLog('COMMENT_DETECTED: will heart the comment after inserting the draft');
      }

      // Phase 19.8 — the point a comment is "processed" but NOT yet answered. Naming it
      // separately from MARKED_HANDLED is what makes the bug class visible in the log: a
      // processed comment that never reaches MARKED_HANDLED is one that stayed eligible.
      YTAR_DEVLOG.log({
        component: C.BACKGROUND,
        event: 'PROCESSED',
        runId: currentRunId,
        commentId: verdict.id,
        data: {
          stage: 'reply_prepared',
          replyMode: fromKnowledge ? describedMode.mode : (isFixedReply ? REPLY_MODES.FIXED : REPLY_MODES.AI),
          dryRun: settings.dryRun === true,
          pageSessionId: pageSessionId || null
        }
      });

      // ── Two independent decisions, deliberately decoupled ───────────────
      // 1. In-session reply deduplication (replyDedup). The same-comment case is
      //    already handled BEFORE generation by hasGeneration() above; this call
      //    remains as a cross-comment similarity OBSERVATION (Rule 4) for logging.
      // 2. Persistent marking (markHandled): records that THIS comment was
      //    handled so it won't be replayed after a service-worker restart.
      // The persistent store must NOT depend on reply similarity — two
      // different comments should both be recorded even if their replies
      // are near-duplicates (Rule 4 of the deduplicator). See bug #2.

      // Observation only: a near-identical reply for a DIFFERENT comment is logged as
      // skipped. It does not remove `verdict.reply` (already set above), because two
      // distinct comments each deserve their own reply.
      const isReplyDuplicate = replyDedup.isDuplicate({
        reply: replyText,
        commentId: verdict.id,
        pageSessionId
      });
      if (isReplyDuplicate) {
        debugLog(
          `COMMENT_DETECTED: in-session duplicate suppressed - fp=${fingerprint}`
        );
        saveLog({ status: LOG_STATUS.SKIPPED, site: PLATFORM_SITE, commentId: verdict.id, commentText: text, matchedRule: verdict.ruleId, generatedReply: replyText, error: 'In-session duplicate reply suppressed' });
      }

      // Decision B: the hourly reply cap.
      //
      // Phase 19.8 — `recordReply()` used to be paired with `markHandled()` here, which
      // marked the comment handled at GENERATION time, before the content script had even
      // opened the reply box. That meant a comment whose publish then failed — or which was
      // only ever processed — was permanently unprocessable. markHandled() now happens on
      // the confirmed-publish path (see REPORT_PROCESSING_STAGE), and is deliberately NOT
      // here.
      //
      // `recordReply()` stays where it is, deliberately: it is a rate-limit counter, not a
      // record of what happened to a comment, and moving it would change rate-limit
      // behaviour — out of scope here. In dry-run nothing is posted, so counting it would
      // let test runs exhaust the cap and make the extension look rate-limited when it
      // never actually replied.
      if (replyText && !settings.dryRun) {
        await recordReply();
      }

      // Remember the fingerprint so the confirmed-publish report can mark it handled. The
      // map is in-memory and keyed by comment id; an entry is only useful between handoff
      // and the content script's terminal report, and is consumed there.
      if (replyText) {
        handoffFingerprints.set(verdict.id, { fingerprint, dryRun: settings.dryRun === true });
      }
    } catch (error) {
      logError('COMMENT_DETECTED: Generation failed:', error.message);
      saveLog({ status: LOG_STATUS.FAILED, site: PLATFORM_SITE, commentId: verdict.id, commentText: text, matchedRule: verdict.ruleId, error: error.message });
      recordStage(STAGE.ERROR);
      recordFailedOrSkipped();
      finishProcessing();
      job.respondOnce({ success: false, error: `Generation failed: ${error.message}` });
      return;
    }
  }

  // A NO_MATCH ends here with nothing to publish, so the attempt is over and the
  // stage can fall back to idle. A MATCH with a reply is NOT finished: handOffToContent()
  // above deliberately left it active, and the content script closes it out after the
  // open/insert/submit steps report back.
  if ((verdict.result !== 'MATCH' && !(knowledge && knowledge.ok)) || !verdict.reply) {
    finishProcessing();
  }

  job.respondOnce(verdict);
}

// Message handler. Deliberately NOT the listener itself — see the
// chrome.runtime.onMessage.addListener call at the bottom of this file for why.
async function handleMessage(message, sender, sendResponse) {
  // Opens the Side Panel. Chrome opens it on its own when the toolbar icon is
  // clicked (no action.default_popup is declared, so nothing intercepts the
  // click); this action exists for callers that need to open it explicitly.
  //
  // It used to open popup/popup.html as a TAB, which is no longer the right
  // thing: the panel is the live control surface now, and a tab copy would be a
  // second, disconnected instance of it.
  //
  // chrome.sidePanel.open() only succeeds from a user gesture, which a runtime
  // message is not guaranteed to be. That failure is reported rather than thrown,
  // because the click handler in the panel UI swallows it either way.
  if (message.action === 'openPopup') {
    const tabId = sender && sender.tab ? sender.tab.id : undefined;
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    // Everything needed to diagnose "the icon did not open the panel" in one entry.
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
    const openTimer = YTAR_DEVLOG.startTimer({
      component: C.SIDEPANEL,
      event: 'SIDEPANEL_OPEN',
      endEvent: 'SIDEPANEL_OPEN_SUCCESS',
      errorEvent: 'SIDEPANEL_OPEN_ERROR',
      data: {
        tabId: tabId === undefined ? null : tabId,
        windowId: windowId === undefined ? null : windowId,
        hasSidePanelApi: !!(chrome.sidePanel && typeof chrome.sidePanel.open === 'function'),
        hasSetPanelBehavior: !!(chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function'),
        manifestSidePanelDefaultPath: manifest.side_panel ? manifest.side_panel.default_path : null,
        manifestHasDefaultPopup: manifest.action ? !!manifest.action.default_popup : false,
        senderOrigin: sender && sender.origin ? sender.origin : null
      }
    });

    chrome.sidePanel
      .open(tabId === undefined ? {} : { tabId })
      .then(() => {
        openTimer.done({ opened: true });
        sendResponse({ success: true });
      })
      .catch((error) => {
        // The usual cause is calling open() outside a user gesture — which Chrome
        // reports here and nowhere else.
        openTimer.fail(error, { opened: false, likelyCause: 'open() requires a user gesture' });
        sendResponse({ success: false, error: error && error.message });
      });
    return true; // Keep channel open for sendResponse
  }
  
  if (message.action === 'openOptions') {
    chrome.tabs.create({ url: 'options/options.html' });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'GET_LM_STUDIO_MODELS') {
    getModels()
      .then(models => {
        sendResponse({ success: true, models });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        logError('Error getting models:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CONNECTION') {
    // Use chatCompletion with a minimal request to test connectivity
    const messages = [
      { role: 'user', content: 'ping' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ 
          success: true, 
          model: result.raw.model || 'unknown',
          text: result.text?.substring(0, 50) + (result.text && result.text.length > 50 ? '...' : '')
        });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        logError('Connection test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CHAT_COMPLETION') {
    // Non-destructive test that returns full chat completion response
    const messages = [
      { role: 'user', content: 'Say hello' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ success: true, text: result.text });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        logError('Chat completion test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  // ── Processing status ─────────────────────────────────────────────────────────
  // Read-only: returns the sanitized snapshot from processing-stats.js. Nothing here
  // touches settings, the queue or the reply flow, so the Popup can poll it freely
  // while the popup is open.
  //
  // After a service-worker restart the module state is fresh, so this returns safe
  // zeros with stage `idle` rather than throwing or reporting stale numbers.
  if (message.action === 'GET_PROCESSING_STATE') {
    sendResponse({ success: true, state: getProcessingState() });
    return true;
  }

  // Reset live processing tallies and timer to zero, on manual request or page reload.
  if (message.action === 'RESET_PROCESSING_STATS') {
    resetProcessingStats();
    sendResponse({ success: true, state: getProcessingState() });
    return true;
  }

  // ── Phase 20.20: the index status and the manual reload ──────────────────────
  //
  // §20 asks for explicit manual re-indexing as a FALLBACK. The automatic path already
  // covers a normal edit — the fingerprint is recomputed from storage on every read, so
  // new knowledge becomes available without rebuilding the extension — but a fallback
  // needs a trigger a user can actually press, for the case where they suspect the
  // automatic detection has got itself wrong.
  //
  // `getKnowledgeIndexStatus()` is exposed here because it existed and was called by
  // nothing: a user cannot be shown an index state that no code reads. Its `retrievable`
  // deliberately combines the stored state with this worker's in-memory cache, so it says
  // "ready" only when a reply could be answered RIGHT NOW — FRESH in storage after a
  // restart means "an index was built from these documents", not "one exists here".
  // ── Phase 20.23: document management (§4's add / remove / update / view) ─────
  //
  // THE STORE IS THE ONLY WRITER. These handlers call `knowledge-store.js` and never name a
  // knowledge key, which is what `verify-extension.mjs` enforces and what keeps a single
  // invalidation rule. A handler that built the array itself would be a second writer, and
  // §38 Test 10 would fail with nothing able to detect it.
  //
  // Every mutation THROWS on refusal, unlike the other stores which swallow errors. That is
  // deliberate — a knowledge write is a user action, and silently dropping it shows the user
  // a file they believe they saved. So each handler reports `error.reason`, which is a
  // stable code the Options page turns into a useful message.
  //
  // The index is NOT rebuilt here. The fingerprint changes on every real edit, so the next
  // retrieval rebuilds by itself, and §33 asks for the opposite of unnecessary work. The UI
  // refreshes the status afterwards so the user sees the change land.
  if (message.action === 'GET_KNOWLEDGE_DOCUMENTS') {
    try {
      sendResponse({
        success: true,
        documents: await readKnowledgeDocuments(),
        stats: await getKnowledgeStats()
      });
    } catch (error) {
      logError('GET_KNOWLEDGE_DOCUMENTS: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'ADD_KNOWLEDGE_DOCUMENT') {
    try {
      const document = await addKnowledgeDocument(message.document);
      YTAR_DEVLOG.info(C.BACKGROUND, 'KNOWLEDGE_DOCUMENT_ADDED', {
        runId: currentRunId,
        data: { documentId: document.id, filename: document.filename, chars: document.content.length }
      });
      sendResponse({ success: true, document });
    } catch (error) {
      sendResponse({ success: false, error: error.message, reason: error.reason || '' });
    }
    return true;
  }

  if (message.action === 'UPDATE_KNOWLEDGE_DOCUMENT') {
    try {
      const document = await updateKnowledgeDocument(message.documentId, message.updates);
      // Enabling and editing are the same write, so the event name has to cover both:
      // a version bump from an edit and a version bump from a re-enable are both "the user
      // changed this document".
      YTAR_DEVLOG.info(C.BACKGROUND, 'KNOWLEDGE_DOCUMENT_UPDATED', {
        runId: currentRunId,
        data: { documentId: document.id, filename: document.filename }
      });
      sendResponse({ success: true, document });
    } catch (error) {
      sendResponse({ success: false, error: error.message, reason: error.reason || '' });
    }
    return true;
  }

  if (message.action === 'REMOVE_KNOWLEDGE_DOCUMENT') {
    try {
      const removed = await removeKnowledgeDocument(message.documentId);
      YTAR_DEVLOG.info(C.BACKGROUND, 'KNOWLEDGE_DOCUMENT_REMOVED', {
        runId: currentRunId,
        data: { documentId: message.documentId, filename: removed.filename }
      });
      sendResponse({ success: true, removed });
    } catch (error) {
      sendResponse({ success: false, error: error.message, reason: error.reason || '' });
    }
    return true;
  }

  if (message.action === 'GET_KNOWLEDGE_STATUS') {
    try {
      const status = await getKnowledgeIndexStatus();
      sendResponse({ success: true, status });
    } catch (error) {
      logError('GET_KNOWLEDGE_STATUS: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // ── Phase 21.1 — Knowledge folder sync ─────────────────────────────────────
  //
  // Four actions, and the split is forced by the platform rather than chosen: `showDirectoryPicker`
  // does not exist in a worker, so the PICKER runs in the Options page and only the handle is
  // handed over. Everything else happens here, which is what lets the same sync run unattended
  // from an alarm.
  //
  // Note the asymmetry, which is the point: linking and forgetting carry the handle and are the
  // page's job; reading the folder is the worker's, and is shared by the button and the alarm.

  if (message.action === 'GET_KNOWLEDGE_FOLDER_STATE') {
    try {
      const handle = await loadFolderHandle();
      const permission = await queryFolderPermission(handle);
      sendResponse({
        success: true,
        state: {
          ...folderSyncState,
          linked: !!handle,
          folderName: handle ? String(handle.name || '') : '',
          permission: handle ? permission : FOLDER_PERMISSION.PROMPT
        }
      });
    } catch (error) {
      logError('GET_KNOWLEDGE_FOLDER_STATE: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // The handle is written by the PAGE (it owns the picker) and read by the worker, so this
  // action carries no document content — just the fact that a new folder was linked, which is
  // the signal to sync it once immediately rather than making the user wait for the alarm.
  if (message.action === 'KNOWLEDGE_FOLDER_LINKED') {
    try {
      const handle = await loadFolderHandle();
      if (!handle) {
        sendResponse({ success: false, error: 'no folder was stored' });
        return true;
      }
      // The click that produced this message is a user gesture in the page, so permission can
      // legitimately be (re)requested HERE in the page before the message is sent. The worker
      // asking on its own behalf would always fail.
      sendResponse({ success: true });
      syncKnowledgeFolder({ triggeredByUser: true });
      return true;
    } catch (error) {
      logError('KNOWLEDGE_FOLDER_LINKED: failed:', error.message);
      sendResponse({ success: false, error: error.message });
      return true;
    }
  }

  // ── Phase 21.2 — split a source document into the knowledge tree ─────────────

  // PREVIEW, then WRITE. Generation is two calls per document and can take a while, so the
  // outline and every generated file are returned for review and nothing touches the disk
  // until `WRITE_GENERATED_DOCUMENTS` arrives with paths the user has seen. Writing straight
  // from the generator would put a model's first attempt into the user's folder, which is the
  // one direction nobody can undo.

  if (message.action === 'PREVIEW_FOLDER_NAMES') {
    try {
      const handle = await loadFolderHandle();
      if (!handle) {
        sendResponse({ success: true, folders: [''], linked: false });
        return true;
      }
      sendResponse({ success: true, folders: await collectFolderNames(handle), linked: true });
    } catch (error) {
      logError('PREVIEW_FOLDER_NAMES: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'SPLIT_SOURCE_DOCUMENT') {
    try {
      const result = await splitSourceDocument(message.payload || {});
      sendResponse({ success: true, ...result });
    } catch (error) {
      logError('SPLIT_SOURCE_DOCUMENT: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'WRITE_GENERATED_DOCUMENTS') {
    try {
      const handle = await loadFolderHandle();
      if (!handle) {
        sendResponse({ success: false, error: 'no folder is linked' });
        return true;
      }
      // Readwrite is requested HERE, by the page, before this message — the worker can never
      // have the gesture that `requestPermission` requires. If it is not granted, writing
      // fails cleanly here and the tree is untouched.
      const permission = await queryFolderPermission(handle, 'readwrite');
      if (permission !== FOLDER_PERMISSION.GRANTED) {
        sendResponse({ success: false, error: 'the extension needs write access to that folder' });
        return true;
      }

      const requested = Array.isArray(message.files) ? message.files : [];
      const existing = (await collectFolderFiles(handle)).files.map((f) => f.path);
      const taken = [...existing];

      // The collision rule is applied at WRITE time rather than at preview time, because the
      // folder may have gained a file in between — and a path that was free when the preview
      // was rendered must still not overwrite something the user created meanwhile.
      const files = [];
      for (const file of requested) {
        if (!file || !file.path || !file.content) continue;
        const path = resolveUniquePath(file.path, taken);
        taken.push(path);
        files.push({ path, content: String(file.content) });
      }

      const outcome = await writeGeneratedFiles(handle, files);

      // Only a successful write syncs. A partial write leaves the folder holding what it can,
      // and the sync pulls in exactly that — the folder is the source of truth, so its current
      // contents are always the right thing to mirror.
      if (outcome.written.length) await syncKnowledgeFolder({ triggeredByUser: false });

      sendResponse({
        success: outcome.failed.length === 0,
        written: outcome.written,
        failed: outcome.failed,
        partial: outcome.written.length > 0 && outcome.failed.length > 0
      });
    } catch (error) {
      logError('WRITE_GENERATED_DOCUMENTS: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'SYNC_KNOWLEDGE_FOLDER') {
    try {
      const state = await syncKnowledgeFolder({ triggeredByUser: true });
      const documents = await readKnowledgeDocuments();
      sendResponse({ success: true, state, documents });
    } catch (error) {
      logError('SYNC_KNOWLEDGE_FOLDER: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // Forgetting is not "unlink but keep the documents". A folder the user has removed should
  // stop being the source of truth, and the documents already imported stay — they are the
  // user's knowledge now and deleting them would be a surprise they did not ask for.
  if (message.action === 'FORGET_KNOWLEDGE_FOLDER') {
    try {
      await clearFolderHandle();
      folderSyncState = {
        linked: false,
        folderName: '',
        permission: FOLDER_PERMISSION.PROMPT,
        lastSyncedAt: 0,
        lastResult: null,
        lastError: ''
      };
      sendResponse({ success: true });
    } catch (error) {
      logError('FORGET_KNOWLEDGE_FOLDER: failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // The manual reload. `forceRebuild` skips the fast path and re-parses every document,
  // so this is the expensive button and it is honest about being one: the response says
  // whether retrieval is now possible, and the failure text says WHICH documents broke
  // rather than just "re-index failed".
  if (message.action === 'RELOAD_KNOWLEDGE') {
    try {
      const index = await getKnowledgeIndex({ forceRebuild: true });
      // The status is read AFTER the rebuild rather than reusing the index's own fields:
      // the two can disagree, and the status is the same answer the Panel renders, so a
      // reload must not leave the UI showing something different from what it would show
      // on the next poll.
      const status = await getKnowledgeIndexStatus();

      // Emitted on BOTH outcomes: a manual reload is a user action, and silence after
      // pressing the button is the wrong answer whichever way it went.
      emitReloaded({ index, status, triggeredBy: 'manual' });

      sendResponse({
        success: index.retrievable === true,
        retrievable: index.retrievable === true,
        state: status.state,
        documentCount: status.documentCount,
        sectionCount: status.sectionCount,
        builtAt: status.builtAt,
        code: index.code || status.code || '',
        error: index.message || status.error || '',
        status
      });
    } catch (error) {
      logError('RELOAD_KNOWLEDGE: failed:', error.message);
      sendResponse({ success: false, retrievable: false, error: error.message });
    }
    return true;
  }

  // Stage/outcome reports from the content script, which is the only context that can
  // observe the opening-the-box, inserting and submitting steps. It also owns the
  // publish-success verdict, which is why "replies submitted" is counted from here and
  // not from generation.
  //
  // Every branch validates the payload and swallows failures: a telemetry report must
  // never break the reply flow, so a bad or missing field is simply ignored.
  if (message.action === 'REPORT_PROCESSING_STAGE') {
    const stage = message.stage;
    const outcome = message.outcome;
    const commentId = typeof message.commentId === 'string' ? message.commentId : undefined;

    try {
      if (stage) {
        recordStage(stage);
      }
      if (outcome === OUTCOME.SUBMITTED) {
        recordSubmitted();
        // Phase 19.8 — the ONLY path that marks a comment handled. Reached when the
        // content script reports a real submit, so a dry run, a detached comment, a reply
        // box that would not open and a failed submit all leave the comment processable
        // after a reload.
        if (commentId) {
          markHandledIfPublished(commentId).catch((error) => {
            logError('Could not mark comment handled:', error.message);
          });
        }
      } else if (outcome === OUTCOME.FAILED || outcome === OUTCOME.SKIPPED) {
        recordFailedOrSkipped();
        // Nothing was published, so the handoff record must not be left behind — and the
        // comment must stay eligible for processing on the next page load.
        if (commentId) handoffFingerprints.delete(commentId);
      }
      // The posting steps are the end of the attempt whenever the content script
      // reports a terminal outcome. A pure stage report (no outcome) is a mid-flight
      // update and must leave the attempt open.
      if (outcome) {
        finishProcessing(commentId);
      }
      sendResponse({ success: true });
    } catch (error) {
      logError('Error recording processing stage:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'GET_QUEUE_PAUSED') {
    isQueuePaused()
      .then((paused) => {
        sendResponse({ success: true, paused });
        return true;
      })
      .catch((error) => {
        logError('Error reading pause state:', error.message);
        sendResponse({ success: false, error: error.message });
        return true;
      });
    return true;
  }

  if (message.action === 'SET_QUEUE_PAUSED') {
    setQueuePaused(message.paused)
      .then((paused) => {
        debugLog(`queue pause state set to ${paused}`);
        sendResponse({ success: true, paused });
        return true;
      })
      .catch((error) => {
        logError('Error setting pause state:', error.message);
        sendResponse({ success: false, error: error.message });
        return true;
      });
    return true;
  }

  if (message.action === 'GET_ENABLED_STATE') {
    chrome.storage.local.get('enabled', result => {
      const enabled = result.enabled !== undefined ? result.enabled : false;
      sendResponse({ enabled: enabled });
      return true; // Keep channel open for sendResponse
    });
    return true; // Keep channel open for sendResponse
  }

  // ── Phase 11 — activity log access (read half of 11.3, and 11.4 clear) ──────
  // Exposed as message actions so a Logs UI can be added later without touching this
  // file again. No UI is wired up in Phase 11 core.
  if (message.action === 'GET_LOGS') {
    getLogs()
      .then(logs => { sendResponse({ success: true, logs: logs }); return true; })
      .catch(error => {
        sendResponse({ success: false, error: `Failed to read logs: ${error.message}` });
        return true;
      });
    return true;
  }

  if (message.action === 'CLEAR_LOGS') {
    clearLogs()
      .then(ok => { sendResponse({ success: ok }); return true; })
      .catch(error => {
        sendResponse({ success: false, error: `Failed to clear logs: ${error.message}` });
        return true;
      });
    return true;
  }

  // ── Phase 12 — popup status reads ──────────────────────────────────────────
  // Each is a separate read-only action, matching the existing one-action-per-concern
  // style of this listener. None of them mutate reply, queue or settings state.

  // Task 12.2 — connection status: connected / disconnected.
  // The popup shows a third "Unknown" state on its own: this request either has not
  // returned yet, or the message channel failed, so the popup falls back to Unknown.
  //
  // Uses getModels() (a cheap GET /models) rather than TEST_CONNECTION, which sends a
  // full 'ping' completion. A passive status badge must not trigger a generation.
  if (message.action === 'GET_CONNECTION_STATUS') {
    getModels()
      .then(models => {
        sendResponse({
          success: true,
          status: 'connected',
          modelCount: Array.isArray(models) ? models.length : 0
        });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        // LM Studio being closed is a normal state, not an extension fault, so this is
        // reported as a status rather than logged as an error.
        sendResponse({ success: true, status: 'disconnected', error: error.message });
        return true;
      });
    return true;
  }

  // Task 12.3 — the model the extension is configured to use.
  if (message.action === 'GET_CURRENT_MODEL') {
    getSettings()
      .then(settings => {
        const model = settings?.lmStudio?.model || '';
        sendResponse({ success: true, model: model });
        return true;
      })
      .catch(error => {
        sendResponse({ success: false, error: `Failed to read model: ${error.message}` });
        return true;
      });
    return true;
  }

  // Task 12.4 — how many replies are waiting in the queue.
  if (message.action === 'GET_QUEUE_COUNT') {
    sendResponse({ success: true, count: jobQueue.size() });
    return true;
  }

  // Task 12.5 — replies used vs the cap that is actually enforced.
  // The enforced window is the limiter's rolling DEFAULT_WINDOW_MS (1 hour), NOT a
  // calendar day, so the count is reported for that same window rather than mislabelled.
  if (message.action === 'GET_REPLY_STATS') {
    Promise.all([getSettings(), countRecentReplies(DEFAULT_WINDOW_MS)])
      .then(([settings, count]) => {
        sendResponse({
          success: true,
          count: count,
          limit: resolveMaxRepliesPerHour(settings?.replyBehavior?.maxRepliesPerHour),
          windowMs: DEFAULT_WINDOW_MS
        });
        return true;
      })
      .catch(error => {
        sendResponse({ success: false, error: `Failed to read reply stats: ${error.message}` });
        return true;
      });
    return true;
  }

  if (message.action === 'COMMENT_DETECTED') {
    // The content script sends the parsed comment nested under data.comment, i.e.
    // { action, data: { comment: { id, author, text } } }. Reading id/author/text
    // straight off message.data yielded undefined and rejected every real comment
    // with "Missing required comment field (id)". Unwrap the same node that the
    // fingerprint below already uses.
    const { id, author, text, hearted, creatorReplied } = message.data?.comment || {};

    // THE CHANNEL OWNER'S HEART — the worker's half of the filter.
    //
    // The page already drops hearted comments before sending them, so this should be dead code
    // on a healthy page. It is here because the page is NOT a trusted source: a tab can be
    // running a stale content script from before this filter existed, or a detection path that
    // never consults the gate can send one. One `if` costs nothing, and it sits BEFORE
    // `recordCommentDetected` so a hearted comment is never counted as detected, never
    // fingerprinted, never enqueued and never logged as QUEUED — it never becomes a job at all.
    //
    // Read as a STRICT BOOLEAN, exactly as `parseSemanticMatchResult` reads `matched` and
    // 20.7 reads `canAnswer`: a truthy `"true"` must not lean yes here, because the cost of a
    // false positive is a comment the creator never hearted going silently unanswered.
    if (hearted === true) {
      debugLog(`COMMENT_DETECTED: SKIPPED_HEARTED - id=${id} (channel owner hearted it)`);
      YTAR_DEVLOG.log({
        component: C.BACKGROUND,
        event: 'SKIP_HEARTED',
        runId: currentRunId,
        commentId: id,
        level: L.DEBUG,
        data: { reason: 'the channel owner hearted this comment' }
      });
      sendResponse({ success: true, id, result: 'SKIPPED_HEARTED' });
      return true;
    }

    if (creatorReplied === true) {
      debugLog(`COMMENT_DETECTED: SKIPPED_CREATOR_REPLIED - id=${id} (channel owner already replied)`);
      YTAR_DEVLOG.log({
        component: C.BACKGROUND,
        event: 'SKIP_CREATOR_REPLIED',
        runId: currentRunId,
        commentId: id,
        level: L.DEBUG,
        data: { reason: 'the channel owner already replied to this comment' }
      });
      sendResponse({ success: true, id, result: 'SKIPPED_CREATOR_REPLIED' });
      return true;
    }

    // Defensive: guard against missing/malformed payload
    if (!id) {
      logError('COMMENT_DETECTED received invalid payload:',
        'missing id field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (id)' });
      return true;
    }
    if (!text) {
      logError('COMMENT_DETECTED received invalid payload:',
        'missing text field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (text)' });
      return true;
    }

    // Normalize author for logging; empty is valid.
    const logAuthor = author || 'unknown';
    const textPreview = text.length > 100 ? text.substring(0, 100) + '...' : text;
    debugLog('COMMENT_DETECTED received:',
      `id=${id}, author=${logAuthor}, text="${textPreview}"`);

    // Counted here, after the payload validated: this is the point the background
    // genuinely received the comment, which is what the counter means. The id is passed
    // so the tally counts UNIQUE comments for this run — a MutationObserver burst or a
    // page reload re-reporting the same comment must not inflate it.
    recordCommentDetected(id);

    // A new run gets a new id the moment its first comment arrives, so every entry
    // emitted from here until the run's last comment finishes can be filtered by it.
    if (!currentRunId) {
      currentRunId = newRunId();
    }

    // Phase 19.8 — the page session this detection belongs to, read off the sender while it
    // is still available (sender is not guaranteed after an await). It scopes the duplicate-
    // generation guard, so it travels with the job.
    //
    // DECLARED HERE, BEFORE ANY READER. This previously sat further down, below the
    // QUEUE_ENQUEUE log that already referenced it — same block scope, so the shorthand
    // `pageSessionId` in that log hit the temporal dead zone and threw
    // "Cannot access 'pageSessionId' before initialization" for every COMMENT_DETECTED.
    // Nothing above this line awaits, so `sender` is still the live MessageSender.
    const pageSessionId = resolvePageSessionId(sender);

    YTAR_DEVLOG.log({
      component: C.QUEUE,
      event: 'QUEUE_ENQUEUE',
      runId: currentRunId,
      commentId: id,
      data: {
        queueSize: jobQueue.size(),
        author: logAuthor,
        textLength: text.length,
        isDuplicateOfSeenComment: false,
        // Recorded so a log can be partitioned by page session, which is what makes a
        // reload visible as a new session rather than an unexplained gap.
        pageSessionId
      }
    });

    // Capture everything SYNCHRONOUSLY — sender.tab.url may be invalid after await.
    const comment = message.data?.comment;
    const pageInfo = {
      site: PLATFORM_SITE,
      url: sender.tab?.url,
    };
    const fingerprint = createFingerprint(comment, pageInfo);

    // Enqueue the job and start (or keep) the worker.
    // Only `id` is required (dedup key); `text` validated in parseComment; `author` may be empty.
    const tabId = sender.tab?.id;
    let _responded = false;
    const respondOnce = (response) => {
      if (!_responded) {
        _responded = true;
        try {
          sendResponse(response);
        } catch (_) {}
        if (response && response.result === 'MATCH' && response.reply && tabId && chrome.tabs && chrome.tabs.sendMessage) {
          try {
            chrome.tabs.sendMessage(tabId, { action: 'MATCH_REPLY_READY', data: response }, () => {
              void chrome.runtime.lastError;
            });
          } catch (_) {}
        }
      }
    };
    const job = { id, text, fingerprint, pageSessionId, hearted, creatorReplied, respondOnce };
    jobQueue.enqueue(job);
    // Phase 19.3 — remember the job while it waits, so an idle service-worker kill
    // does not silently drop it. Not awaited: the reply must not wait on a storage
    // write, and removePendingJob() is serialized behind this one internally.
    addPendingJob({ commentId: id, text, fingerprint, enqueuedAt: Date.now() });
    saveLog({ status: LOG_STATUS.QUEUED, site: PLATFORM_SITE, commentId: id, commentText: text });
    ensureWorkerRunning();
    return true;
  }

  // ─── Phase 22: follow-ups on comments the creator already answered ───────────
  //
  // NOTHING HERE PUBLISHES. There is no call into the reply pipeline, no handoff to the
  // content script and no `markHandled`. The creator answers these by hand; the extension's
  // whole job is to notice and draft. That is what makes the toggle safe to offer at all,
  // and it is why the follow-up code lives in its own block instead of being a branch inside
  // `processJob`.

  if (message.action === 'ANSWERED_COMMENT_FOUND') {
    try {
      const comment = message.data?.comment;
      const replies = Array.isArray(message.data?.replies) ? message.data.replies : [];

      // The qualification rule, decided once and in one place. The content script ships the
      // raw thread because it cannot import the module; it does NOT decide anything.
      const verdict = classifyAnsweredComment({ replies });
      if (!verdict.qualified) {
        YTAR_DEVLOG.debug(C.BACKGROUND, 'FOLLOWUP_NOT_ANSWERED', {
          commentId: comment?.id,
          data: { reason: verdict.reason, replyCount: verdict.replyCount }
        });
        sendResponse({ success: true, recorded: false, reason: verdict.reason });
        return true;
      }

      // The creator may have turned the feature off between the scan starting and this
      // message arriving. Re-checked HERE, not only in the page, because the page is the
      // untrusted side of the boundary: a stale tab keeps scanning after the toggle is off,
      // and the store would fill with work the creator asked not to see.
      const settings = await getSettings();
      if (settings?.replyBehavior?.followupOnAnswered !== true) {
        sendResponse({ success: true, recorded: false, reason: 'the feature is off' });
        return true;
      }

      const pageInfo = { site: PLATFORM_SITE, url: sender.tab?.url };
      const fingerprint = createFingerprint(comment, pageInfo);
      const entry = await recordAnsweredComment({
        fingerprint,
        comment,
        replies,
        videoId: extractVideoId(sender.tab?.url)
      });

      if (entry) {
        YTAR_DEVLOG.info(C.BACKGROUND, 'FOLLOWUP_FOUND', {
          commentId: comment?.id,
          data: {
            ownerReplies: verdict.ownerReplies,
            replyCount: verdict.replyCount,
            textPreview: typeof comment?.text === 'string' ? comment.text.slice(0, 60) : ''
          }
        });
      }

      sendResponse({ success: true, recorded: Boolean(entry), fingerprint });
    } catch (error) {
      logError('ANSWERED_COMMENT_FOUND failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'GET_ANSWERED_COMMENTS') {
    try {
      const settings = await getSettings();
      // The toggle gates READING as well as writing. Returning the list while the feature is
      // off would let a stored board outlive the decision to stop using it.
      if (settings?.replyBehavior?.followupOnAnswered !== true) {
        sendResponse({ success: true, enabled: false, comments: [] });
        return true;
      }
      sendResponse({ success: true, enabled: true, comments: await listAnsweredComments() });
    } catch (error) {
      logError('GET_ANSWERED_COMMENTS failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'DRAFT_FOLLOWUP') {
    try {
      const settings = await getSettings();
      if (settings?.replyBehavior?.followupOnAnswered !== true) {
        sendResponse({ success: false, error: 'the feature is off' });
        return true;
      }

      const entry = await getAnsweredComment(message.data?.fingerprint);
      if (!entry) {
        sendResponse({ success: false, error: 'that comment is no longer on the board' });
        return true;
      }

      const messages = buildFollowupMessages({
        comment: { text: entry.text, author: entry.author },
        replies: entry.replies,
        instruction: settings.replyBehavior?.followupInstruction
      });

      const raw = await chatCompletion(messages, structuredCallOptions({
        maxTokens: 900,
        operation: 'FOLLOWUP_DRAFT'
      }));

      const result = parseFollowupResult(raw);
      if (!result.ok) {
        YTAR_DEVLOG.warn(C.BACKGROUND, 'FOLLOWUP_PARSE_FAILED', {
          data: { fingerprint: entry.fingerprint }
        });
        sendResponse({ success: false, error: 'the model did not return a readable answer' });
        return true;
      }

      if (!result.needsFollowup) {
        // Not a failure: the model decided the existing reply was already complete. Saying so
        // is more useful than an empty draft, because it explains the absence of a button.
        await dismissAnsweredComment(entry.fingerprint);
        sendResponse({
          success: true,
          needsFollowup: false,
          reason: result.reason || 'الرد الموجود كافٍ',
          comments: await listAnsweredComments()
        });
        return true;
      }

      // A draft the creator already has for another thread in the same video is offered, not
      // suppressed: the same popular question genuinely deserves one reply, and only the
      // creator knows whether these two viewers are the same person.
      const siblings = await listAnsweredComments();
      const duplicateOf = siblings.find(
        (other) =>
          other.fingerprint !== entry.fingerprint &&
          other.videoId === entry.videoId &&
          other.draft &&
          isNearDuplicateDraft(other.draft, result.draft)
      );

      await setAnsweredDraft(entry.fingerprint, { draft: result.draft, reason: result.reason });

      sendResponse({
        success: true,
        needsFollowup: true,
        draft: result.draft,
        reason: result.reason,
        similarToDraft: duplicateOf ? duplicateOf.id || '' : '',
        comments: await listAnsweredComments()
      });
    } catch (error) {
      logError('DRAFT_FOLLOWUP failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'DISMISS_FOLLOWUP') {
    try {
      await dismissAnsweredComment(message.data?.fingerprint);
      sendResponse({ success: true, comments: await listAnsweredComments() });
    } catch (error) {
      logError('DISMISS_FOLLOWUP failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  if (message.action === 'CLEAR_ANSWERED_COMMENTS') {
    try {
      await clearAnsweredComments();
      sendResponse({ success: true, comments: [] });
    } catch (error) {
      logError('CLEAR_ANSWERED_COMMENTS failed:', error.message);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // Default response for unknown message types
  sendResponse({ status: 'ok' });
  return true;
}

/**
 * The `v=` parameter of a YouTube watch URL, or ''.
 *
 * Used only to keep the panel's list scoped to one video — a creator scrolling between
 * videos should not see the previous video's board mixed in. Never parsed for anything
 * else, and never trusted as an identity.
 *
 * @param {string} [url]
 * @returns {string}
 */
function extractVideoId(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url));
    if (parsed.hostname.indexOf('youtube.com') === -1) return '';
    if (parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v') || '';
    }
    const match = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return '';
  } catch (_) {
    return '';
  }
}

// Single consolidated message listener for all message types.
//
// CRITICAL: this listener must NOT be declared `async`.
//
// An async listener returns a Promise, and Chrome resolves that Promise and uses the
// resolved value as the response, then closes the message channel. The handler body
// ends with `return true` to keep the channel open for a later sendResponse, so an
// async listener resolves to `true`: Chrome would deliver the boolean `true` as the
// response and discard every real sendResponse() payload.
//
// The symptom was the options page showing "Unable to load models" with the message
// "Failed to load models" — the generic fallback used when `response.error` is empty.
// Chrome had actually delivered `true`, where `response.success` is undefined. The
// fetch never even ran.
//
// So the listener stays synchronous, delegates to the async handleMessage above, and
// returns true itself. That is the documented way to keep a channel open for an async
// response, and it works on every Chrome version.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // One entry per inbound message. DEBUG level so NORMAL stays readable, but it is
  // exactly what is needed to answer "did the panel and the worker ever talk?".
  YTAR_DEVLOG.log({
    component: C.BACKGROUND,
    event: 'SERVICE_WORKER_MESSAGE_RECEIVED',
    runId: currentRunId,
    level: L.DEBUG,
    data: {
      action: message && message.action ? message.action : null,
      senderContext: sender ? (sender.tab ? 'content_script' : 'extension_page') : 'unknown',
      senderOrigin: sender && sender.origin ? sender.origin : null
    }
  });
  handleMessage(message, sender, sendResponse).catch((error) => {
    // A failure here is the one case that can strand a caller waiting on a response,
    // so it is recorded with the action that caused it.
    YTAR_DEVLOG.error(C.BACKGROUND, 'SERVICE_WORKER_ERROR', {
      runId: currentRunId,
      message: 'Unhandled message error: ' + error.message,
      error: error,
      data: { action: message && message.action ? message.action : null }
    });
    logError('Unhandled message error:', error.message);
    try {
      sendResponse({ success: false, error: `Unhandled error: ${error.message}` });
    } catch (_) {
      // Channel already closed; nothing further to do.
    }
  });
  return true; // Keep channel open for sendResponse
});

// ─── Side Panel: make the toolbar icon actually open it ──────────────────────
/**
 * Tell Chrome that clicking the toolbar action should toggle this extension's side
 * panel.
 *
 * WHY THIS CALL IS REQUIRED (the toolbar icon did nothing without it):
 * declaring `"side_panel": { "default_path": ... }` in the manifest only REGISTERS a
 * panel. It does not make the icon open it. `PanelBehavior.openPanelOnActionClick`
 * **defaults to false**, so with the manifest alone the icon click is handled by
 * Chrome and simply does nothing — the extension loads fine, the panel is registered,
 * and there is no visible error anywhere. That is exactly the failure reported.
 *
 * Deliberately NOT using `chrome.action.onClicked` instead: an onClicked listener
 * competes with this setting, and the pinned-icon path documented by Chrome only
 * honours the panel when this behaviour has been explicitly configured.
 *
 * This runs at top level rather than only in onInstalled, because an MV3 service
 * worker is torn down when idle and re-evaluated on the next event. Installing it
 * once at install time would leave the toolbar icon dead after the first idle
 * shutdown — the classic "it worked, then it stopped" side-panel bug. Re-asserting on
 * every worker start costs one cheap call and keeps the behaviour true.
 *
 * Failures are logged, not thrown: this must never take down worker startup.
 */
function enableOpenOnActionClick() {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  const hasApi = !!(chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function');

  YTAR_DEVLOG.log({
    component: C.SIDEPANEL,
    event: 'SIDEPANEL_BEHAVIOR_SET',
    level: hasApi ? L.DEBUG : L.ERROR,
    data: {
      hasSetPanelBehaviorApi: hasApi,
      requestedPath: manifest.side_panel ? manifest.side_panel.default_path : null,
      manifestHasDefaultPopup: manifest.action ? !!manifest.action.default_popup : false
    }
  });

  try {
    if (!hasApi) {
      logError('chrome.sidePanel.setPanelBehavior is unavailable — the toolbar icon will not open the panel');
      return;
    }
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => {
        logError('setPanelBehavior failed:', error && error.message);
      });
  } catch (error) {
    logError('setPanelBehavior threw:', error && error.message);
  }
}

// Log startup message for verification
chrome.runtime.onInstalled.addListener(() => {
  debugLog('Extension installed');
  // Re-assert here too: an extension update replaces the worker's top-level state.
  enableOpenOnActionClick();
});
// ─── Phase 19.3 — recover jobs lost to an idle service-worker kill ───────────
/**
 * Put still-waiting jobs back into the queue after a restart.
 *
 * A recovered job has no live message channel, so its responder is a no-op: the
 * content script that sent it was either reloaded or has already moved on, and the
 * background has nobody to answer. That is harmless — processJob() is what actually
 * writes the reply into the page, and it reaches the adapter on its own.
 *
 * The usual guards still apply to every recovered job, in this order:
 *   - `enabled` off          → responds DISABLED, no generation
 *   - fingerprint handled    → skipped
 *   - hourly cap reached     → stays queued in memory until the window clears
 *
 * Only one restore per worker lifetime: this runs at top level, and Chrome may
 * re-evaluate the worker for any event, so the guard is what stops a restart from
 * re-queueing the same comment twice.
 */
let pendingRestoreDone = false;

async function restorePendingJobs() {
  if (pendingRestoreDone) return;
  pendingRestoreDone = true;

  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      // The extension is switched off. Leave the stored jobs alone rather than
      // deleting them, so switching it back on does not lose the queue.
      debugLog('queue recovery skipped: extension is off');
      return;
    }

    const jobs = await loadPendingJobs();
    if (jobs.length === 0) return;

    let restored = 0;
    for (const entry of jobs) {
      jobQueue.enqueue({
        id: entry.commentId,
        text: entry.text,
        fingerprint: entry.fingerprint,
        // Nothing to answer: the channel that carried this job died with the worker.
        respondOnce: () => {}
      });
      restored++;
    }

    debugLog(`recovered ${restored} pending job(s) after a service worker restart`);
    // Restored jobs stay on disk until they are dequeued, so a second crash while
    // they wait does not lose them again.
    ensureWorkerRunning();
  } catch (error) {
    logError('queue recovery failed:', error.message);
  }
}

restorePendingJobs();

// Every worker start (first install, browser launch, wake from an idle teardown).
enableOpenOnActionClick();

// ─── Phase 21.1 — Knowledge folder sync ──────────────────────────────────────

/** The alarm name. Stable, because it is what identifies the job across worker teardowns. */
const FOLDER_SYNC_ALARM = 'ytar-knowledge-folder-sync';

/**
 * How often the unattended sync runs.
 *
 * Five minutes is a balance, not a derivation. A knowledge folder changes when a person edits
 * it, which is rare, so a shorter period buys nothing; a longer one means a user who edits a
 * price and expects it live waits. `chrome.alarms` clamps `periodInMinutes` to 1 for
 * unpacked/development extensions anyway, so this is a floor rather than a control.
 */
const FOLDER_SYNC_PERIOD_MINUTES = 5;

/**
 * Last known state of the folder link, so the Options page can explain itself without
 * having to read the handle itself.
 *
 * In-memory, deliberately, like everything else the worker holds across a wake. The handle
 * is the durable part (IndexedDB); this is a cache of what the last sync concluded, and a
 * stale one is corrected by the next sync rather than being wrong about knowledge.
 */
let folderSyncState = {
  linked: false,
  folderName: '',
  permission: FOLDER_PERMISSION.PROMPT,
  lastSyncedAt: 0,
  lastResult: null,
  lastError: ''
};

/**
 * Whether a sync is already running.
 *
 * A folder of fifty files takes a moment, the alarm and a manual click can land on top of
 * each other, and two concurrent walks would each plan against the same stored list and the
 * second would try to update documents the first had already updated. Single-flight, for the
 * same reason `ensureWorkerRunning()` has one.
 */
let folderSyncInFlight = false;

/**
 * Walk the linked folder and apply it to the base.
 *
 * NEVER THROWS. It is called from an alarm, where an exception is logged once by Chrome and
 * then never again until the next period — a failure that cannot report itself is a feature
 * that silently stops working.
 *
 * The permission check is the interesting part, and it is where the MV3 limit lands: the
 * worker can READ a handle it holds, but `requestPermission()` needs a user gesture and a
 * worker can never have one. So a `prompt` permission is reported as a state the UI can
 * show ("click Sync once") rather than retried in a loop that would never succeed.
 *
 * @param {Object} [options]
 * @param {boolean} [options.triggeredByUser] - a click has the gesture, so the failure modes
 *        that are only recoverable by hand can be reported as such
 * @returns {Promise<Object>} the new folder sync state
 */
async function syncKnowledgeFolder(options = {}) {
  const triggeredByUser = options.triggeredByUser === true;

  if (folderSyncInFlight) {
    return { ...folderSyncState, busy: true };
  }
  folderSyncInFlight = true;

  try {
    const handle = await loadFolderHandle();
    if (!handle) {
      folderSyncState = { ...folderSyncState, linked: false, permission: FOLDER_PERMISSION.PROMPT };
      return folderSyncState;
    }

    const permission = await queryFolderPermission(handle);
    folderSyncState = {
      ...folderSyncState,
      linked: true,
      folderName: String(handle.name || ''),
      permission
    };

    if (permission !== FOLDER_PERMISSION.GRANTED) {
      // Recorded, not thrown and not retried. The folder link still exists; what is missing
      // is a click, and the Options page is where the user makes one.
      folderSyncState.lastError = permission === FOLDER_PERMISSION.DENIED
        ? 'permission to read the folder was denied'
        : 'permission to read the folder needs to be granted once from the Options page';
      return folderSyncState;
    }

    const { files, skips, truncated } = await collectFolderFiles(handle);

    // Read before planning, so a file that cannot be read is a skip rather than a document
    // whose content is empty. An empty document would be refused by the store and fail the
    // whole sync on a single locked file.
    const incoming = [];
    for (const entry of files) {
      const read = await readFolderEntry(entry);
      if (read.ok) incoming.push(read.document);
      else skips.push({ path: read.path, reason: read.reason });
    }

    const stored = await readKnowledgeDocuments();
    const plan = planFolderSync(stored, incoming);
    const summary = summarizePlan(plan, skips);

    let applied = { applied: false, documentCount: stored.length, skipped: skips.length };
    if (planHasChanges(plan)) {
      applied = await applyFolderSync(plan);
    }

    folderSyncState = {
      ...folderSyncState,
      lastSyncedAt: Date.now(),
      lastError: '',
      lastResult: { ...summary, truncated, documentCount: applied.documentCount }
    };

    YTAR_DEVLOG.info(C.KNOWLEDGE, 'KNOWLEDGE_FOLDER_SYNC_DONE', {
      runId: currentRunId,
      data: {
        folderName: folderSyncState.folderName,
        files: files.length,
        added: summary.added,
        updated: summary.updated,
        removed: summary.removed,
        skipped: summary.skipped,
        truncated,
        applied: applied.applied,
        trigger: triggeredByUser ? 'user' : 'alarm'
      }
    });

    return folderSyncState;
  } catch (error) {
    // Reported into the state so the Options page can show it. A sync failure must leave the
    // base exactly as it was — which it does, because `applyFolderSync()` writes once.
    folderSyncState = {
      ...folderSyncState,
      lastError: error && error.message ? error.message : 'folder sync failed'
    };
    logError('knowledge folder sync failed:', folderSyncState.lastError);
    return folderSyncState;
  } finally {
    folderSyncInFlight = false;
  }
}

/**
 * Keep the periodic alarm armed, and register its listener — but only when `chrome.alarms`
 * exists.
 *
 * CALLED AT TOP LEVEL, not inside `onInstalled`, for the same reason `enableOpenOnActionClick()`
 * is: an MV3 worker is torn down when idle and this runs again on the next wake. An
 * install-time-only registration would leave the alarm unscheduled after the first browser
 * restart, and the feature would quietly stop syncing with nothing to indicate why.
 *
 * `get` before `create` is not defensive noise: Chrome resets a duplicate alarm rather than
 * replacing it, so re-creating on every wake would push the next run further into the future
 * each time the worker started.
 *
 * The guard is load-bearing and NOT defensive padding. `chrome.alarms` is absent in any
 * context where the `alarms` permission is not granted, and an unguarded
 * `chrome.alarms.onAlarm` at the TOP LEVEL of this module throws during evaluation — which
 * aborts the whole worker before any listener registers. The extension then runs with no
 * background at all, every comment silently disappears, and Chrome reports only
 * "Service worker registration failed. Status code: 15". A missing optional feature must
 * never be able to do that, so it is skipped whole: no alarm, no listener, nothing broken.
 */
function ensureFolderSyncAlarm() {
  if (typeof chrome === 'undefined' || !chrome.alarms) return false;

  try {
    if (typeof chrome.alarms.get === 'function') {
      chrome.alarms.get(FOLDER_SYNC_ALARM, (existing) => {
        if (existing) return;
        if (typeof chrome.alarms.create === 'function') {
          chrome.alarms.create(FOLDER_SYNC_ALARM, { periodInMinutes: FOLDER_SYNC_PERIOD_MINUTES });
        }
      });
    } else if (typeof chrome.alarms.create === 'function') {
      chrome.alarms.create(FOLDER_SYNC_ALARM, { periodInMinutes: FOLDER_SYNC_PERIOD_MINUTES });
    }

    if (chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== FOLDER_SYNC_ALARM) return;
        syncKnowledgeFolder({ triggeredByUser: false });
      });
    }
    return true;
  } catch (error) {
    logError('ensureFolderSyncAlarm failed:', error.message);
    return false;
  }
}

/**
 * Phase 21.2 — turn one source document into a reviewable set of generated files.
 *
 * Runs in the WORKER even though the source arrived in the page, because `complete` is the
 * API client and the client lives here. Two phases, and the split is the point: the model is
 * reliable about the bounded decision (which files, where) and not the unbounded one (writing
 * every file in one response), where an over-long answer is truncated mid-file and still
 * parses as valid JSON.
 *
 * NEVER THROWS. The page shows the result, and a failure that returns nothing is a blank
 * screen; a failure that returns a reason is a message.
 *
 * @param {Object} payload
 * @param {string} payload.sourceText
 * @param {string} [payload.instruction] - the user's own command, passed through verbatim
 * @param {string[]} payload.folders - destinations, read from the linked folder
 * @returns {Promise<Object>} `{documents, rejected, counts}`
 */
async function splitSourceDocument(payload) {
  const usable = sourceIsUsable(payload && payload.sourceText);
  if (!usable.ok) {
    return { ok: false, documents: [], rejected: [], counts: null, error: usable.reason };
  }

  const sourceText = String(payload.sourceText);
  const folders = Array.isArray(payload.folders) ? payload.folders : [''];
  const instruction = payload.instruction == null ? '' : String(payload.instruction);

  // ── Phase A: the outline ────────────────────────────────────────────────
  let outlineResponse;
  try {
    outlineResponse = await chatCompletion(
      buildOutlineMessages({ sourceText, folders, instruction }),
      structuredCallOptions({ maxTokens: 600, operation: 'DOC_SPLIT_OUTLINE' })
    );
  } catch (error) {
    const reason = error && error.isReasoningBudget
      ? 'the model spent its whole token budget thinking and returned no outline'
      : (error && error.message) || 'the outline call failed';
    return { ok: false, documents: [], rejected: [], counts: null, error: reason };
  }

  const outline = parseOutline(outlineResponse && outlineResponse.text, { folders });
  if (!outline.ok) {
    return { ok: false, documents: [], rejected: [], counts: null, error: outline.reason };
  }

  // ── Phase B: one file at a time ─────────────────────────────────────────
  const documents = [];

  for (const planned of outline.documents) {
    let status = SPLIT_STATUS.FAILED;
    let content = '';
    let reason = '';
    let corrections = [];
    let unsupported = [];

    for (let attempt = 1; attempt <= SPLIT_DEFAULTS.maxAttempts; attempt += 1) {
      let response;
      try {
        response = await chatCompletion(
          buildSectionMessages({ document: planned, sourceText, corrections }),
          structuredCallOptions({ maxTokens: 900, operation: 'DOC_SPLIT_SECTION' })
        );
      } catch (error) {
        reason = error && error.isReasoningBudget
          ? 'the model spent its whole token budget thinking and returned no file'
          : (error && error.message) || 'the call failed';
        break;
      }

      const parsed = parseSection(response && response.text);
      if (!parsed.ok) {
        reason = parsed.reason;
        continue;
      }

      // The deterministic check runs BEFORE the heading is added, so the number scan sees the
      // model's own text. A heading contributes no figures.
      unsupported = findUnsupportedNumbers(parsed.content, sourceText);
      if (unsupported.length > 0) {
        status = SPLIT_STATUS.UNGROUNDED;
        reason = `the file states ${unsupported.join(', ')}, which the source does not contain`;
        corrections = [
          `remove or correct the figures ${unsupported.join(', ')} — they appear nowhere in the source`,
        ];
        continue;
      }

      content = parsed.content;
      reason = '';
      status = SPLIT_STATUS.GENERATED;
      break;
    }

    if (status === SPLIT_STATUS.GENERATED) {
      // A heading is added here, deterministically, rather than asked for again. See
      // `ensureHeading()`: without one the file parses as a single anonymous section and the
      // subject name — which usually lives only in the heading — never reaches retrieval.
      const headed = ensureHeading(content, planned.title);
      documents.push({
        path: planned.path,
        title: planned.title,
        summary: planned.summary,
        content: headed.content,
        chars: headed.content.length,
        status: headed.added ? SPLIT_STATUS.NEEDS_HEADING : SPLIT_STATUS.GENERATED,
        headingAdded: headed.added,
        unsupported: [],
        reason: headed.added ? 'a heading was added from the outline title' : ''
      });
    } else {
      documents.push({
        path: planned.path,
        title: planned.title,
        summary: planned.summary,
        content: '',
        chars: 0,
        status,
        headingAdded: false,
        unsupported,
        reason
      });
    }
  }

  // Overlap between the generated files, computed on what actually came back rather than
  // assumed away. A model asked to copy one topic will sometimes copy the whole source into
  // every file, and an overlapping pair is a §18 BLOCKING conflict — the user's questions
  // about that subject would stop being answered until they fixed a file this extension
  // generated. Reported rather than dropped: which overlapping file to keep is their call.
  const duplicates = findDuplicates(documents);

  const rejected = documents.filter(
    (d) => d.status !== SPLIT_STATUS.GENERATED && d.status !== SPLIT_STATUS.NEEDS_HEADING
  );
  const ready = documents.length - rejected.length;

  for (const duplicate of duplicates) {
    const target = documents.find((d) => d.path === duplicate.path);
    if (target) {
      target.duplicatesAnother = true;
      target.duplicateOf = duplicate.overlapsWith;
      target.reason =
        `most of this file also appears in ${duplicate.overlapsWith} — writing both would make ` +
        'them conflict, so untick one of them';
    }
  }

  YTAR_DEVLOG.info(C.KNOWLEDGE, 'DOCUMENT_SPLIT_DONE', {
    runId: currentRunId,
    data: {
      proposed: outline.documents.length,
      ready,
      rejected: rejected.length,
      duplicates: duplicates.length,
      foldersOffered: folders.length,
      hasInstruction: !!instruction
    }
  });

  return {
    ok: ready > 0,
    documents,
    rejected,
    duplicates,
    counts: { proposed: outline.documents.length, ready, rejected: rejected.length, duplicates: duplicates.length },
    error: ready > 0 ? '' : 'no file could be generated from this document'
  };
}

ensureFolderSyncAlarm();

/**
 * Phase 20.20 — change detection. Notices that the knowledge base was edited.
 *
 * Listening to `knowledgeDocuments` ONLY, and the reason matters: the indexer writes
 * `knowledgeIndexMeta` itself on every build, so a listener on both keys would fire inside
 * its own rebuild and could clear the cache it had just built. The documents key is user
 * content and is never written by the indexer, which makes it the one safe signal.
 *
 * It is a NOTICE, not a correctness mechanism, and it is best-effort by nature: an MV3
 * worker is torn down when idle, so this simply does not fire while the worker is asleep —
 * which is fine, because the fingerprint is recomputed from storage on every read of the
 * index and a rebuild happens anyway when the next comment arrives. Nothing about
 * correctness may come to depend on this listener; see `emitDocumentsChanged()` for the
 * two things it deliberately does not do.
 */
watchKnowledgeDocuments(({ changes, documents }) => {
  try {
    // Through the diagnostics module rather than a hand-built entry: one vocabulary, so a
    // filter on KNOWLEDGE_DOCUMENTS_CHANGED finds this entry and every future one.
    emitDocumentsChanged({
      runId: currentRunId,
      changes,
      newValue: documents,
      operation: changes.length === 1 ? changes[0].operation : `${changes.length} changes`
    });
  } catch (error) {
    // A notification must never be able to break the worker. Swallowed, and the fingerprint
    // path still guarantees the next comment sees the new knowledge.
    logError('watchKnowledgeDocuments: failed:', error.message);
  }
});
