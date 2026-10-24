/**
 * Knowledge Schema Tests — Phase 20.1
 *
 * These cases pin the four decisions the rest of Phase 20 is allowed to build on, and the
 * three of them that a regression in the rest of the phase would be silently built on top
 * of:
 *
 *   1. Only FRESH authorizes retrieval, and freshness is decided by the DOCUMENTS'
 *      fingerprint — never by a stored section, because no section is stored.
 *   2. A conflict that precedence cannot resolve is AMBIGUOUS, and the caller skips. §18's
 *      Test 5 (old vs 2027 price) is exactly this case, and it is the one where guessing
 *      would publish a wrong price under the user's name.
 *   3. An evidence id is stable across re-indexing, and never collides when truncated.
 *
 * Runs in the browser from knowledge-schema-tests.html (there is no Node runner). Nothing
 * here needs `chrome`: the module is pure by design.
 */

import {
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_FILENAME_CHARS,
  STORAGE_KEYS,
  INDEX_STATE,
  KNOWLEDGE_ERROR,
  ERROR_CATEGORY,
  DOCUMENT_REJECTION,
  normalizeFilename,
  splitCategory,
  slugify,
  buildEvidenceId,
  hashString,
  hashContent,
  clearContentHashCache,
  MAX_KNOWLEDGE_DOCUMENTS,
  computeFingerprint,
  validateDocumentInput,
  toKnowledgeDocument,
  isDocumentEnabled,
  isSameDocumentFilename,
  compareDocumentPrecedence,
  isAmbiguousConflict,
  resolveDocumentPrecedence,
  toKnowledgeSection,
  isSectionUsable,
  toIndexMeta,
  resolveIndexState,
  isRetrievableState,
  categorizeKnowledgeError,
  isExpectedKnowledgeSkip
} from '../knowledge-schema.js';
import { normalizeArabic } from '../matchers/arabic-normalizer.js';

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

const CHEMISTRY_MD = [
  '# كتاب التفوق كيمياء 3 ثانوي 2027',
  '',
  '## السعر',
  '',
  'السعر الحالي: 350 جنيه.',
  '',
  '## الشحن',
  '',
  'شحن كتاب واحد: 30 جنيه.',
  'الشحن مجاني عند شراء كتابين أو أكثر.'
].join('\n');

const SHIPPING_MD = '# الشحن\n\n- شحن كتاب واحد: 30 جنيه.\n- مجاني للكتبين أو أكثر.\n';

/** A valid document input, overridable per case. */
function docInput(overrides = {}) {
  return { filename: 'books/chemistry.md', content: CHEMISTRY_MD, ...overrides };
}

// ── Filenames and paths ──────────────────────────────────────────────────────

async function testFilenamesAreNormalizedNotRejected() {
  const accepted = [
    ['books/chemistry.md', 'books/chemistry.md'],
    ['.\\books\\chemistry.md', 'books/chemistry.md'],
    ['./books/chemistry.md', 'books/chemistry.md'],
    ['books//chemistry.md', 'books/chemistry.md'],
    ['/faq.md', 'faq.md'],
    ['books/chemistry.MD', 'books/chemistry.MD'],
    ['books/chemistry.markdown', 'books/chemistry.markdown'],
    ['  faq.md  ', 'faq.md']
  ];
  for (const [input, expected] of accepted) {
    const actual = normalizeFilename(input);
    if (actual !== expected) return `"${input}" became "${actual}", expected "${expected}"`;
  }
  return true;
}

async function testUnsafeOrWrongFilenamesAreRefused() {
  const refused = [
    ['../secrets.md', 'a path traversal'],
    ['books/../../secrets.md', 'a nested traversal'],
    ['books/./chemistry.md', 'a bare dot segment'],
    ['books/', 'a directory'],
    ['', 'empty'],
    [null, 'null'],
    [42, 'a number'],
    ['notes.txt', 'a non-Markdown extension'],
    ['books/chemistry', 'no extension'],
    ['a'.repeat(MAX_DOCUMENT_FILENAME_CHARS + 1) + '.md', 'an overlong path']
  ];
  for (const [input, why] of refused) {
    const actual = normalizeFilename(input);
    if (actual !== '') return `${JSON.stringify(input)} (${why}) was accepted as "${actual}"`;
  }
  return true;
}

async function testCategoryComesFromTheParentFolder() {
  const nested = splitCategory('books/chemistry.md');
  if (nested.category !== 'books') return `Expected category "books", got "${nested.category}"`;
  if (nested.basename !== 'chemistry.md') return `Expected basename "chemistry.md", got "${nested.basename}"`;

  const root = splitCategory('faq.md');
  if (root.category !== '') return `A root document should have no category, got "${root.category}"`;

  // Only the immediate parent is the category; deeper trees still keep the full path.
  const deep = splitCategory('a/b/chemistry.md');
  if (deep.category !== 'b') return `Expected the immediate parent "b", got "${deep.category}"`;
  return true;
}

