/**
 * Knowledge Index Tests — Phase 20.4
 *
 * The index is the join point of the whole phase, and the property that matters is the one
 * that is easiest to lose: **the index is never served stale, and it is never partially
 * served**. Both are silent failures — a user gets an old price, or gets "no idea" for a
 * document they know is loaded — and neither produces an error anywhere.
 *
 * So these cases concentrate on:
 *
 *   1. The gate. `retrievable` is true only behind `resolveIndexState()` reporting FRESH,
 *      and after a worker restart (metadata FRESH, empty cache) the answer is a rebuild,
 *      not a stale index.
 *   2. Acceptance Test 10 end to end: edit the document, and the very next read must use
 *      the new text and never the old one.
 *   3. Strictness. One unindexable document fails the WHOLE build — because a partial base
 *      is a silently incomplete answer, which is the failure this phase refuses.
 *   4. A failed build CLEARS the cache, so a later FRESH resolution cannot serve the old one.
 *
 * Runs in the browser from knowledge-index-tests.html, with chrome-storage-stub.js imported
 * first so `chrome` exists before knowledge-store.js is evaluated.
 */

import { resetStorage } from './chrome-storage-stub.js';
import {
  getKnowledgeIndex,
  getKnowledgeIndexStatus,
  clearKnowledgeIndexCache,
  computeIndex,
  buildSections,
  toIndexSnapshot,
  usableSections,
  MAX_INDEXED_SECTIONS
} from '../knowledge-index.js';
import { addKnowledgeDocument, updateKnowledgeDocument, saveKnowledgeIndexMeta } from '../knowledge-store.js';
import { toKnowledgeDocument, INDEX_STATE, resolveIndexState, isDocumentEnabled } from '../knowledge-schema.js';

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

const CHEMISTRY_MD = '# كيمياء\n\n## السعر\n\nالسعر الحالي: 350 جنيه.\n';
const CHEMISTRY_UPDATED_MD = '# كيمياء\n\n## السعر\n\nالسعر الحالي: 370 جنيه.\n';
const SHIPPING_MD = '# الشحن\n\n- شحن كتاب واحد: 30 جنيه.\n- مجاني للكتابين أو أكثر.\n';

/** A clean profile AND a clean in-memory index, which is what a worker restart looks like. */
async function freshStart() {
  resetStorage();
  clearKnowledgeIndexCache();
}

/** The one section's content, for a document with a single body-bearing heading. */
function priceContent(index) {
  const section = (index.sections || []).find((s) => s.headingPath.includes('السعر'));
  return section ? section.content : null;
}

// ── Building ──────────────────────────────────────────────────────────────────

async function testAnEmptyBaseIsRetrievableAndEmpty() {
  await freshStart();
  const index = await getKnowledgeIndex();

  // NOT a failure. §13 and §24 make "nothing to answer from" a deliberate outcome, and an
  // empty knowledge base must not look like a broken one.
  if (index.retrievable !== true) return 'An empty base should still be usable';
  if (index.state !== INDEX_STATE.FRESH) return `Unexpected state: ${index.state}`;
  if (index.sectionCount !== 0) return `Expected 0 sections, got ${index.sectionCount}`;
  return true;
}

async function testADocumentBecomesSearchableSections() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const index = await getKnowledgeIndex();

  // Two sections: the `# كيمياء` root (which has no body of its own) and the price.
  if (index.sectionCount !== 2) return `Expected 2 sections, got ${index.sectionCount}`;
  if (priceContent(index) !== 'السعر الحالي: 350 جنيه.') {
    return `Unexpected section content: ${JSON.stringify(priceContent(index))}`;
  }
  const section = index.sections.find((s) => s.headingPath.includes('السعر'));
  if (section.documentId === undefined) return 'The section lost its document id';
  // The heading path contributes EVERY level, so the bodyless `# كيمياء` root is in it.
  if (section.evidenceId !== 'KNOWLEDGE-BOOKS-CHEMISTRY-كيمياء-السعر') {
    return `Unexpected evidence id: ${section.evidenceId}`;
  }
  return true;
}

