/**
 * Knowledge Diagnostics Tests (Phase 20.19)
 *
 * The structured events §20.19 asks for: retrieval, answerability, evidence, grounding
 * validation, skips and conflicts.
 *
 * Two properties matter more than the payload shapes, and both are tested here:
 *
 *  1. **The emitter never throws.** Every caller sits on the reply path, so a diagnostics
 *     fault must degrade to a missing entry, never to an unanswered comment.
 *  2. **The event vocabulary is closed.** §20.19's events are what any future diagnostics
 *     UI filters on, so a typo has to fail loudly in a test rather than producing an entry
 *     that simply never appears at runtime.
 *
 * Levels are asserted because they are a decision, not an accident: INFO for the run
 * outcome a user opens diagnostics to see, WARN for the two rare actionable faults, DEBUG
 * for the per-stage forensics.
 *
 * Runs in the browser from knowledge-diagnostics-tests.html (there is no Node runner).
 */

import {
  KNOWLEDGE_EVENT,
  KNOWLEDGE_DIAG_LEVEL,
  emitRetrieval,
  emitAnswerability,
  emitEvidence,
  emitGrounding,
  emitSkip,
  emitConflicts,
  emitReplyGenerated
} from '../knowledge-diagnostics.js';

import { auditKnowledgeConflicts } from '../knowledge-conflicts.js';

const results = { total: 0, passed: 0, failed: 0 };

const DEVLOG = globalThis.YTAR_DEVLOG;