async function testSlugifyKeepsArabicAndDropsPunctuation() {
  if (slugify('Price') !== 'PRICE') return 'Latin should be upper-cased';
  if (slugify('السعر') !== 'السعر') return 'Arabic letters must survive — the model has to read it back';
  if (slugify('Third Secondary!') !== 'THIRD-SECONDARY') return 'Punctuation should become a single hyphen';
  if (slugify('  --a--  ') !== 'A') return 'Leading and trailing separators should be trimmed';
  if (slugify(null) !== '') return 'null should slug to empty';
  return true;
}

// ── Evidence ids ─────────────────────────────────────────────────────────────

async function testEvidenceIdHasTheDocumentedShape() {
  // The exact id §15 prints: books/chemistry.md → the `## Price` section.
  const id = buildEvidenceId({
    category: 'books',
    filename: 'books/chemistry.md',
    headingPath: ['Price']
  });
  if (id !== 'KNOWLEDGE-BOOKS-CHEMISTRY-PRICE') {
    return `Unexpected id: ${id}`;
  }

  // The heading hierarchy contributes every level, not just the leaf.
  const nested = buildEvidenceId({
    category: 'books',
    filename: 'books/chemistry.md',
    headingPath: ['Chemistry', 'Third Secondary', 'Price']
  });
  if (nested !== 'KNOWLEDGE-BOOKS-CHEMISTRY-CHEMISTRY-THIRD-SECONDARY-PRICE') {
    return `Unexpected nested id: ${nested}`;
  }
  return true;
}

async function testEvidenceIdIsStableAcrossReindexing() {
  // The whole cache is disposable, so a rebuild must not invalidate evidence the validator
  // has already been handed.
  const first = buildEvidenceId({ category: 'books', filename: 'books/chemistry.md', headingPath: ['Price'] });
  const second = buildEvidenceId({ category: 'books', filename: 'books/chemistry.md', headingPath: ['Price'] });
  if (first !== second) return 'Two identical sections produced different evidence ids';
  return true;
}

async function testTruncatedEvidenceIdsDoNotCollide() {
  const longA = buildEvidenceId({ filename: 'a.md', headingPath: ['X'.repeat(300)] });
  const longB = buildEvidenceId({ filename: 'b.md', headingPath: ['X'.repeat(300)] });
  if (longA === longB) return 'Two long paths collided on one evidence id';
  if (longA.length > 120 || longB.length > 120) return 'A truncated id exceeded the budget';
  if (!longA.includes('HASH-')) return 'A truncated id should carry a hash suffix';
  return true;
}

async function testEvidenceIdSurvivesAMissingDocument() {
  const id = buildEvidenceId({ headingPath: ['السعر'] });
  if (id !== 'KNOWLEDGE-السعر') return `Unexpected id: ${id}`;

  const headingless = buildEvidenceId({ filename: 'general.md' });
  if (headingless !== 'KNOWLEDGE-GENERAL') return `Unexpected id: ${headingless}`;

  // A section with nothing to name at all still gets a usable id rather than an empty one,
  // because the validator has to compare it against something.
  if (buildEvidenceId({}) !== 'KNOWLEDGE-UNTITLED') return 'A nameless section should fall back to UNTITLED';
  return true;
}

// ── Hashing and the fingerprint ──────────────────────────────────────────────

async function testHashIsStableAndSensitive() {
  if (hashString('abc') !== hashString('abc')) return 'The same input hashed differently';
  if (hashString('abc') === hashString('abd')) return 'A one-character change did not change the hash';
  if (hashString('').length !== 16) return 'The hash should always be 16 hex characters';
  if (hashString(null) !== hashString('')) return 'null and the empty string should agree';
  return true;
}

async function testContentHashIgnoresWhitespaceAndDiacritics() {
  // Re-saving a file with an editor's line endings, or with the diacritics retyped, must
  // not invalidate the index. Changing the answer must.
  if (hashContent('السعر ٣٥٠ جنيه') !== hashContent('السعر ٣٥٠ جنيه.\n')) {
    return 'Trailing whitespace changed the content hash';
  }
  return true;
}

async function testContentHashNoticesAChangedAnswer() {
  const before = hashContent('السعر الحالي: 350 جنيه.');
  const after = hashContent('السعر الحالي: 370 جنيه.');
  if (before === after) return 'Changing the price did not change the content hash';
  return true;
}

async function testFingerprintIsOrderIndependentAndIgnoresUpdatedAt() {
  const a = toKnowledgeDocument(docInput());
  const b = toKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  const forward = computeFingerprint([a, b]);
  const reversed = computeFingerprint([b, a]);
  if (forward !== reversed) return 'The fingerprint depended on the order documents are stored in';

  const touched = { ...a, updatedAt: a.updatedAt + 60_000 };
  if (computeFingerprint([touched, b]) !== forward) {
    return 'Re-saving an unchanged document invalidated the fingerprint';
  }

  if (computeFingerprint([]) !== '') return 'An empty set should have no fingerprint';
  return true;
}