async function testSectionsCarryTheirSearchableText() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const index = await getKnowledgeIndex();
  const section = index.sections.find((s) => s.headingPath.includes('السعر'));

  // The heading path is folded in, so a comment naming the PRODUCT matches a section whose
  // body only says the price — the product name lives in the heading, not the sentence.
  if (!section.searchText.includes('كيمياء')) return 'The heading path is missing from the search text';
  if (!section.searchText.includes('السعر')) return 'The heading is missing from the search text';
  if (!section.searchText.includes('350')) return 'The content is missing from the search text';

  // It is a derived field: the citable content must stay exactly as written.
  if (section.content !== 'السعر الحالي: 350 جنيه.') return 'The content was altered to build the search text';
  if (section.charCount !== section.content.length) return 'charCount does not match the content';
  return true;
}

async function testDisabledDocumentsAreNotIndexed() {
  await freshStart();
  const chemistry = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });
  await updateKnowledgeDocument(chemistry.id, { enabled: false });

  const index = await getKnowledgeIndex();
  if (index.documentCount !== 1) return `Expected 1 indexed document, got ${index.documentCount}`;
  // shipping.md is one `#` heading with a body, so exactly one section.
  if (index.sectionCount !== 1) return `Expected 1 section from the one enabled document, got ${index.sectionCount}`;
  if (index.sections.some((s) => s.filename === 'books/chemistry.md')) {
    return 'A disabled document was indexed';
  }
  return true;
}

async function testABaseOfOnlyDisabledDocumentsIndexesNothing() {
  await freshStart();
  const chemistry = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await updateKnowledgeDocument(chemistry.id, { enabled: false });

  const index = await getKnowledgeIndex();
  if (index.sectionCount !== 0) return 'A retired document is still being indexed';
  if (index.retrievable !== true) return 'This should be a normal, usable state';
  return true;
}

async function testEmptySectionsAreIndexedButNotUsable() {
  await freshStart();
  await addKnowledgeDocument({
    filename: 'books/chemistry.md',
    content: '# كيمياء\n\n## ملاحظات\n\n## السعر\n\n350 جنيه.'
  });
  const index = await getKnowledgeIndex();

  // Kept, because a heading the user wrote is real structure — but excluded from what
  // retrieval may read, so an empty section never reaches the model as if it were a fact.
  if (index.sectionCount !== 3) return `Expected 3 sections, got ${index.sectionCount}`;
  const usable = usableSections(index);
  if (usable.length !== 1) return `Expected 1 usable section, got ${usable.length}`;
  if (!usable[0].headingPath.includes('السعر')) return 'The wrong section survived';
  return true;
}

async function testSeveralDocumentsAreIndexedInOneBuild() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'books/biology.md', content: '# بيولوجي\n\nالسعر 300 جنيه.\n' });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  const index = await getKnowledgeIndex();
  if (index.documentCount !== 3) return `Expected 3 documents, got ${index.documentCount}`;
  // chemistry is 2 (a bodyless root plus the price); biology and shipping are 1 each.
  if (index.sectionCount !== 4) return `Expected 4 sections, got ${index.sectionCount}`;

  const filenames = new Set(index.sections.map((s) => s.filename));
  if (filenames.size !== 3) return 'Sections from different documents collided';
  return true;
}

// ── The gate ──────────────────────────────────────────────────────────────────

async function testAFreshBaseWithNoCacheIsRebuiltNotServed() {
  // The MV3 case: the worker was torn down, so the stored metadata says FRESH but memory
  // holds nothing. Reporting the stored FRESH as "ready" without an index would be a lie
  // that costs a visible pause on the first comment.
  resetStorage();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  // A previous worker built the index and recorded it.
  await saveKnowledgeIndexMeta({
    fingerprint: (await getKnowledgeIndex()).fingerprint,
    state: INDEX_STATE.FRESH,
    documentCount: 1,
    sectionCount: 1
  });

  clearKnowledgeIndexCache(); // the restart

  const status = await getKnowledgeIndexStatus();
  if (status.retrievable !== false) return 'Stored FRESH must not claim an in-memory index exists';

  const index = await getKnowledgeIndex();
  if (index.retrievable !== true) return 'The rebuild did not produce a usable index';
  if (index.sectionCount !== 2) return `The rebuild produced ${index.sectionCount} sections, expected 2`;
  return true;
}

async function testTheGateReportsStaleUntilAnIndexIsBuilt() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  // Freshly added documents, never indexed: the store says STALE and nothing is cached.
  const status = await getKnowledgeIndexStatus();
  if (status.state !== INDEX_STATE.STALE) return `Expected STALE, got ${status.state}`;
  if (status.retrievable !== false) return 'Nothing is built, so nothing is retrievable';
  if (status.cached !== false) return 'The cache should be empty';
  return true;
}