async function runTest(name, fn) {
  results.total++;
  try {
    const outcome = await fn();
    if (outcome === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: ${outcome}`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

/** Diagnostics on, cleared, so every case starts from an empty buffer. */
function fresh(verbosity) {
  if (DEVLOG) {
    DEVLOG.configure({ enabled: true, verbosity: verbosity || 'VERBOSE' });
    DEVLOG.clearEntries();
  }
}

/** Entries for one event name, oldest first. */
function entriesFor(event) {
  return DEVLOG.getEntries().filter((entry) => entry.event === event);
}

/** A full retrieval result, as `retrieveKnowledge()` actually returns one. */
function aRetrieval(overrides) {
  return Object.assign(
    {
      status: 'RETRIEVED',
      state: 'reranked',
      consideredCount: 12,
      offeredCount: 4,
      code: '',
      reason: '',
      results: [{ evidenceId: 'EV-1' }, { evidenceId: 'EV-2' }]
    },
    overrides || {}
  );
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────────

async function testEveryEventIsNamedInTheFrozenSet() {
  // A literal at a call site instead of a KNOWN constant is exactly the failure this
  // catches: the event simply never appears, with nothing logged and nothing failing.
  const required = [
    'KNOWLEDGE_RETRIEVAL',
    'KNOWLEDGE_ANSWERABILITY',
    'KNOWLEDGE_EVIDENCE',
    'KNOWLEDGE_GROUNDING',
    'KNOWLEDGE_SKIP',
    'KNOWLEDGE_CONFLICT',
    'KNOWLEDGE_REPLY_GENERATED'
  ];
  const declared = Object.keys(KNOWLEDGE_EVENT).map((key) => KNOWLEDGE_EVENT[key]);
  const missing = required.filter((name) => !declared.includes(name));
  return missing.length === 0 || `events not declared: ${missing.join(', ')}`;
}

async function testEventNamesAreUnique() {
  const names = Object.values(KNOWLEDGE_EVENT);
  const dupes = names.filter((name, i) => names.indexOf(name) !== i);
  return dupes.length === 0 || `duplicate event names: ${dupes.join(', ')}`;
}

// ─── Retrieval ──────────────────────────────────────────────────────────────────

async function testRetrievalReportsCountsAndIds() {
  fresh();
  emitRetrieval({ runId: 'r1', commentId: 'c1', retrieval: aRetrieval() });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.RETRIEVAL);
  if (!entry) return 'no KNOWLEDGE_RETRIEVAL entry';
  const d = entry.data;

  // The three counts are what answer "why did it pick that file": the drop between
  // `considered` and `offered` is a shortlist problem, not a knowledge-base problem.
  if (d.consideredCount !== 12) return `consideredCount=${d.consideredCount}`;
  if (d.offeredCount !== 4) return `offeredCount=${d.offeredCount}`;
  if (d.resultCount !== 2) return `resultCount=${d.resultCount}`;
  if (!Array.isArray(d.resultIds) || d.resultIds.length !== 2) return 'resultIds missing';
  return true;
}

async function testRetrievalIsCorrelatedByRunAndComment() {
  fresh();
  emitRetrieval({ runId: 'run-7', commentId: 'comment-9', retrieval: aRetrieval() });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.RETRIEVAL);
  if (entry.runId !== 'run-7') return `runId=${entry.runId}`;
  if (entry.commentId !== 'comment-9') return `commentId=${entry.commentId}`;
  return true;
}

async function testRetrievalSurvivesAnEmptyResult() {
  fresh();
  // The most common real outcome: nothing relevant. It must still be an entry, because
  // "retrieval ran and found nothing" and "retrieval never ran" look identical otherwise.
  emitRetrieval({
    runId: 'r1',
    commentId: 'c1',
    retrieval: aRetrieval({ status: 'NO_RESULTS', results: [], code: 'NO_RELEVANT_KNOWLEDGE', reason: 'nothing' })
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.RETRIEVAL);
  if (!entry) return 'no entry for an empty retrieval';
  if (entry.data.resultCount !== 0) return `resultCount=${entry.data.resultCount}`;
  if (entry.data.code !== 'NO_RELEVANT_KNOWLEDGE') return `code=${entry.data.code}`;
  return true;
}

async function testRetrievalEmitsNothingWhenNotEnabled() {
  // At the default verbosity the whole point of the DEBUG level is that it is dropped.
  // It must be dropped BY THE ENGINE, not by a filter in the emitter: the entry still
  // has to exist at VERBOSE.
  fresh('NORMAL');
  emitRetrieval({ runId: 'r1', commentId: 'c1', retrieval: aRetrieval() });
  if (entriesFor(KNOWLEDGE_EVENT.RETRIEVAL).length !== 0) {
    return 'a DEBUG entry leaked at NORMAL verbosity';
  }

  fresh('VERBOSE');
  emitRetrieval({ runId: 'r1', commentId: 'c1', retrieval: aRetrieval() });
  if (entriesFor(KNOWLEDGE_EVENT.RETRIEVAL).length !== 1) {
    return 'the same event did not appear at VERBOSE';
  }
  return true;
}

// ─── Answerability ──────────────────────────────────────────────────────────────

async function testAnswerabilityReportsVerdictAndConfidence() {
  fresh();
  emitAnswerability({
    runId: 'r1',
    commentId: 'c1',
    gate: { status: 'CAN_ANSWER', confidence: 0.82, evidence: ['EV-1'], code: '', reason: 'stated' }
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.ANSWERABILITY);
  if (!entry) return 'no entry';
  if (entry.data.status !== 'CAN_ANSWER') return `status=${entry.data.status}`;
  if (entry.data.confidence !== 0.82) return `confidence=${entry.data.confidence}`;
  if (entry.data.evidenceCount !== 1) return `evidenceCount=${entry.data.evidenceCount}`;
  return true;
}

async function testAnswerabilityRecordsNullWhenConfidenceIsAbsent() {
  // 20.7's decision: confidence is recorded and never gated on. An absent one must be
  // `null`, not 0 — a zero would read as "the model was certain of nothing".
  fresh();
  emitAnswerability({ runId: 'r1', commentId: 'c1', gate: { status: 'NO_SUPPORTED_ANSWER', evidence: [] } });
  const [entry] = entriesFor(KNOWLEDGE_EVENT.ANSWERABILITY);
  if (entry.data.confidence !== null) return `confidence=${entry.data.confidence}, expected null`;
  if (entry.data.evidenceCount !== 0) return 'a non-approval must report zero evidence';
  return true;
}

// ─── Evidence ───────────────────────────────────────────────────────────────────

async function testEvidenceNamesTheFileAndHeading() {
  fresh();
  emitEvidence({
    runId: 'r1',
    commentId: 'c1',
    evidence: ['EV-1'],
    results: [
      { evidenceId: 'EV-1', documentId: 'd1', filename: 'books/chemistry.md', headingPath: ['كيمياء', 'السعر'] }
    ]
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.EVIDENCE);
  if (!entry) return 'no entry';
  const [source] = entry.data.sources || [];
  // The ids alone are opaque; the filename and heading are what a user needs.
  if (!source) return 'no source';
  if (source.filename !== 'books/chemistry.md') return `filename=${source.filename}`;
  if (source.headingPath !== 'كيمياء > السعر') return `headingPath=${source.headingPath}`;
  return true;
}

async function testEvidenceCarriesNoSectionContent() {
  // The bodies are already reachable from the index. Copying them into a 500-entry
  // in-memory ring buffer on every comment would widen where a reply's supporting
  // material can be found for no diagnostic gain.
  fresh();
  emitEvidence({
    runId: 'r1',
    commentId: 'c1',
    evidence: ['EV-1'],
    results: [
      {
        evidenceId: 'EV-1',
        documentId: 'd1',
        filename: 'books/chemistry.md',
        headingPath: ['السعر'],
        content: 'السعر الحالي: 350 جنيه.',
        searchText: 'السعر 350'
      }
    ]
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.EVIDENCE);
  const serialized = JSON.stringify(entry.data);
  if (serialized.includes('350')) return 'the section body leaked into the event';
  if (serialized.includes('searchText')) return 'searchText leaked into the event';
  return true;
}

async function testEvidenceResolvesThroughTheSuppliedResults() {
  // Deliberately a DIFFERENT id in `results` than in `evidence`. If the emitter resolved
  // against the index or guessed, it would invent a source; an unresolved id must stay
  // nameless rather than borrow another section's filename.
  fresh();
  emitEvidence({
    runId: 'r1',
    commentId: 'c1',
    evidence: ['EV-MISSING'],
    results: [{ evidenceId: 'EV-1', filename: 'books/chemistry.md', headingPath: ['السعر'] }]
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.EVIDENCE);
  const [source] = entry.data.sources || [];
  if (!source) return 'the approved id must still be reported';
  if (source.filename !== '') return `filename=${source.filename}, expected empty for an unresolved id`;
  return true;
}

async function testEvidenceIdListsAreCappedAndReportTheDrop() {
  fresh();
  const evidence = Array.from({ length: 20 }, (_, i) => `EV-${i}`);
  emitEvidence({
    runId: 'r1',
    commentId: 'c1',
    evidence,
    results: evidence.map((id) => ({ evidenceId: id, filename: `${id}.md`, headingPath: ['H'] }))
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.EVIDENCE);
  // The exact count stays exact; only the LIST is capped, and the truncation is recorded.
  // A silent cap would read as "there were only eight".
  if (entry.data.evidenceCount !== 20) return `evidenceCount=${entry.data.evidenceCount}`;
  if (entry.data.evidenceIds.length !== 8) return `capped=${entry.data.evidenceIds.length}`;
  if (entry.data.idsDropped !== 12) return `idsDropped=${entry.data.idsDropped}`;
  return true;
}

// ─── Grounding ──────────────────────────────────────────────────────────────────

async function testGroundingLogsTheAttemptHistory() {
  fresh();
  emitGrounding({
    runId: 'r1',
    commentId: 'c1',
    generated: {
      status: 'REJECTED',
      attempts: 2,
      code: 'GROUNDING_VALIDATION_FAILED',
      reason: 'the knowledge does not state the number 999',
      history: [
        { attempt: 1, outcome: 'REJECTED', layer: 'deterministic', code: 'GROUNDING_VALIDATION_FAILED', reply: 'سعر 999' },
        { attempt: 2, outcome: 'REJECTED', layer: 'deterministic', code: 'GROUNDING_VALIDATION_FAILED', reply: 'سعر 888' }
      ]
    }
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.GROUNDING);
  if (!entry) return 'no entry';
  if (entry.data.attempts !== 2) return `attempts=${entry.data.attempts}`;
  if (entry.data.history.length !== 2) return `history=${entry.data.history.length}`;
  if (entry.data.history[0].layer !== 'deterministic') return 'the layer is missing';
  return true;
}

async function testGroundingCarriesTheRejectedReplyAsAVerbosePreview() {
  // The rejected text is the one thing that cannot be recovered from anywhere else: it
  // was never published and never reached the activity log. It is carried as `preview`,
  // which dev-log gates behind VERBOSE.
  fresh('VERBOSE');
  emitGrounding({
    runId: 'r1',
    commentId: 'c1',
    generated: {
      status: 'REJECTED',
      attempts: 1,
      history: [{ attempt: 1, outcome: 'REJECTED', reply: 'سعر الكتاب 999 جنيه' }]
    }
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.GROUNDING);
  if (typeof entry.data.preview !== 'string' || !entry.data.preview) {
    return 'the rejected reply must be reported as a preview';
  }
  return true;
}

async function testGroundingDoesNotDuplicateAPublishedReply() {
  // A published reply's text is already recorded by the activity log. Repeating it in
  // the diagnostics buffer would add nothing and widen where a reply's text can be found.
  fresh('VERBOSE');
  emitGrounding({
    runId: 'r1',
    commentId: 'c1',
    generated: {
      status: 'PUBLISHABLE',
      attempts: 1,
      reply: 'سعر الكتاب 350 جنيه',
      history: [{ attempt: 1, outcome: 'SUPPORTED', reply: 'سعر الكتاب 350 جنيه' }]
    }
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.GROUNDING);
  if (entry.data.preview) return `a published reply was duplicated: "${entry.data.preview}"`;
  return true;
}

async function testGroundingLevelFollowsTheOutcome() {
  // A rejection is a rare, actionable fault and must be visible at the default
  // verbosity; an accepted reply is not news.
  fresh('NORMAL');
  emitGrounding({ runId: 'r1', commentId: 'c1', generated: { status: 'PUBLISHABLE', attempts: 1 } });
  if (entriesFor(KNOWLEDGE_EVENT.GROUNDING).length !== 0) {
    return 'an accepted reply should not appear at NORMAL verbosity';
  }

  fresh('NORMAL');
  emitGrounding({ runId: 'r1', commentId: 'c1', generated: { status: 'REJECTED', attempts: 1, code: 'X' } });
  if (entriesFor(KNOWLEDGE_EVENT.GROUNDING).length !== 1) {
    return 'a grounding rejection must be visible at NORMAL verbosity';
  }
  return true;
}

async function testGroundingHistoryIsCappedAtTheHardCeiling() {
  fresh();
  const history = Array.from({ length: 12 }, (_, i) => ({ attempt: i + 1, outcome: 'REJECTED' }));
  emitGrounding({ runId: 'r1', commentId: 'c1', generated: { status: 'REJECTED', attempts: 12, history } });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.GROUNDING);
  if (entry.data.history.length !== 3) return `history=${entry.data.history.length}, expected the cap of 3`;
  if (entry.data.attemptCount !== 12) return `attemptCount=${entry.data.attemptCount}`;
  if (entry.data.attemptsDropped !== 9) return `attemptsDropped=${entry.data.attemptsDropped}`;
  return true;
}

// ─── Skips ──────────────────────────────────────────────────────────────────────

async function testSkipCarriesItsCategoryFromTheSchemaOwner() {
  fresh();
  emitSkip({ runId: 'r1', commentId: 'c1', code: 'NO_SUPPORTED_ANSWER', reason: 'no duration stated' });
  emitSkip({ runId: 'r1', commentId: 'c1', code: 'GROUNDING_VALIDATION_FAILED' });

  const [decline, fault] = entriesFor(KNOWLEDGE_EVENT.SKIP);
  if (!decline || !fault) return 'both skips must be reported';

  // The same classification the Side Panel tints with and the counters bucket by. A
  // second derivation here would be a third place for the two to disagree.
  if (decline.data.expected !== true) return 'NO_SUPPORTED_ANSWER must be expected';
  if (decline.data.category !== 'expected_skip') return `category=${decline.data.category}`;
  if (fault.data.expected !== false) return 'a grounding rejection must not be expected';
  if (fault.data.category !== 'safety') return `category=${fault.data.category}`;
  return true;
}

async function testSkipIsVisibleAtTheDefaultVerbosity() {
  // "Why was nothing answered" is the question a user opens diagnostics to ask, so this
  // must NOT be DEBUG-gated the way the per-stage forensics are.
  fresh('NORMAL');
  emitSkip({ runId: 'r1', commentId: 'c1', code: 'NO_RELEVANT_KNOWLEDGE' });
  if (entriesFor(KNOWLEDGE_EVENT.SKIP).length !== 1) {
    return 'a skip must be visible at NORMAL verbosity';
  }
  return true;
}

async function testSkipWithAnUnknownCodeIsStillReported() {
  // A code outside §32's vocabulary is a bug, but a LOST event is a worse bug: this must
  // still produce an entry so the anomaly is visible.
  fresh();
  emitSkip({ runId: 'r1', commentId: 'c1', code: 'SOMETHING_NEW' });
  const [entry] = entriesFor(KNOWLEDGE_EVENT.SKIP);
  if (!entry) return 'an unknown code must not silently drop the event';
  // categoriseKnowledgeError defaults an unknown code to SYSTEM rather than throwing.
  if (entry.data.expected !== false) return 'an unknown code must not read as an expected skip';
  return true;
}

// ─── Conflicts ──────────────────────────────────────────────────────────────────

async function testBlockingConflictNamesBothDocumentsAndHowToFixIt() {
  fresh();
  const audit = auditKnowledgeConflicts([
    { documentId: 'a', filename: 'old.md', headingPath: ['السعر'], content: 'السعر 350', priority: 0, version: 1, enabled: true },
    { documentId: 'b', filename: 'new.md', headingPath: ['السعر'], content: 'السعر 400', priority: 0, version: 1, enabled: true }
  ]);

  const written = emitConflicts({ runId: 'r2', audit });
  if (written !== 1) return `written=${written}, expected 1`;

  const [entry] = entriesFor(KNOWLEDGE_EVENT.CONFLICT);
  if (!entry) return 'no entry';
  if (entry.data.severity !== 'blocking') return `severity=${entry.data.severity}`;

  // The one event a user most needs complete: which TWO files disagree.
  const names = (entry.data.documents || []).map((d) => d.filename).sort();
  if (names.join(',') !== 'new.md,old.md') return `documents=${names.join(',')}`;
  // And what to DO about it, since renaming does not decide a conflict.
  if (!Array.isArray(entry.data.resolutions) || entry.data.resolutions.length === 0) {
    return 'a blocking conflict must carry its resolution steps';
  }
  return true;
}

async function testShadowedConflictIsNotFiledAsBlocking() {
  fresh();
  // Same heading, same content: agreement, but the older document is never reached.
  // 20.12 puts this in `shadowed`, and conflating the two would tell a user to "fix"
  // something that is already correct.
  const audit = auditKnowledgeConflicts([
    { documentId: 'a', filename: 'old.md', headingPath: ['السعر'], content: 'السعر 350', priority: 0, version: 1, enabled: true },
    { documentId: 'b', filename: 'new.md', headingPath: ['السعر'], content: 'السعر 350', priority: 5, version: 1, enabled: true }
  ]);

  emitConflicts({ runId: 'r2', audit });
  const entries = entriesFor(KNOWLEDGE_EVENT.CONFLICT);
  if (entries.length !== 1) return `entries=${entries.length}`;

  const d = entries[0].data;
  if (d.severity === 'blocking') return 'an agreement must never be reported as blocking';
  if (!d.filename) return 'the shadowed document must be named';
  if (!d.winner) return 'the winning document must be named';
  return true;
}

async function testACleanBaseEmitsNoConflictEvents() {
  fresh();
  const audit = auditKnowledgeConflicts([
    { documentId: 'a', filename: 'one.md', headingPath: ['السعر'], content: '350', priority: 0, version: 1, enabled: true },
    { documentId: 'b', filename: 'two.md', headingPath: ['الشحن'], content: 'يومان', priority: 0, version: 1, enabled: true }
  ]);

  const written = emitConflicts({ runId: 'r2', audit });
  if (written !== 0) return `a clean base wrote ${written} events`;
  if (entriesFor(KNOWLEDGE_EVENT.CONFLICT).length !== 0) return 'events leaked for a clean base';
  return true;
}

async function testConflictEventsAreCapped() {
  fresh();
  // Enough equal-authority contradictions to exceed the per-log cap.
  const sections = [];
  for (let i = 0; i < 30; i++) {
    sections.push({ documentId: `d${i}`, filename: `f${i}.md`, headingPath: ['H'], content: `value ${i}`, priority: 0, version: 1, enabled: true });
  }
  const audit = auditKnowledgeConflicts(sections);
  emitConflicts({ runId: 'r2', audit });

  const entries = entriesFor(KNOWLEDGE_EVENT.CONFLICT);
  // The buffer holds 500 entries and nothing is persisted: one pathological base must
  // not evict the surrounding context of everything that follows it.
  if (entries.length > 20) return `emitted ${entries.length}, expected the cap of 20`;
  if (entries.length === 0) return 'nothing was emitted';
  if (entries[entries.length - 1].data.truncated !== true) return 'truncation must be recorded, not silent';
  return true;
}

// ─── Robustness ────────────────────────────────────────────────────────────────

async function testEmittersNeverThrow() {
  fresh();
  // Every emitter is called on the reply path, so a malformed input must degrade to a
  // missing entry. The calls below are the ones a bad caller could realistically make.
  const bad = [undefined, null, {}, { runId: 1 }, { retrieval: 'not-an-object' }, { gate: 7 }, { evidence: 'x' }, { generated: [] }];
  for (const args of bad) {
    emitRetrieval(args);
    emitAnswerability(args);
    emitEvidence(args);
    emitGrounding(args);
    emitSkip(args);
    emitConflicts(args);
    emitReplyGenerated(args);
  }
  return true;
}

async function testEmittersReturnFalseWithoutAnEngine() {
  // The classic content scripts load dev-log.js as a plain script, so a module-context
  // caller can run before the engine exists. Losing an entry is acceptable; throwing is
  // not.
  const real = globalThis.YTAR_DEVLOG;
  globalThis.YTAR_DEVLOG = undefined;
  try {
    const wrote = emitSkip({ runId: 'r1', commentId: 'c1', code: 'NO_SUPPORTED_ANSWER' });
    if (wrote !== false) return `expected false without an engine, got ${wrote}`;
  } finally {
    globalThis.YTAR_DEVLOG = real;
  }
  return true;
}

async function testLevelMapCoversEveryEvent() {
  // The level table is the decision that makes a skip visible at the default verbosity
  // and a retrieval report verbose-only. A missing entry silently changes it.
  const levels = Object.values(KNOWLEDGE_DIAG_LEVEL);
  for (const level of levels) {
    if (!['debug', 'info', 'warn'].includes(level)) return `unexpected level "${level}"`;
  }
  if (KNOWLEDGE_DIAG_LEVEL.SKIP !== 'info') return 'a skip must be INFO';
  if (KNOWLEDGE_DIAG_LEVEL.REPLY_GENERATED !== 'info') return 'the run outcome must be INFO';
  if (KNOWLEDGE_DIAG_LEVEL.CONFLICT !== 'warn') return 'a conflict must be WARN';
  if (KNOWLEDGE_DIAG_LEVEL.RETRIEVAL !== 'debug') return 'retrieval detail must be DEBUG';
  return true;
}

async function testEveryEventCarriesCorrelationFields() {
  fresh();
  // §20.19's events are only actionable if they can be tied back to the run. A missing
  // correlation field makes an entry unattributable, which is the whole problem the
  // run ids exist to solve.
  emitRetrieval({ runId: 'r1', commentId: 'c1', retrieval: aRetrieval() });
  emitAnswerability({ runId: 'r1', commentId: 'c1', gate: { status: 'CAN_ANSWER', evidence: [] } });
  emitEvidence({ runId: 'r1', commentId: 'c1', evidence: [], results: [] });
  emitGrounding({ runId: 'r1', commentId: 'c1', generated: { status: 'PUBLISHABLE' } });
  emitSkip({ runId: 'r1', commentId: 'c1', code: 'NO_SUPPORTED_ANSWER' });
  emitReplyGenerated({ runId: 'r1', commentId: 'c1', result: {} });

  const entries = DEVLOG.getEntries();
  if (entries.length < 6) return `only ${entries.length} entries`;
  for (const entry of entries) {
    if (entry.runId !== 'r1') return `${entry.event} lost its runId`;
    if (entry.commentId !== 'c1') return `${entry.event} lost its commentId`;
  }
  return true;
}

async function testAnIndexLevelEventCarriesARunButNoComment() {
  // The conflict audit is not per-comment. An empty commentId is correct there and must
  // not be treated as a defect — but the entry still has to exist.
  fresh();
  emitConflicts({
    runId: 'r9',
    audit: {
      documentCount: 2,
      hasBlockingConflicts: true,
      conflicts: [
        {
          severity: 'blocking',
          heading: 'السعر',
          reason: 'they disagree',
          documents: [{ id: 'a', filename: 'old.md', priority: 0, version: 1, updatedAt: 0, enabled: true }],
          resolutions: ['raise a priority']
        }
      ],
      shadowed: []
    }
  });

  const [entry] = entriesFor(KNOWLEDGE_EVENT.CONFLICT);
  if (!entry) return 'no entry';
  if (entry.runId !== 'r9') return `runId=${entry.runId}`;
  // Falsy rather than strictly '': dev-log drops empty correlation fields, so an
  // index-level entry legitimately has no commentId property at all.
  if (entry.commentId) return `an index-level event must not invent a commentId (got ${entry.commentId})`;
  return true;
}

export default async function runAllTests() {
  fresh();

  console.log('\n--- Vocabulary ---');
  await runTest('Every event is declared in the frozen set', testEveryEventIsNamedInTheFrozenSet);
  await runTest('Event names are unique', testEventNamesAreUnique);
  await runTest('The level map covers every event', testLevelMapCoversEveryEvent);

  console.log('\n--- Retrieval ---');
  await runTest('Retrieval reports counts and ids', testRetrievalReportsCountsAndIds);
  await runTest('Retrieval is correlated by run and comment', testRetrievalIsCorrelatedByRunAndComment);
  await runTest('An empty retrieval is still reported', testRetrievalSurvivesAnEmptyResult);
  await runTest('Debug detail is gated by the engine, not the emitter', testRetrievalEmitsNothingWhenNotEnabled);

  console.log('\n--- Answerability ---');
  await runTest('Answerability reports verdict and confidence', testAnswerabilityReportsVerdictAndConfidence);
  await runTest('An absent confidence is null, not zero', testAnswerabilityRecordsNullWhenConfidenceIsAbsent);

  console.log('\n--- Evidence ---');
  await runTest('Evidence names the file and heading', testEvidenceNamesTheFileAndHeading);
  await runTest('Evidence carries no section content', testEvidenceCarriesNoSectionContent);
  await runTest('An unresolved id stays nameless', testEvidenceResolvesThroughTheSuppliedResults);
  await runTest('Id lists are capped and the drop is reported', testEvidenceIdListsAreCappedAndReportTheDrop);

  console.log('\n--- Grounding validation ---');
  await runTest('Grounding logs the attempt history', testGroundingLogsTheAttemptHistory);
  await runTest('A rejected reply is carried as a preview', testGroundingCarriesTheRejectedReplyAsAVerbosePreview);
  await runTest('A published reply is not duplicated', testGroundingDoesNotDuplicateAPublishedReply);
  await runTest('The level follows the outcome', testGroundingLevelFollowsTheOutcome);
  await runTest('History is capped and reports the drop', testGroundingHistoryIsCappedAtTheHardCeiling);

  console.log('\n--- Skips ---');
  await runTest('A skip carries its category from the owner', testSkipCarriesItsCategoryFromTheSchemaOwner);
  await runTest('A skip is visible at the default verbosity', testSkipIsVisibleAtTheDefaultVerbosity);
  await runTest('An unknown code still produces an entry', testSkipWithAnUnknownCodeIsStillReported);

  console.log('\n--- Conflicts ---');
  await runTest('A blocking conflict names both documents and the fix', testBlockingConflictNamesBothDocumentsAndHowToFixIt);
  await runTest('A shadowed conflict is not filed as blocking', testShadowedConflictIsNotFiledAsBlocking);
  await runTest('A clean base emits nothing', testACleanBaseEmitsNoConflictEvents);
  await runTest('Conflict events are capped and report truncation', testConflictEventsAreCapped);

  console.log('\n--- Robustness ---');
  await runTest('The emitters never throw', testEmittersNeverThrow);
  await runTest('No engine means false, not an exception', testEmittersReturnFalseWithoutAnEngine);
  await runTest('Every event carries correlation fields', testEveryEventCarriesCorrelationFields);
  await runTest('An index-level event has a run but no comment', testAnIndexLevelEventCarriesARunButNoComment);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}