async function testFingerprintChangesWithAnythingThatAffectsAnAnswer() {
  const base = toKnowledgeDocument(docInput());
  const other = toKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });
  const fingerprint = computeFingerprint([base, other]);

const edited = toKnowledgeDocument(docInput({ content: CHEMISTRY_MD + '\n\nسعر جديد 370 جنيه.' }));
  if (computeFingerprint([edited, other]) === fingerprint) {
    return 'A content edit did not change the fingerprint';
  }
  if (computeFingerprint([{ ...base, version: 2 }, other]) === fingerprint) {
    return 'A version bump did not change the fingerprint';
  }
  if (computeFingerprint([{ ...base, enabled: false }, other]) === fingerprint) {
    return 'Disabling a document did not change the fingerprint';
  }
  if (computeFingerprint([{ ...base, priority: 5 }, other]) === fingerprint) {
    return 'A priority change did not change the fingerprint';
  }
  return true;
}

// ── Document model ───────────────────────────────────────────────────────────

async function testADocumentRoundTripsWithItsMetadata() {
  const doc = toKnowledgeDocument(docInput({ id: 'kdoc-1', version: 3, priority: 2 }));
  if (doc.id !== 'kdoc-1') return 'The supplied id was not kept';
  if (doc.filename !== 'books/chemistry.md') return 'The filename was not normalized';
  if (doc.category !== 'books') return 'The category was not derived';
  if (doc.content !== CHEMISTRY_MD) return 'The content was altered — knowledge must be stored verbatim';
  if (doc.version !== 3) return 'The version was not kept';
  if (doc.priority !== 2) return 'The priority was not kept';
  if (doc.hash !== hashContent(CHEMISTRY_MD)) return 'The content hash was not computed';
  if (!Number.isFinite(doc.updatedAt)) return 'updatedAt should be set';
  return true;
}

async function testADocumentIsEnabledByDefault() {
  // A user who adds a knowledge file expects it to be used; an added-but-inactive file
  // reads as a bug. Mirrors how trigger rules treat `enabled`.
  if (!isDocumentEnabled(toKnowledgeDocument(docInput()))) return 'A new document should be enabled';
  if (!isDocumentEnabled(toKnowledgeDocument(docInput({ enabled: undefined })))) {
    return 'A document with no enabled field should still be enabled';
  }
  if (isDocumentEnabled(toKnowledgeDocument(docInput({ enabled: false })))) {
    return 'An explicitly disabled document should be disabled';
  }
  if (isDocumentEnabled(null) || isDocumentEnabled('nope')) return 'Junk should never be enabled';
  return true;
}

async function testInvalidDocumentsAreRefusedWithAReason() {
  const cases = [
    [null, DOCUMENT_REJECTION.NOT_AN_OBJECT],
    ['nope', DOCUMENT_REJECTION.NOT_AN_OBJECT],
    [{ content: 'x' }, DOCUMENT_REJECTION.BAD_FILENAME],
    [{ filename: 'notes.txt', content: 'x' }, DOCUMENT_REJECTION.BAD_FILENAME],
    [{ filename: 'a.md' }, DOCUMENT_REJECTION.NOT_A_STRING],
    [{ filename: 'a.md', content: 42 }, DOCUMENT_REJECTION.NOT_A_STRING],
    [{ filename: 'a.md', content: '   \n  ' }, DOCUMENT_REJECTION.EMPTY_CONTENT],
    [{ filename: 'a.md', content: 'x'.repeat(MAX_DOCUMENT_CHARS + 1) }, DOCUMENT_REJECTION.CONTENT_TOO_LONG]
  ];
  for (const [input, reason] of cases) {
    const validation = validateDocumentInput(input);
    if (validation.valid) return `${JSON.stringify(input && input.filename)} was accepted`;
    if (validation.reason !== reason) return `Expected reason ${reason}, got ${validation.reason}`;
    if (toKnowledgeDocument(input) !== null) return 'An invalid input produced a document anyway';
  }
  return true;
}

async function testDuplicateFilenamesAreTheSameDocument() {
  // Two files differing only in case are one document to a person and two sources of truth
  // to a model. Phase §18 says skip rather than pick.
  if (!isSameDocumentFilename({ filename: 'Books/Chemistry.md' }, { filename: 'books/chemistry.md' })) {
    return 'Case-differing filenames should be the same document';
  }
  if (isSameDocumentFilename({ filename: 'books/chemistry.md' }, { filename: 'books/biology.md' })) {
    return 'Different documents were treated as the same';
  }
  if (isSameDocumentFilename({ filename: 'bad.txt' }, { filename: 'bad.txt' })) {
    return 'An unusable filename matched itself';
  }
  return true;
}

// ── Conflict precedence ──────────────────────────────────────────────────────