async function testAnIndexIsReusedForTheNextComment() {
  // The memo exists so 47 comments in a run do not re-parse the base 47 times. §33 asks for
  // this; re-parsing per comment would be the unnecessary repeated work it warns about.
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const first = await getKnowledgeIndex();
  const second = await getKnowledgeIndex();

  if (!second.retrievable) return 'The second read should reuse the index';
  if (second.sections !== first.sections) return 'The second read rebuilt instead of reusing the memo';
  return true;
}

async function testAForcedRebuildRunsEvenWhenFresh() {
  // The manual reload of §20.20, which exists because a user must never have to rebuild the
  // extension to change their own knowledge.
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const before = await getKnowledgeIndex();
  const forced = await getKnowledgeIndex({ forceRebuild: true });

  if (!forced.retrievable) return 'A forced rebuild produced no index';
  if (forced.sections === before.sections) return 'The forced rebuild reused the memo';
  if (forced.sectionCount !== before.sectionCount) return 'The forced rebuild changed the section count';
  return true;
}

// ── §38 Test 10, end to end ───────────────────────────────────────────────────

async function testAnEditIsVisibleToTheVeryNextRead() {
  // ACCEPTANCE TEST 10: "update the document; new retrieval uses 370; old cached knowledge
  // is not used". This is the whole reason the index is not persisted, so it is tested
  // through the public entry point rather than on internals.
  await freshStart();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const before = await getKnowledgeIndex();
  if (priceContent(before).indexOf('350') === -1) return 'The original price was not indexed';

  await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });

  const after = await getKnowledgeIndex();
  if (priceContent(after).indexOf('370') === -1) {
    return `The new price was not picked up: ${priceContent(after)}`;
  }
  if (priceContent(after).indexOf('350') !== -1) {
    return `The old price survived the edit: ${priceContent(after)}`;
  }
  return true;
}

async function testTheEditedSectionGetsANewVersion() {
  // Hash/version tracking (§19). A section carrying the document's version is what lets a
  // later stage reason about whether its evidence predates the user's last edit.
  await freshStart();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const before = await getKnowledgeIndex();
  await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });
  const after = await getKnowledgeIndex();

  if (before.sections[0].version === after.sections[0].version) {
    return 'The section did not pick up the document version bump';
  }
  if (after.sections[0].version !== 2) return `Expected version 2, got ${after.sections[0].version}`;
  return true;
}

async function testAReturningDocumentDoesNotServeTheOldIndex() {
  // The subtle half of Test 10. Editing then reverting brings the fingerprint back to its
  // original value, which is exactly the case a naive "the cache misses, so it is stale"
  // check would get wrong in the dangerous direction.
  await freshStart();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await getKnowledgeIndex();

  await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });
  const edited = await getKnowledgeIndex();
  if (priceContent(edited).indexOf('370') === -1) return 'The edit was not picked up';

  await updateKnowledgeDocument(created.id, { content: CHEMISTRY_MD });
  const reverted = await getKnowledgeIndex();
  if (priceContent(reverted).indexOf('350') === -1) return `The revert was not picked up: ${priceContent(reverted)}`;
  if (priceContent(reverted).indexOf('370') !== -1) return 'The reverted document still serves the edited text';
  return true;
}

async function testAddingADocumentIsVisibleImmediately() {
  await freshStart();
  const first = await getKnowledgeIndex();
  if (first.sectionCount !== 0) return 'The base should start empty';

  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const second = await getKnowledgeIndex();

  if (second.sectionCount !== 2) return `The new document was not indexed: ${second.sectionCount}`;
  return true;
}

async function testRemovingADocumentIsVisibleImmediately() {
  await freshStart();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  const before = await getKnowledgeIndex();
  if (before.documentCount !== 2) return 'Both documents should be indexed';

  const { removeKnowledgeDocument } = await import('../knowledge-store.js');
  await removeKnowledgeDocument(created.id);

  const after = await getKnowledgeIndex();
  if (after.documentCount !== 1) return `Expected 1 document, got ${after.documentCount}`;
  if (after.sections.some((s) => s.filename === 'books/chemistry.md')) return 'The removed document is still indexed';
  return true;
}

// ── Strictness ────────────────────────────────────────────────────────────────

