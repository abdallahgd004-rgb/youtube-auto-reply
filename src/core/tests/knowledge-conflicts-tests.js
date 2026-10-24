/**
 * Knowledge Conflicts Tests — Phase 20.12
 *
 * §18 asks for conflicts to be handled EXPLICITLY. Two halves of that are tested here:
 *
 *   1. The gate's per-comment decision (delegated to this module's `resolveSectionConflict`),
 *      which 20.7 already depends on — re-tested here because the ownership MOVED, and a
 *      move with no test on the new side would let the shared rule rot unnoticed.
 *   2. The base-wide audit, which is what actually makes a conflict explicit. A gate that
 *      silently skips a comment leaves the user with a base that "sometimes doesn't reply" and
 *      no way to learn why.
 *
 * The rule under test is deliberately narrow, so the "is NOT a conflict" cases get as much
 * attention as the positive ones: a base with a backup copy of a price file must not light up
 * as broken, and a user with a well-organised set of subject files must not see a wall of
 * conflicts.
 *
 * Runs in the browser from knowledge-conflicts-tests.html. No chrome stub and no model: §18
 * forbids the model choosing between conflicting documents "based on intuition", so there is
 * nothing here for one to do.
 */

import {
  auditKnowledgeConflicts,
  resolveSectionConflict,
  groupSectionsByDocument,
  findDisagreement,
  buildResolutionSteps,
  headingOf,
  CONFLICT_SEVERITY,
  MAX_REPORTED_CONFLICTS
} from '../knowledge-conflicts.js';

import { detectConflict } from '../answerability-gate.js';

const results = { total: 0, passed: 0, failed: 0 };