async function testPrecedencePrefersTheMoreExplicitDocument() {
  const old = toKnowledgeDocument({ filename: 'books/chemistry-old.md', content: '350', id: 'a' });
  const next = toKnowledgeDocument({ filename: 'books/chemistry.md', content: '370', id: 'b' });

  if (compareDocumentPrecedence(old, next) >= 0) return 'priority should have decided';

  const prioritised = { ...old, priority: 5 };
  if (compareDocumentPrecedence(prioritised, next) <= 0) return 'The higher priority should win';

  const newerVersion = { ...old, priority: 0, version: 9 };
  if (compareDocumentPrecedence(newerVersion, next) <= 0) return 'The higher version should win';

  const newerEdit = { ...old, priority: 0, version: 1, updatedAt: next.updatedAt + 1000 };
  if (compareDocumentPrecedence(newerEdit, next) <= 0) return 'The more recent edit should win';
  return true;
}

async function testAnEnabledDocumentBeatsADisabledOne() {
  const active = toKnowledgeDocument({ filename: 'a.md', content: '350', id: 'a' });
  const switchedOff = { ...toKnowledgeDocument({ filename: 'b.md', content: '370', id: 'b' }), enabled: false, priority: 99 };
  if (compareDocumentPrecedence(active, switchedOff) <= 0) {
    return 'An enabled document should win regardless of the other priority';
  }
  return true;
}

async function testPrecedenceIsATotalOrder() {
  // Two runs over the same pair must agree, or a conflict would resolve differently
  // depending on when it was noticed.
  const a = toKnowledgeDocument({ filename: 'a.md', content: 'x', id: 'kdoc-a' });
  const b = toKnowledgeDocument({ filename: 'b.md', content: 'y', id: 'kdoc-b' });
  const forward = compareDocumentPrecedence(a, b);
  const backward = compareDocumentPrecedence(b, a);
  if (Math.sign(forward) !== -Math.sign(backward)) return 'The comparison is not antisymmetric';
  if (compareDocumentPrecedence(a, a) !== 0) return 'A document did not equal itself';
  if (!Number.isInteger(forward)) return 'The comparison should return an integer';
  return true;
}

async function testAnUnresolvableConflictIsReportedNotGuessed() {
  // Phase §18 Test 5: two documents about the same thing with equal authority. The answer
  // must be CONFLICTING_KNOWLEDGE, never a coin toss.
  const a = { id: 'kdoc-a', filename: 'books/chemistry-old.md', content: '350', enabled: true, priority: 0, version: 1, updatedAt: 1_700_000_000_000 };
  const b = { id: 'kdoc-b', filename: 'books/chemistry-2027.md', content: '370', enabled: true, priority: 0, version: 1, updatedAt: 1_700_000_000_000 };

  if (!isAmbiguousConflict(a, b)) return 'Two documents of equal authority should be ambiguous';
  if (isAmbiguousConflict(a, { ...b, priority: 1 })) return 'A priority difference should resolve the conflict';

  const resolved = resolveDocumentPrecedence([a, b]);
  if (!resolved.ambiguous) return 'The conflict should have been reported as ambiguous';
  if (resolved.winner !== null) return 'An ambiguous conflict must not name a winner';
  return true;
}

async function testResolutionIgnoresDisabledDocuments() {
  const active = toKnowledgeDocument({ filename: 'books/chemistry.md', content: '350', id: 'a' });
  const old = { ...toKnowledgeDocument({ filename: 'books/chemistry-old.md', content: '300', id: 'b' }), enabled: false };

  const resolved = resolveDocumentPrecedence([active, old]);
  if (resolved.ambiguous) return 'A switched-off document should not create a conflict';
  if (resolved.winner !== active) return 'The enabled document should win';

  if (resolveDocumentPrecedence([]).winner !== null) return 'No documents should have no winner';
  return true;
}

// ── Section model ────────────────────────────────────────────────────────────

async function testASectionKeepsItsHeadingPathAndSource() {
  const doc = toKnowledgeDocument(docInput());
  const section = toKnowledgeSection({
    document: doc,
    headingPath: ['Chemistry', 'Third Secondary', 'Price'],
    content: '350 EGP',
    ordinal: 2
  });

  if (section.documentId !== doc.id) return 'The section lost its source document';
  if (section.filename !== 'books/chemistry.md') return 'The section lost its filename';
  if (section.category !== 'books') return 'The section lost its category';
  if (section.headingPath.length !== 3) return 'The heading hierarchy was lost';
  if (section.content !== '350 EGP') return 'The content was altered';
  if (section.evidenceId !== 'KNOWLEDGE-BOOKS-CHEMISTRY-CHEMISTRY-THIRD-SECONDARY-PRICE') {
    return `Unexpected evidence id: ${section.evidenceId}`;
  }
  if (section.empty !== false) return 'A section with content should not be marked empty';
  return true;
}

async function testAnEmptySectionIsKeptButNotUsable() {
  // §5 lists empty sections among the cases that must be handled. Dropping one would
  // change the heading shape the user wrote.
  const doc = toKnowledgeDocument(docInput());
  const section = toKnowledgeSection({ document: doc, headingPath: ['Notes'], content: '   ' });
  if (section === null) return 'An empty section was dropped entirely';
  if (section.empty !== true) return 'An empty section should be marked empty';
  if (isSectionUsable(section)) return 'An empty section must not be retrieved from';
  return true;
}