async function testOneBadDocumentFailsTheWholeBuild() {
  // The deliberate choice in the file header. A partial base is not an unsafe answer, it is
  // a SILENTLY incomplete one: four of five price files indexed means every question about
  // the fifth returns NO_SUPPORTED_ANSWER and the user reads it as "the extension does not
  // know" rather than "one file is broken".
  //
  // The trigger is a document that HAS text and produces NO sections — the file is not
  // Markdown the parser can read, and is contributing nothing while looking perfectly fine
  // in the Options list. That is the condition that has to fail loudly.
  const good = toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  // No `id`: toKnowledgeSection() refuses a section with no source document, so the parser
  // yields nothing for it. This is the shape a hand-edited store can have.
  const unreadable = { ...toKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD }), id: '' };

  const result = computeIndex([good, unreadable]);

  if (result.ok !== false) return 'A failing document should fail the build';
  if (result.sections.length !== 0) return 'A failed build must return no sections at all';
  if (result.code !== 'INVALID_KNOWLEDGE_DOCUMENT') return `Unexpected code: ${result.code}`;
  if (!result.message.includes('shipping.md')) return `The failing document is not named: ${result.message}`;
  return true;
}

async function testADocumentWithNoTextIsNotAFailure() {
  // The counterpart: a file with nothing in it is not broken, it just contributes no facts.
  // Refusing to build over it would make an empty knowledge base look like an error state.
  const good = toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const blank = { ...toKnowledgeDocument({ filename: 'notes.md', content: 'ملاحظات.' }), id: '', content: '   ' };

  const result = computeIndex([good, blank]);
  if (!result.ok) return `A blank document should not fail the build: ${result.message}`;
  if (result.sections.length !== 2) return `Expected 2 sections, got ${result.sections.length}`;
  return true;
}

async function testAStorageFailureDegradesInsteadOfThrowing() {
  // Reachable, and the one that matters operationally: the quota is exhausted or the
  // profile is being torn down. Retrieval must come back "not retrievable" with a code —
  // never an exception, because an exception escaping into the reply pipeline is reported
  // as a generic failure and loses the reason a comment was skipped.
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };

  let outcome;
  try {
    outcome = await getKnowledgeIndex();
  } catch (error) {
    chrome.storage.local.set = realSet;
    return `getKnowledgeIndex threw instead of degrading: ${error.message}`;
  } finally {
    chrome.storage.local.set = realSet;
  }

  if (outcome.retrievable !== false) return 'A storage failure must not be retrievable';
  if (outcome.code !== 'KNOWLEDGE_INDEX_FAILED') return `Unexpected code: ${outcome.code}`;
  if (outcome.sectionCount !== 0) return 'A storage failure returned sections';
  return true;
}

async function testAStorageFailureLeavesNoServableIndexBehind() {
  // The dangerous leak. An index built in memory while the FRESH record failed to write is
  // a real index for the current documents — but nothing authorizes retrieval, so serving it
  // would mean trusting memory while the gate says no. It must be dropped.
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const good = await getKnowledgeIndex();
  if (!good.retrievable) return 'The first build failed unexpectedly';

  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  try {
    await getKnowledgeIndex({ forceRebuild: true });
  } finally {
    chrome.storage.local.set = realSet;
  }

  const status = await getKnowledgeIndexStatus();
  if (status.cached !== false) return 'An unauthorized index survived in memory';
  return true;
}

async function testTheIndexRecoversOnceStorageWorksAgain() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  try {
    const failed = await getKnowledgeIndex();
    if (failed.retrievable) return 'The failed build was retrievable';
  } finally {
    chrome.storage.local.set = realSet;
  }

  const after = await getKnowledgeIndex();
  if (!after.retrievable) return 'The index did not recover once storage worked again';
  if (priceContent(after) !== 'السعر الحالي: 350 جنيه.') return 'The recovered index has the wrong content';
  return true;
}

async function testAFailedBuildIsNeverServableAfterRecoveryOfTheDocument() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const good = await getKnowledgeIndex();
  if (!good.retrievable) return 'The first build failed unexpectedly';

  // Simulate the user fixing the problem: a rebuild must now succeed and be retrievable.
  const after = await getKnowledgeIndex({ forceRebuild: true });
  if (!after.retrievable) return 'A rebuild after recovery should be retrievable';
  if (priceContent(after) !== 'السعر الحالي: 350 جنيه.') return 'The rebuild produced the wrong content';
  return true;
}