async function runTest(name, fn) {
  results.total++;
  try {
    const ok = await fn();
    if (ok === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: ${ok}`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

const equalAuthority = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });

/** A section as the index produces it. */
function section(document, heading, content, overrides = {}) {
  return {
    evidenceId: `EV-${document.id}-${heading}`,
    documentId: document.id,
    filename: document.filename,
    headingPath: heading.split(' / '),
    content,
    document,
    ...overrides
  };
}

// ─── §38 Test 5 ───────────────────────────────────────────────────────────────

async function testTheSpecExampleIsBlocking() {
  // §38 Test 5: chemistry-old.md says 350, chemistry-2027.md says 370.
  const old = equalAuthority('doc-old', 'chemistry-old.md');
  const fresh = equalAuthority('doc-new', 'chemistry-2027.md');

  const audit = auditKnowledgeConflicts([
    section(old, 'السعر', 'السعر 350 جنيه.'),
    section(fresh, 'السعر', 'السعر 370 جنيه.')
  ]);

  if (!audit.hasBlockingConflicts) return 'the spec example was not reported as blocking';
  if (audit.conflicts.length !== 1) return `${audit.conflicts.length} conflicts reported`;

  const conflict = audit.conflicts[0];
  if (conflict.severity !== CONFLICT_SEVERITY.BLOCKING) return `severity was ${conflict.severity}`;
  if (conflict.heading !== 'السعر') return `heading was ${conflict.heading}`;
  if (conflict.documents.length !== 2) return `${conflict.documents.length} documents listed`;
  if (!conflict.reason.includes('chemistry-old.md') || !conflict.reason.includes('chemistry-2027.md')) {
    return `reason did not name both files: ${conflict.reason}`;
  }
  if (conflict.resolutions.length === 0) return 'no resolution steps were offered';
  return true;
}

async function testTheGateAndTheAuditAgree() {
  // The gate decides per comment and the audit decides base-wide. They MUST come from the same
  // rule, or a user fixes a conflict the gate still disagrees with.
  const a = equalAuthority('doc-a', 'a.md');
  const b = equalAuthority('doc-b', 'b.md');
  const sections = [
    section(a, 'السعر', '350'),
    section(b, 'السعر', '370')
  ];

  const gate = detectConflict(sections);
  const shared = resolveSectionConflict(sections);

  if (gate.conflicting !== shared.conflicting) return `gate said ${gate.conflicting}, shared said ${shared.conflicting}`;
  if (!gate.conflicting) return 'both said there was no conflict';
  if (gate.reason !== shared.reason) return `reasons differ: ${gate.reason} vs ${shared.reason}`;

  const audit = auditKnowledgeConflicts(sections);
  if (!audit.hasBlockingConflicts) return 'the audit disagreed with the shared rule';
  return true;
}

async function testTheGateStillShortCircuitsTheModel() {
  // §18 forbids the model resolving a conflict, and the gate must keep spending no request on
  // one — the shared rule did not move that.
  let called = false;
  const a = equalAuthority('doc-a', 'a.md');
  const b = equalAuthority('doc-b', 'b.md');
  const outcome = await import('../answerability-gate.js').then(({ checkAnswerability }) =>
    checkAnswerability({
      commentText: 'x',
      results: [
        { ...section(a, 'السعر', '350'), content: '350' },
        { ...section(b, 'السعر', '370'), content: '370' }
      ],
      complete: async () => { called = true; return { text: '{"canAnswer":true}' }; }
    })
  );

  if (called) return 'a conflict was put to the model';
  if (outcome.status !== 'CONFLICTING_KNOWLEDGE') return `status was ${outcome.status}`;
  return true;
}

// ─── The narrowness rule ───────────────────────────────────────────────────────

async function testDocumentsThatAgreeAreNotAConflict() {
  // A backup copy of a price file disagrees about nothing. Reporting it would train the user
  // to ignore the audit.
  const audit = auditKnowledgeConflicts([
    section(equalAuthority('doc-a', 'books.md'), 'السعر', 'السعر 350 جنيه.'),
    section(equalAuthority('doc-b', 'backup.md'), 'السعر', 'السعر 350 جنيه.')
  ]);

  if (audit.hasBlockingConflicts) return `agreement was reported as a conflict: ${audit.conflicts[0].reason}`;
  return true;
}

async function testDifferentSubjectsAreNotAConflict() {
  const audit = auditKnowledgeConflicts([
    section(equalAuthority('doc-a', 'books.md'), 'السعر', '350'),
    section(equalAuthority('doc-b', 'policies.md'), 'سياسة الإرجاع', 'يُرجع خلال أسبوعين.')
  ]);
  if (audit.hasBlockingConflicts) return `different subjects were reported as a conflict`;
  return true;
}

async function testADisabledDocumentIsNotAConflict() {
  // Out of scope, not contradictory. Mixing disabled files in would make any base with one
  // switched-off document look broken.
  const audit = auditKnowledgeConflicts([
    section(equalAuthority('doc-a', 'current.md'), 'السعر', '350'),
    section({ id: 'doc-off', filename: 'old.md', enabled: false, priority: 0, version: 1, updatedAt: 1000 }, 'السعر', '999')
  ]);

  if (audit.hasBlockingConflicts) return 'a disabled document was treated as contradictory';
  if (audit.documentCount !== 1) return `documentCount was ${audit.documentCount}`;
  return true;
}

async function testOneDocumentIsNeverAConflict() {
  const audit = auditKnowledgeConflicts([
    section(equalAuthority('doc-a', 'books.md'), 'السعر', '350'),
    section(equalAuthority('doc-a', 'books.md'), 'التغطية', 'يغطي التفوق.')
  ]);
  if (audit.hasBlockingConflicts) return 'one file was reported as conflicting with itself';
  if (audit.documentCount !== 1) return `documentCount was ${audit.documentCount}`;
  return true;
}

// ─── §18's resolution mechanisms ───────────────────────────────────────────────

async function testPriorityResolvesAConflict() {
  const low = { id: 'doc-low', filename: 'general.md', enabled: true, priority: 0, version: 1, updatedAt: 1000 };
  const high = { id: 'doc-high', filename: 'current.md', enabled: true, priority: 10, version: 1, updatedAt: 1000 };

  const audit = auditKnowledgeConflicts([
    section(low, 'السعر', '350'),
    section(high, 'السعر', '370')
  ]);

  if (audit.hasBlockingConflicts) return `a decided conflict was reported as blocking: ${audit.conflicts[0]?.reason}`;
  if (audit.shadowed.length !== 1) return `${audit.shadowed.length} shadowed documents reported`;
  if (audit.shadowed[0].filename !== 'general.md') return `shadowed the wrong file: ${audit.shadowed[0].filename}`;
  return true;
}

async function testVersionResolvesAConflict() {
  const older = { id: 'doc-a', filename: 'v1.md', enabled: true, priority: 0, version: 1, updatedAt: 1000 };
  const newer = { id: 'doc-b', filename: 'v2.md', enabled: true, priority: 0, version: 2, updatedAt: 1000 };

  const audit = auditKnowledgeConflicts([
    section(older, 'السعر', '350'),
    section(newer, 'السعر', '370')
  ]);
  if (audit.hasBlockingConflicts) return 'a higher version did not supersede';
  return true;
}

async function testUpdatedAtResolvesAConflict() {
  const older = { id: 'doc-a', filename: 'a.md', enabled: true, priority: 0, version: 1, updatedAt: 1000 };
  const newer = { id: 'doc-b', filename: 'b.md', enabled: true, priority: 0, version: 1, updatedAt: 5000 };

  const audit = auditKnowledgeConflicts([
    section(older, 'السعر', '350'),
    section(newer, 'السعر', '370')
  ]);
  if (audit.hasBlockingConflicts) return 'the more recently edited document did not win';
  return true;
}

async function testShadowedIsNotReportedAsBlocking() {
  // The two severities must never be confused: a shadowed file needs no urgent action and a
  // blocking one does, and a user who cannot tell them apart learns to ignore the audit.
  const shadowing = { id: 'doc-hi', filename: 'new.md', enabled: true, priority: 5, version: 1, updatedAt: 1000 };
  const shadowed = { id: 'doc-lo', filename: 'old.md', enabled: true, priority: 0, version: 1, updatedAt: 1000 };

  const audit = auditKnowledgeConflicts([
    section(shadowed, 'السعر', '350'),
    section(shadowing, 'السعر', '370')
  ]);

  if (audit.conflicts.length !== 0) return `${audit.conflicts.length} blocking conflicts`;
  if (audit.shadowed.length !== 1) return `${audit.shadowed.length} shadowed`;
  if (audit.shadowed[0].filename !== 'old.md') return `shadowed ${audit.shadowed[0].filename}`;
  if (audit.shadowed[0].winner !== 'new.md') return `winner was ${audit.shadowed[0].winner}`;
  return true;
}

async function testResolutionStepsAreConcrete() {
  // §18's resolution is the user's to make, so the audit has to say what equal authority
  // MEANS in practice rather than restating the diagnosis.
  const steps = buildResolutionSteps([
    { id: 'a', filename: 'a.md' },
    { id: 'b', filename: 'b.md' }
  ]);

  if (steps.length === 0) return 'no steps offered';
  const joined = steps.join(' ').toLowerCase();
  for (const word of ['priority', 'version', 'disable']) {
    if (!joined.includes(word)) return `the steps never mention ${word}`;
  }
  if (!joined.includes('a.md') || !joined.includes('b.md')) return 'the steps do not name the files';
  if (buildResolutionSteps([{ id: 'a', filename: 'a.md' }]).length !== 0) return 'a single document produced steps';
  return true;
}

async function testResolutionStepsSayWhatDoesNotCount() {
  // Renaming or re-saving is the reflex, and it does NOT decide anything. Saying so saves a
  // user from editing a filename and assuming the problem is fixed.
  const steps = buildResolutionSteps([{ id: 'a', filename: 'a.md' }, { id: 'b', filename: 'b.md' }]).join(' ');
  if (!/renaming or re-saving does not decide/i.test(steps)) return 'the steps do not say what does not count';
  return true;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function testHeadingKeysMatch() {
  // The heading key is what decides whether two documents are talking about the same thing, so
  // its derivation is part of the contract rather than an implementation detail.
  if (headingOf({ headingPath: ['كيمياء', 'السعر'] }) !== 'كيمياء / السعر') return 'nested headings were joined wrong';
  if (headingOf({ heading: 'Shipping' }) !== 'Shipping') return 'a flat heading was ignored';
  if (headingOf({}) !== '(no heading)') return 'a section with no heading did not fall back';
  if (headingOf(null) !== '(no heading)') return 'null did not fall back';
  return true;
}

async function testDisagreementNeedsBothHeadingAndDifference() {
  const one = [section(equalAuthority('a', 'a.md'), 'السعر', '350')];

  if (findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'التغطية', 'x')])) {
    return 'different headings were reported as disagreeing';
  }
  if (findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'السعر', '350')])) {
    return 'identical content was reported as disagreeing';
  }
  if (!findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'السعر', '370')])) {
    return 'a real difference was not found';
  }
  // Whitespace-only differences are AGREEMENT: trimming both sides is right, because "350 "
  // and "350" are the same claim, and treating them as contradictory would fill the audit with
  // conflicts that mean nothing.
  if (findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'السعر', '  350  ')])) {
    return 'a whitespace-only difference was reported as a contradiction';
  }
  // But a change of WORDS is a contradiction even when the digits match — which is exactly
  // the case a numbers-only check would miss, and the reason content is compared verbatim.
  if (!findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'السعر', '350 دولار')])) {
    return 'a different unit of currency was not reported as a contradiction';
  }
  if (!findDisagreement(one, [section(equalAuthority('b', 'b.md'), 'السعر', '350 but out of stock')])) {
    return 'an extra claim under the same heading was not reported';
  }
  return true;
}

async function testGroupingIsTotal() {
  for (const input of [null, undefined, [], 42, 'x', [null, undefined, {}], [[]]]) {
    const groups = groupSectionsByDocument(input);
    if (!Array.isArray(groups)) return `groupSectionsByDocument(${JSON.stringify(input)}) threw`;
  }

  // A section with no document id cannot belong to a document, so it is dropped rather than
  // grouped under an empty key.
  const groups = groupSectionsByDocument([{ evidenceId: 'E', content: 'x', headingPath: [] }]);
  if (groups.length !== 0) return `${groups.length} groups from an unidentified section`;
  return true;
}

async function testAuditingIsTotal() {
  for (const input of [null, undefined, [], 42, 'x', {}, [null], [{ documentId: '' }]]) {
    const audit = auditKnowledgeConflicts(input);
    if (!audit || !Array.isArray(audit.conflicts) || !Array.isArray(audit.shadowed)) {
      return `auditKnowledgeConflicts(${JSON.stringify(input)}) threw`;
    }
    if (typeof audit.hasBlockingConflicts !== 'boolean') return `hasBlockingConflicts missing for ${JSON.stringify(input)}`;
  }
  return true;
}

async function testConflictReportingIsBounded() {
  // A base of many mutually-contradicting files must not produce an unbounded payload for the
  // UI to render.
  const sections = [];
  for (let i = 0; i < MAX_REPORTED_CONFLICTS + 20; i++) {
    sections.push(section(equalAuthority(`doc-${i}`, `f${i}.md`), 'السعر', `price ${i}`));
  }

  const audit = auditKnowledgeConflicts(sections);
  if (audit.conflicts.length > MAX_REPORTED_CONFLICTS) return `${audit.conflicts.length} conflicts reported`;
  if (!audit.hasBlockingConflicts) return 'a massively contradictory base reported nothing';
  return true;
}

async function testManyDocumentsWithOneContradiction() {
  // The contradiction must be found even when it is not the first pair examined, and the rest
  // of the base must not be reported as conflicting with itself.
  const good = [];
  for (let i = 0; i < 12; i++) {
    good.push(section(equalAuthority(`ok-${i}`, `ok${i}.md`), `قسم ${i}`, `محتوى ${i}`));
  }

  const sections = [
    ...good,
    section(equalAuthority('doc-x', 'x.md'), 'السعر', '350'),
    section(equalAuthority('doc-y', 'y.md'), 'السعر', '370')
  ];

  const audit = auditKnowledgeConflicts(sections);
  if (audit.conflicts.length !== 1) return `${audit.conflicts.length} conflicts found`;
  if (audit.conflicts[0].heading !== 'السعر') return `heading was ${audit.conflicts[0].heading}`;
  return true;
}

async function testThreeWayConflictIsReportedOnce() {
  const sections = [
    section(equalAuthority('doc-a', 'a.md'), 'السعر', '350'),
    section(equalAuthority('doc-b', 'b.md'), 'السعر', '370'),
    section(equalAuthority('doc-c', 'c.md'), 'السعر', '390')
  ];
  const audit = auditKnowledgeConflicts(sections);

  // Three equal documents produce three pairs, all the same underlying problem. Reporting the
  // pair count rather than the document count is honest about what was compared, and the UI
  // dedupes by heading if it wants a single list.
  if (audit.conflicts.length !== 3) return `${audit.conflicts.length} pairs reported for 3 documents`;
  for (const conflict of audit.conflicts) {
    if (conflict.documents.length !== 2) return 'a pair listed three documents';
    if (conflict.severity !== CONFLICT_SEVERITY.BLOCKING) return `severity was ${conflict.severity}`;
  }
  return true;
}

async function testResolvingIsTotal() {
  for (const input of [null, undefined, [], 42, [null], [{ documentId: '' }]]) {
    const outcome = resolveSectionConflict(input);
    if (!outcome || typeof outcome.conflicting !== 'boolean') return `resolveSectionConflict(${JSON.stringify(input)}) threw`;
  }
  return true;
}

async function testTheAuditDoesNotDependOnIndexFreshness() {
  // The audit takes sections, not an index object, so it cannot check freshness — and must not
  // pretend to. A caller passing a stale index still gets a useful answer, which beats telling
  // a user their base is fine.
  const audit = auditKnowledgeConflicts([
    section(equalAuthority('doc-a', 'a.md'), 'السعر', '350'),
    section(equalAuthority('doc-b', 'b.md'), 'السعر', '370')
  ]);
  if ('retrievable' in audit || 'state' in audit) return 'the audit pretends to know index state';
  return true;
}


/**
 * ── Phase 20.19 regression: precedence must be READ, not assumed equal ──────────
 *
 * Every pre-existing case used sections with identical authority, so precedence always
 * came back ambiguous and the contradiction was always BLOCKING. That is exactly the path
 * §18's mechanisms exist to PREVENT, and it hid a live bug: the audit (and 20.7's gate,
 * which calls the same owner) synthesized its document objects from
 * `{id, filename, enabled}` and dropped the priority, version and edit time that were
 * sitting on every section. Two documents §18 ranks decisively were reported as "equal
 * authority", so comments about them were SKIPPED — and 20.12's own advice, "give one of
 * them a higher priority", could never fix it.
 */
const authoritySection = (id, filename, content, over) =>
  Object.assign(
    {
      documentId: id,
      filename,
      headingPath: ['السعر'],
      content,
      enabled: true,
      priority: 0,
      version: 1,
      updatedAt: 100
    },
    over || {}
  );

async function testHigherPriorityDecidesAContractAndShadowsTheLoser() {
  const audit = auditKnowledgeConflicts([
    authoritySection('old', 'old.md', 'السعر 350', { priority: 0, updatedAt: 100 }),
    authoritySection('new', 'new.md', 'السعر 400', { priority: 9, updatedAt: 200 })
  ]);

  if (audit.conflicts.length !== 0) {
    return `a decided contradiction must not be blocking, got ${audit.conflicts.length}`;
  }
  if (audit.shadowed.length !== 1) return `shadowed=${audit.shadowed.length}`;
  // The loser is named, which is the whole point: "my old price file is still there but
  // never used" is a real question that silence answers wrongly.
  if (audit.shadowed[0].filename !== 'old.md') return `loser=${audit.shadowed[0].filename}`;
  if (!audit.shadowed[0].winner) return 'the winning document must be named';
  return true;
}

async function testHigherVersionDecidesAContract() {
  const audit = auditKnowledgeConflicts([
    authoritySection('a', 'a.md', '350', { version: 1 }),
    authoritySection('b', 'b.md', '400', { version: 5 })
  ]);
  if (audit.conflicts.length !== 0) return `version must decide, got ${audit.conflicts.length} blocking`;
  if (audit.shadowed.length !== 1) return `shadowed=${audit.shadowed.length}`;
  return true;
}

async function testTheNewerFileDecidesAContract() {
  const audit = auditKnowledgeConflicts([
    authoritySection('a', 'a.md', '350', { updatedAt: 100 }),
    authoritySection('b', 'b.md', '400', { updatedAt: 900 })
  ]);
  if (audit.conflicts.length !== 0) return `updatedAt must decide, got ${audit.conflicts.length} blocking`;
  return true;
}

async function testEqualAuthorityIsStillBlocking() {
  // The counterpart, and the one the earlier cases could not distinguish: with authority
  // genuinely tied, §18 wants a skip and the audit must say so.
  const audit = auditKnowledgeConflicts([
    authoritySection('a', 'a.md', '350', { priority: 0, updatedAt: 100 }),
    authoritySection('b', 'b.md', '400', { priority: 0, updatedAt: 100 })
  ]);
  if (audit.conflicts.length !== 1) return `equal authority must block, got ${audit.conflicts.length}`;
  if (audit.shadowed.length !== 0) return 'an equal-authority pair must not be shadowed';
  return true;
}

async function testABackupCopyIsNeverBlocking() {
  // A user keeping an old copy of a price list is the most common shape of this, and it
  // must not make every price question unanswerable.
  const audit = auditKnowledgeConflicts([
    authoritySection('a', 'old.md', 'السعر 350', { priority: 0 }),
    authoritySection('b', 'new.md', 'السعر 350', { priority: 5 })
  ]);
  if (audit.conflicts.length !== 0) return 'identical content is agreement, not a conflict';
  if (audit.shadowed.length !== 1) return 'the unreachable copy should be reported as shadowed';
  return true;
}

async function testADisabledDocumentNeverConflicts() {
  const audit = auditKnowledgeConflicts([
    authoritySection('a', 'a.md', '350', { priority: 0 }),
    authoritySection('b', 'b.md', '400', { priority: 0, updatedAt: 100, enabled: false })
  ]);
  if (audit.conflicts.length !== 0) return 'a disabled document must not create a conflict';
  if (audit.shadowed.length !== 0) return 'a disabled document must not be shadowed either';
  return true;
}

async function testExplicitDocumentObjectsStillWin() {
  // When a caller passes a whole document on `section.document`, that object is the
  // authority — the fallback fields must not override it.
  const audit = auditKnowledgeConflicts([
    {
      documentId: 'a',
      headingPath: ['السعر'],
      content: '350',
      enabled: true,
      priority: 0,
      version: 1,
      updatedAt: 100,
      document: { id: 'a', filename: 'a.md', enabled: true, priority: 0, version: 1, updatedAt: 100 }
    },
    {
      documentId: 'b',
      headingPath: ['السعر'],
      content: '400',
      enabled: true,
      priority: 0,
      version: 1,
      updatedAt: 100,
      document: { id: 'b', filename: 'b.md', enabled: true, priority: 0, version: 1, updatedAt: 100 }
    }
  ]);
  if (audit.conflicts.length !== 1) return 'equal documents must still block';
  return true;
}

export default async function runAllTests() {
  await runTest("§38 Test 5's contradiction is blocking", testTheSpecExampleIsBlocking);
  await runTest('the gate and the audit agree (§18 has one rule)', testTheGateAndTheAuditAgree);
  await runTest('the gate still never asks the model about a conflict', testTheGateStillShortCircuitsTheModel);

  await runTest('documents that agree are not a conflict', testDocumentsThatAgreeAreNotAConflict);
  await runTest('documents about different subjects are not a conflict', testDifferentSubjectsAreNotAConflict);
  await runTest('a disabled document is not a conflict', testADisabledDocumentIsNotAConflict);
  await runTest('one document is never in conflict with itself', testOneDocumentIsNeverAConflict);

  await runTest('priority resolves a conflict (§18)', testPriorityResolvesAConflict);
  await runTest('version resolves a conflict (§18)', testVersionResolvesAConflict);
  await runTest('updatedAt resolves a conflict (§18)', testUpdatedAtResolvesAConflict);
  await runTest('a decided conflict is shadowed, not blocking', testShadowedIsNotReportedAsBlocking);
  await runTest('resolution steps are concrete', testResolutionStepsAreConcrete);
  await runTest("resolution steps say what does not count", testResolutionStepsSayWhatDoesNotCount);

  await runTest('the heading key derivation is part of the contract', testHeadingKeysMatch);
  await runTest('disagreement needs both a shared heading and a difference', testDisagreementNeedsBothHeadingAndDifference);
  await runTest('grouping by document is total', testGroupingIsTotal);
  await runTest('auditing is total', testAuditingIsTotal);
  await runTest('conflict reporting is bounded', testConflictReportingIsBounded);
  await runTest('one contradiction is found among many clean files', testManyDocumentsWithOneContradiction);
  await runTest('a three-way conflict reports each pair once', testThreeWayConflictIsReportedOnce);
  await runTest('resolving is total', testResolvingIsTotal);
  await runTest('the audit does not pretend to know index freshness', testTheAuditDoesNotDependOnIndexFreshness);

  console.log('\n--- Phase 20.19: precedence is read, not assumed equal ---');
  await runTest('A higher priority decides and shadows the loser', testHigherPriorityDecidesAContractAndShadowsTheLoser);
  await runTest('A higher version decides a contract', testHigherVersionDecidesAContract);
  await runTest('The newer file decides a contract', testTheNewerFileDecidesAContract);
  await runTest('Equal authority is still blocking', testEqualAuthorityIsStillBlocking);
  await runTest('A backup copy is never blocking', testABackupCopyIsNeverBlocking);
  await runTest('A disabled document never conflicts', testADisabledDocumentNeverConflicts);
  await runTest('An explicit document object still wins', testExplicitDocumentObjectsStillWin);

  return results;
}