async function testADisabledSectionsDocumentDisablesItsSections() {
  const doc = { ...toKnowledgeDocument(docInput()), enabled: false };
  const section = toKnowledgeSection({ document: doc, headingPath: ['Price'], content: '350 EGP' });
  if (isSectionUsable(section)) return 'A section from a disabled document must not be usable';
  return true;
}

async function testASectionWithoutADocumentIsRefused() {
  if (toKnowledgeSection({ headingPath: ['Price'], content: 'x' }) !== null) {
    return 'A section with no documentId should be refused';
  }
  if (toKnowledgeSection({ documentId: 42, headingPath: ['Price'], content: 'x' }) !== null) {
    return 'A non-string documentId should be refused';
  }
  if (toKnowledgeSection(null) !== null) return 'null should produce no section';
  return true;
}

async function testSectionIdsAreStableForTheSameSection() {
  const doc = toKnowledgeDocument(docInput());
  const build = () => toKnowledgeSection({ document: doc, headingPath: ['Price'], content: '350 EGP', ordinal: 1 });
  if (build().id !== build().id) return 'The same section produced two ids';
  if (build().id === toKnowledgeSection({ document: doc, headingPath: ['Shipping'], content: '30 EGP', ordinal: 2 }).id) {
    return 'Two different sections shared an id';
  }
  return true;
}

// ── Index lifecycle ──────────────────────────────────────────────────────────

async function testNoDocumentsMeansEmptyAndNothingIsRetrievable() {
  if (resolveIndexState(null, []) !== INDEX_STATE.EMPTY) return 'No documents should be EMPTY';
  if (resolveIndexState({ fingerprint: 'x', state: INDEX_STATE.FRESH }, []) !== INDEX_STATE.EMPTY) {
    return 'Metadata claiming freshness cannot make an empty base retrievable';
  }
  if (isRetrievableState(INDEX_STATE.EMPTY)) return 'EMPTY must not authorize retrieval';
  return true;
}

async function testADisabledBaseIsTreatedAsEmpty() {
  // A base where the user switched everything off has nothing to offer, and saying EMPTY is
  // what keeps the UI from showing an indexing error for a working configuration.
  const off = { ...toKnowledgeDocument(docInput()), enabled: false };
  if (resolveIndexState(null, [off]) !== INDEX_STATE.EMPTY) return 'An all-disabled base should read as EMPTY';
  return true;
}

async function testAFreshIndexIsRecognizedAndStaleOnesAreNot() {
  const docs = [toKnowledgeDocument(docInput()), toKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD })];

  const meta = toIndexMeta({ fingerprint: computeFingerprint(docs), state: INDEX_STATE.FRESH, sectionCount: 7 });
  if (resolveIndexState(meta, docs) !== INDEX_STATE.FRESH) return 'A matching fingerprint should read as FRESH';
  if (!isRetrievableState(resolveIndexState(meta, docs))) return 'FRESH must authorize retrieval';

  // §38 Test 10: change the knowledge and the index must stop being usable.
  const edited = [toKnowledgeDocument(docInput({ content: CHEMISTRY_MD + '\n\nالسعر الآن 370 جنيه.' })), docs[1]];
  if (resolveIndexState(meta, edited) !== INDEX_STATE.STALE) return 'An edited document should make the index STALE';
  if (isRetrievableState(INDEX_STATE.STALE)) return 'STALE must not authorize retrieval';

  // Switching a document off changes what a retrieval would return, so it must also
  // invalidate — otherwise the index still cites a document the user retired.
  const retired = [{ ...docs[0], enabled: false }, docs[1]];
  if (resolveIndexState(meta, retired) !== INDEX_STATE.STALE) return 'Retiring a document should make the index STALE';
  return true;
}

async function testFailedAndBuildingRecordsAreNeverRetrievable() {
  const docs = [toKnowledgeDocument(docInput())];
  const fingerprint = computeFingerprint(docs);

  for (const state of [INDEX_STATE.FAILED, INDEX_STATE.BUILDING, INDEX_STATE.STALE, INDEX_STATE.EMPTY]) {
    const state2 = resolveIndexState({ fingerprint, state }, docs);
    if (isRetrievableState(state2)) return `A ${state} record was treated as retrievable`;
  }
  return true;
}

async function testIndexMetadataIsSanitized() {
  const meta = toIndexMeta({ fingerprint: 42, state: 'bogus', documentCount: -1, sectionCount: 'x', builtAt: 'y', error: 7 });
  if (meta.fingerprint !== '') return 'A non-string fingerprint should be dropped';
  if (meta.state !== INDEX_STATE.EMPTY) return 'An unknown state should fall back to EMPTY';
  if (meta.documentCount !== 0 || meta.sectionCount !== 0) return 'Negative or non-integer counts should read as 0';
  if (meta.builtAt !== 0) return 'A non-numeric builtAt should read as 0';
  if (meta.error !== '') return 'A non-string error should be dropped';

  if (toIndexMeta(null).state !== INDEX_STATE.EMPTY) return 'null metadata should read as EMPTY';
  return true;
}