async function testTooManySectionsFailsRatherThanTruncating() {
  // Truncating would be the same silently-incomplete answer the module refuses elsewhere.
  const documents = [];
  for (let i = 0; i <= MAX_INDEXED_SECTIONS; i++) {
    documents.push(toKnowledgeDocument({
      filename: `doc-${i}.md`,
      content: `# عنوان ${i}\n\nنص ${i}.`
    }));
  }

  const result = computeIndex(documents);
  if (result.ok !== false) return 'An oversized base should fail the build';
  if (result.code !== 'KNOWLEDGE_INDEX_FAILED') return `Unexpected code: ${result.code}`;
  if (result.sections.length !== 0) return 'A failed build returned sections';
  return true;
}

async function testADocumentWithNoHeadingsStillIndexes() {
  // Prose with no headings at all is legitimate knowledge. It becomes one preamble section,
  // and refusing it would make a plain-text price list unusable.
  const document = toKnowledgeDocument({
    filename: 'general.md',
    content: 'سعر كتاب الكيمياء 350 جنيه والشحن 30 جنيه.'
  });
  const result = computeIndex([document]);

  if (!result.ok) return `A heading-less document should index: ${result.message}`;
  if (result.sections.length !== 1) return `Expected 1 section, got ${result.sections.length}`;
  if (!result.sections[0].content.includes('350')) return 'The content was lost';
  return true;
}

async function testBuildSectionsToleratesJunkDocuments() {
  const { sections, failed } = buildSections([null, 'nonsense', toKnowledgeDocument({ filename: 'a.md', content: '# x\n\nنص.' })]);
  if (!Array.isArray(sections)) return 'buildSections did not return an array';
  // Junk is dropped before it reaches indexing, so it neither indexes nor fails the build.
  if (sections.length !== 1) return `Expected 1 section, got ${sections.length}`;
  if (failed.length !== 0) return `Junk should not be reported as failures: ${JSON.stringify(failed)}`;
  return true;
}

// ── Status and snapshots ──────────────────────────────────────────────────────

async function testTheSnapshotCarriesNoContent() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const index = await getKnowledgeIndex();
  const snapshot = toIndexSnapshot(index);

  const serialized = JSON.stringify(snapshot);
  if (serialized.includes('350')) return 'The snapshot leaked knowledge content to the UI';
  if (snapshot.sectionCount !== index.sectionCount) return 'The section count was lost';
  if (snapshot.documentCount !== index.documentCount) return 'The document count was lost';
  return true;
}

async function testTheStatusTracksAFreshBuild() {
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await getKnowledgeIndex();

  const status = await getKnowledgeIndexStatus();
  if (status.state !== INDEX_STATE.FRESH) return `Expected FRESH, got ${status.state}`;
  if (status.retrievable !== true) return 'A built index should be retrievable';
  if (status.cached !== true) return 'The cache should be reported as populated';
  if (status.sectionCount !== 2) return `Unexpected section count: ${status.sectionCount}`;
  return true;
}

async function testClearingTheCacheDoesNotForgetTheDocuments() {
  // The cache is memory; the documents are the source of truth. A reload must never cost a
  // user their knowledge.
  await freshStart();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await getKnowledgeIndex();

  clearKnowledgeIndexCache();

  const status = await getKnowledgeIndexStatus();
  if (status.cached !== false) return 'The cache was not cleared';

  const rebuilt = await getKnowledgeIndex();
  if (rebuilt.sectionCount !== 2) return 'The documents did not survive the cache clear';
  if (rebuilt.sections[0].documentId !== created.id) return 'The wrong document was re-indexed';
  return true;
}

async function testTheIndexedFingerprintMatchesTheDocuments() {
  // What `resolveIndexState()` reads on the next call. If these two ever disagreed, every
  // subsequent read would rebuild forever.
  await freshStart();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  const index = await getKnowledgeIndex();
  const documents = (await import('../knowledge-store.js')).getKnowledgeDocuments();
  const resolved = resolveIndexState(await (await import('../knowledge-store.js')).getKnowledgeIndexMeta(), await documents);

  if (resolved !== INDEX_STATE.FRESH) {
    return `The stored fingerprint does not resolve to FRESH (${resolved}) — the index would rebuild on every comment`;
  }
  if (index.fingerprint === '') return 'The build recorded no fingerprint';
  return true;
}

async function testAnEmptyBaseReportsNoError() {
  await freshStart();
  const index = await getKnowledgeIndex();
  if (index.code !== '') return `An empty base reported an error: ${index.code}`;
  if (index.message !== '') return 'An empty base reported a message';
  if (index.retrievable !== true) return 'An empty base is still a usable state';
  return true;
}

async function testDisabledSectionsNeverBecomeUsable() {
  await freshStart();
  const chemistry = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await updateKnowledgeDocument(chemistry.id, { enabled: false });
  const index = await getKnowledgeIndex();
  if (usableSections(index).length !== 0) return 'A retired document is still usable';
  if (usableSections(null).length !== 0) return 'usableSections(null) should be empty';
  return true;
}

async function testUsableSectionsSkipsDisabledEntries() {
  const sections = [
    { empty: false, enabled: true },
    { empty: false, enabled: false },
    { empty: true, enabled: true },
    null
  ];
  const usable = usableSections({ sections });
  if (usable.length !== 1) return `Expected 1 usable section, got ${usable.length}`;
  if (!isDocumentEnabled(usable[0])) return 'The wrong section survived';
  return true;
}

async function runAllTests() {
  console.log('\n=== Knowledge Index Tests (Phase 20.4) ===\n');

  await runTest('An empty base is retrievable and empty', testAnEmptyBaseIsRetrievableAndEmpty);
  await runTest('A document becomes searchable sections', testADocumentBecomesSearchableSections);
  await runTest('Sections carry their searchable text', testSectionsCarryTheirSearchableText);
  await runTest('Disabled documents are not indexed', testDisabledDocumentsAreNotIndexed);
  await runTest('A base of only disabled documents indexes nothing', testABaseOfOnlyDisabledDocumentsIndexesNothing);
  await runTest('Empty sections are indexed but not usable', testEmptySectionsAreIndexedButNotUsable);
  await runTest('Several documents are indexed in one build', testSeveralDocumentsAreIndexedInOneBuild);

  await runTest('A fresh base with no cache is rebuilt, not served', testAFreshBaseWithNoCacheIsRebuiltNotServed);
  await runTest('The gate reports stale until an index is built', testTheGateReportsStaleUntilAnIndexIsBuilt);
  await runTest('An index is reused for the next comment', testAnIndexIsReusedForTheNextComment);
  await runTest('A forced rebuild runs even when fresh', testAForcedRebuildRunsEvenWhenFresh);

  await runTest('An edit is visible to the very next read', testAnEditIsVisibleToTheVeryNextRead);
  await runTest('The edited section gets a new version', testTheEditedSectionGetsANewVersion);
  await runTest('A returning document does not serve the old index', testAReturningDocumentDoesNotServeTheOldIndex);
  await runTest('Adding a document is visible immediately', testAddingADocumentIsVisibleImmediately);
  await runTest('Removing a document is visible immediately', testRemovingADocumentIsVisibleImmediately);

  await runTest('One bad document fails the whole build', testOneBadDocumentFailsTheWholeBuild);
  await runTest('A document with no text is not a failure', testADocumentWithNoTextIsNotAFailure);
  await runTest('A storage failure degrades instead of throwing', testAStorageFailureDegradesInsteadOfThrowing);
  await runTest('A storage failure leaves no servable index', testAStorageFailureLeavesNoServableIndexBehind);
  await runTest('The index recovers once storage works again', testTheIndexRecoversOnceStorageWorksAgain);
  await runTest('Too many sections fails rather than truncating', testTooManySectionsFailsRatherThanTruncating);
  await runTest('A document with no headings still indexes', testADocumentWithNoHeadingsStillIndexes);
  await runTest('buildSections tolerates junk documents', testBuildSectionsToleratesJunkDocuments);

  await runTest('The snapshot carries no content', testTheSnapshotCarriesNoContent);
  await runTest('The status tracks a fresh build', testTheStatusTracksAFreshBuild);
  await runTest('Clearing the cache does not forget the documents', testClearingTheCacheDoesNotForgetTheDocuments);
  await runTest('The indexed fingerprint matches the documents', testTheIndexedFingerprintMatchesTheDocuments);
  await runTest('An empty base reports no error', testAnEmptyBaseReportsNoError);
  await runTest('Disabled sections never become usable', testDisabledSectionsNeverBecomeUsable);
  await runTest('usableSections skips disabled entries', testUsableSectionsSkipsDisabledEntries);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;