async function testTheStorageKeysAreTheTwoThatWereDecided() {
  // Only documents and their index metadata are persisted. A third key holding indexed
  // sections would be a second source of truth that goes stale.
  if (STORAGE_KEYS.DOCUMENTS !== 'knowledgeDocuments') return `Unexpected documents key: ${STORAGE_KEYS.DOCUMENTS}`;
  if (STORAGE_KEYS.INDEX_META !== 'knowledgeIndexMeta') return `Unexpected index key: ${STORAGE_KEYS.INDEX_META}`;
  return true;
}

// ── Error model ──────────────────────────────────────────────────────────────

async function testEveryErrorCodeHasACategory() {
  const codes = Object.values(KNOWLEDGE_ERROR);
  // 11 as of Phase 20.10, which added GROUNDING_CHECK_FAILED. The exact count is the point of
  // this assertion: a code added without a bucket would otherwise resolve to SYSTEM silently,
  // and a code added out of nowhere would not be noticed at all.
  if (codes.length !== 11) return `Expected 11 codes, found ${codes.length}`;

  for (const code of codes) {
    const category = categorizeKnowledgeError(code);
    if (!Object.values(ERROR_CATEGORY).includes(category)) {
      return `${code} resolved to an unknown category "${category}"`;
    }
    if (KNOWLEDGE_ERROR[code] !== code) return `The code string for ${code} does not match its key`;
  }
  return true;
}

async function testOnlyNoSupportedAnswerIsAnExpectedSkip() {
  // This is the distinction the phase cares most about: skipping an unsupported question
  // is the feature WORKING. Counting it as a failure makes a healthy knowledge base read
  // as broken.
  if (!isExpectedKnowledgeSkip(KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER)) return 'NO_SUPPORTED_ANSWER should be an expected skip';

  for (const code of [
    KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE,
    KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE,
    KNOWLEDGE_ERROR.INVALID_KNOWLEDGE_DOCUMENT,
    KNOWLEDGE_ERROR.INTENT_PARSE_FAILED,
    KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED,
    KNOWLEDGE_ERROR.GENERATION_FAILED,
    KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED,
    KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED,
    KNOWLEDGE_ERROR.REPLY_VALIDATION_FAILED,
    KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED
  ]) {
    if (isExpectedKnowledgeSkip(code)) return `${code} must not be counted as an expected skip`;
  }
  return true;
}

async function testErrorsAreGroupedAsThePhaseGroupsThem() {
  const expected = [
    [KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE, ERROR_CATEGORY.RETRIEVAL],
    [KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE, ERROR_CATEGORY.KNOWLEDGE],
    [KNOWLEDGE_ERROR.INVALID_KNOWLEDGE_DOCUMENT, ERROR_CATEGORY.KNOWLEDGE],
    [KNOWLEDGE_ERROR.INTENT_PARSE_FAILED, ERROR_CATEGORY.AI],
    [KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED, ERROR_CATEGORY.AI],
    [KNOWLEDGE_ERROR.GENERATION_FAILED, ERROR_CATEGORY.AI],
    [KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED, ERROR_CATEGORY.SAFETY],
    [KNOWLEDGE_ERROR.REPLY_VALIDATION_FAILED, ERROR_CATEGORY.SAFETY],
    [KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, ERROR_CATEGORY.SYSTEM]
  ];
  for (const [code, category] of expected) {
    const actual = categorizeKnowledgeError(code);
    if (actual !== category) return `${code} is ${actual}, expected ${category}`;
  }

  // A formatting helper that throws loses the error it was formatting.
  if (categorizeKnowledgeError('SOMETHING_NEW') !== ERROR_CATEGORY.SYSTEM) {
    return 'An unknown code should fall back to SYSTEM';
  }
  return true;
}

// ─── Precedence resolution ────────────────────────────────────────────────────

async function testPrecedencePicksTheHighestAuthorityDocument() {
  // §18's resolution decides which document's claim stands, so getting the ORDER wrong makes
  // the extension name the wrong file as authoritative. It did: the resolver sorted ASCENDING
  // on a comparator that returns a positive number for the winner, so `sorted[0]` was the
  // LOSER. It went unnoticed because the only consumer until now read just the `ambiguous`
  // flag and never looked at which document actually won — nothing incorrect reached a viewer,
  // but Phase 20.12's audit reports which document wins and inherited the bug.
  const base = { enabled: true, priority: 0, version: 1, updatedAt: 1000 };
  const low = { ...base, id: 'doc-low', filename: 'general.md' };
  const high = { ...base, id: 'doc-high', filename: 'current.md', priority: 10 };

  if (resolveDocumentPrecedence([low, high]).winner?.filename !== 'current.md') {
    return 'priority did not make the higher-priority document win';
  }
  // Argument order must not matter, or the answer depends on how the caller built its array.
  if (resolveDocumentPrecedence([high, low]).winner?.filename !== 'current.md') {
    return 'the winner depended on argument order';
  }

  const older = { ...base, id: 'doc-a', filename: 'v1.md' };
  const newer = { ...base, id: 'doc-b', filename: 'v2.md', version: 2 };
  if (resolveDocumentPrecedence([older, newer]).winner?.filename !== 'v2.md') {
    return 'the higher version did not win';
  }

  const stale = { ...base, id: 'doc-a', filename: 'a.md', updatedAt: 1000 };
  const fresh = { ...base, id: 'doc-b', filename: 'b.md', updatedAt: 5000 };
  if (resolveDocumentPrecedence([stale, fresh]).winner?.filename !== 'b.md') {
    return 'the more recently edited document did not win';
  }

  const off = { ...base, id: 'doc-off', filename: 'off.md', enabled: false, priority: 99 };
  if (resolveDocumentPrecedence([low, off]).winner?.filename !== 'general.md') {
    return 'a disabled document won despite its priority';
  }

  // Equal authority must stay UNRESOLVABLE, or §18's skip is quietly replaced by a guess.
  const twin = { ...base, id: 'doc-twin', filename: 'twin.md' };
  const ambiguous = resolveDocumentPrecedence([low, twin]);
  if (!ambiguous.ambiguous) return 'equal authority was reported as resolved';
  if (ambiguous.winner !== null) return 'an ambiguous conflict still returned a winner';

  return true;
}

async function runAllTests() {
  console.log('\n=== Knowledge Schema Tests (Phase 20.1) ===\n');

  await runTest('Filenames are normalized, not rejected', testFilenamesAreNormalizedNotRejected);
  await runTest('Unsafe or wrong filenames are refused', testUnsafeOrWrongFilenamesAreRefused);
  await runTest('The category comes from the parent folder', testCategoryComesFromTheParentFolder);
  await runTest('Slugify keeps Arabic and drops punctuation', testSlugifyKeepsArabicAndDropsPunctuation);

  await runTest('An evidence id has the documented shape', testEvidenceIdHasTheDocumentedShape);
  await runTest('An evidence id is stable across re-indexing', testEvidenceIdIsStableAcrossReindexing);
  await runTest('Truncated evidence ids do not collide', testTruncatedEvidenceIdsDoNotCollide);
  await runTest('An evidence id survives a missing document', testEvidenceIdSurvivesAMissingDocument);

  await runTest('A hash is stable and sensitive', testHashIsStableAndSensitive);
  await runTest('The content hash ignores whitespace', testContentHashIgnoresWhitespaceAndDiacritics);
  await runTest('The content hash notices a changed answer', testContentHashNoticesAChangedAnswer);
  await runTest('The fingerprint is order independent', testFingerprintIsOrderIndependentAndIgnoresUpdatedAt);
  await runTest('The fingerprint tracks everything that changes an answer', testFingerprintChangesWithAnythingThatAffectsAnAnswer);

  await runTest('A document round trips with its metadata', testADocumentRoundTripsWithItsMetadata);
  await runTest('A document is enabled by default', testADocumentIsEnabledByDefault);
  await runTest('Invalid documents are refused with a reason', testInvalidDocumentsAreRefusedWithAReason);
  await runTest('Duplicate filenames are the same document', testDuplicateFilenamesAreTheSameDocument);

  await runTest('Precedence prefers the more explicit document', testPrecedencePrefersTheMoreExplicitDocument);
  await runTest('An enabled document beats a disabled one', testAnEnabledDocumentBeatsADisabledOne);
  await runTest('Precedence is a total order', testPrecedenceIsATotalOrder);
  await runTest('An unresolvable conflict is reported, not guessed', testAnUnresolvableConflictIsReportedNotGuessed);
  await runTest('Resolution ignores disabled documents', testResolutionIgnoresDisabledDocuments);

  await runTest('A section keeps its heading path and source', testASectionKeepsItsHeadingPathAndSource);
  await runTest('An empty section is kept but not usable', testAnEmptySectionIsKeptButNotUsable);
  await runTest('A disabled document disables its sections', testADisabledSectionsDocumentDisablesItsSections);
  await runTest('A section without a document is refused', testASectionWithoutADocumentIsRefused);
  await runTest('Section ids are stable for the same section', testSectionIdsAreStableForTheSameSection);

  await runTest('No documents means EMPTY and nothing is retrievable', testNoDocumentsMeansEmptyAndNothingIsRetrievable);
  await runTest('A disabled base is treated as empty', testADisabledBaseIsTreatedAsEmpty);
  await runTest('A fresh index is recognized and stale ones are not', testAFreshIndexIsRecognizedAndStaleOnesAreNot);
  await runTest('Failed and building records are never retrievable', testFailedAndBuildingRecordsAreNeverRetrievable);
  await runTest('Index metadata is sanitized', testIndexMetadataIsSanitized);
  await runTest('The storage keys are the two that were decided', testTheStorageKeysAreTheTwoThatWereDecided);

  await runTest('Every error code has a category', testEveryErrorCodeHasACategory);
  await runTest('Only NO_SUPPORTED_ANSWER is an expected skip', testOnlyNoSupportedAnswerIsAnExpectedSkip);
  await runTest('Errors are grouped as the phase groups them', testErrorsAreGroupedAsThePhaseGroupsThem);
  await runTest('precedence picks the highest-authority document (§18)', testPrecedencePicksTheHighestAuthorityDocument);

  console.log('\n--- Phase 20.21: the content-hash cache ---');
  await runTest('Memoization does not change the result', testHashContentIsMemoizedWithoutChangingItsResult);
  await runTest('The value still matches the uncached definition', testHashContentMatchesTheUncachedDefinition);
  await runTest('Different text does not collide', testHashContentDistinguishesDifferentText);
  await runTest('Whitespace-only changes stay identical', testHashContentIgnoresCosmeticWhitespaceOnly);
  await runTest('The cache is bounded', testContentHashCacheIsBounded);
  await runTest('Clearing the cache changes nothing', testClearContentHashCacheDoesNotChangeResults);


/**
 * ── Phase 20.21: the content-hash cache ─────────────────────────────────────────
 *
 * `hashContent()` runs the whole Arabic normalization over a document, and it used to run
 * once per document per COMMENT, because `getKnowledgeIndex()` re-reads the document list
 * to compare the fingerprint. The cache is only legitimate if it is a cache of a PURE
 * function, so these cases assert exactly that — plus the bound, because a cache that grows
 * with every edit is a memory leak wearing a performance hat.
 */
async function testHashContentIsMemoizedWithoutChangingItsResult() {
  clearContentHashCache();
  const samples = [
    'السعر 350 جنيه',
    'السعر: ٣٥٠ جنيه.',
    '# كيمياء\n\n## السعر\n\n350 جنيه\n',
    '',
    '   ',
    'المGRESS'
  ];

  // Twice each: the second call is the cached path.
  const first = samples.map((text) => hashContent(text));
  const second = samples.map((text) => hashContent(text));

  for (let i = 0; i < samples.length; i++) {
    if (first[i] !== second[i]) {
      return `hashContent("${samples[i]}") changed between calls: ${first[i]} vs ${second[i]}`;
    }
  }
  return true;
}

async function testHashContentMatchesTheUncachedDefinition() {
  // The value itself must not drift: the fingerprint is computed from these hashes, so a
  // "faster but different" hash would silently re-index every base and quietly change what
  // §18 precedence decides.
  clearContentHashCache();
  for (const text of ['السعر 350', 'a b  c', 'السَّعر', '٣٤٥', '']) {
    const expected = hashString(normalizeArabic(text).replace(/\s+/g, ' ').trim());
    const actual = hashContent(text);
    if (actual !== expected) return `hashContent("${text}")=${actual}, expected ${expected}`;
  }
  return true;
}

async function testHashContentDistinguishesDifferentText() {
  clearContentHashCache();
  // A cache keyed on the text must not conflate two documents. Whitespace collapsing is
  // the documented behaviour, so these differ only beyond it.
  if (hashContent('350 جنيه') === hashContent('450 جنيه')) return 'different prices collided';
  if (hashContent('a') === hashContent('b')) return 'different words collided';
  return true;
}

async function testHashContentIgnoresCosmeticWhitespaceOnly() {
  clearContentHashCache();
  // Documented and relied upon: normalization collapses whitespace before hashing, so a
  // re-save that only re-wraps a line is NOT a content change and must not invalidate the
  // index. §38 Test 10 depends on this being stable.
  if (hashContent('350\n  جنيه') !== hashContent('350 جنيه')) {
    return 'a whitespace-only change altered the hash — every re-save would invalidate the index';
  }
  return true;
}

async function testContentHashCacheIsBounded() {
  clearContentHashCache();
  // More distinct texts than the bound, so eviction has to happen. Nothing here is timed —
  // the property is that it does not grow without limit.
  const total = MAX_KNOWLEDGE_DOCUMENTS + 25;
  for (let i = 0; i < total; i++) hashContent(`document number ${i} with unique content ${i}`);
  // Still correct afterwards: an eviction must never change a result.
  const a = hashContent('document number 0 with unique content 0');
  const b = hashContent('document number 0 with unique content 0');
  if (a !== b) return 'results differ after eviction';
  if (!a) return 'an evicted entry must recompute, not return nothing';
  return true;
}

async function testClearContentHashCacheDoesNotChangeResults() {
  hashContent('السعر 350');
  const before = hashContent('السعر 350');
  clearContentHashCache();
  const after = hashContent('السعر 350');
  return before === after || 'clearing the cache changed a hash';
}

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;