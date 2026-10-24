/**
 * Knowledge Store Tests — Phase 20.2
 *
 * These cases pin the four things the rest of Phase 20 depends on, and that a storage-layer
 * bug would break in the worst possible place: silently answering a comment from knowledge
 * the user has already changed.
 *
 *   1. EVERY MUTATION INVALIDATES THE INDEX. This is §38 Test 10's protection, and it lives
 *      in exactly one place — the write path. If a future mutation forgets to mark the index
 *      stale, Test 10 starts failing in a way no later test can detect.
 *   2. A CONTENT edit bumps the version; a METADATA edit does not. Re-enabling an old price
 *      list must not make it the most recently edited document and win the next conflict.
 *   3. WRITE FAILURES SURFACE. Swallowing them would show the user a document that was never
 *      saved — deliberately the opposite of queue-persistence, which is on the hot path.
 *   4. Overlapping mutations do not lose each other. The read-modify-write is serialized, and
 *      this is the case that proves it.
 *
 * Runs in the browser from knowledge-store-tests.html. chrome-storage-stub.js must be
 * imported first so `chrome` exists before knowledge-store.js is evaluated.
 */

import { resetStorage, readStore } from './chrome-storage-stub.js';
import {
  getKnowledgeDocuments,
  getKnowledgeDocument,
  getKnowledgeDocumentByFilename,
  addKnowledgeDocument,
  updateKnowledgeDocument,
  removeKnowledgeDocument,
  getKnowledgeIndexMeta,
  saveKnowledgeIndexMeta,
  getKnowledgeStats,
  MAX_TOTAL_KNOWLEDGE_CHARS,
  STORE_REJECTION,
  diffKnowledgeDocuments,
  watchKnowledgeDocuments
} from '../knowledge-store.js';
import {
  STORAGE_KEYS,
  INDEX_STATE,
  MAX_KNOWLEDGE_DOCUMENTS,
  MAX_DOCUMENT_CHARS,
  computeFingerprint,
  resolveIndexState,
  isDocumentEnabled,
  hashContent
} from '../knowledge-schema.js';

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

const CHEMISTRY_MD = '# كيمياء\n\n## السعر\n\n350 جنيه.\n';
const CHEMISTRY_UPDATED_MD = '# كيمياء\n\n## السعر\n\n370 جنيه.\n';
const SHIPPING_MD = '# الشحن\n\nشحن كتاب واحد: 30 جنيه.\n';

/**
 * Assert an operation is refused with a specific reason code.
 *
 * Branching on `error.reason` rather than the message is the point: the Options page needs
 * a stable code to render a useful message, and the messages are free to be reworded.
 *
 * @returns {Promise<string|true>} a failure description, or true on success
 */
async function expectRejection(fn, reason, why) {
  try {
    await fn();
  } catch (error) {
    if (error.reason !== reason) {
      return `${why}: expected reason ${reason}, got ${error.reason} (${error.message})`;
    }
    return true;
  }
  return `${why}: the operation was accepted`;
}

/** Build a FRESH index record for the documents currently stored. */
async function markIndexFresh() {
  const documents = await getKnowledgeDocuments();
  const enabled = documents.filter(isDocumentEnabled);
  await saveKnowledgeIndexMeta({
    fingerprint: computeFingerprint(enabled),
    state: INDEX_STATE.FRESH,
    documentCount: enabled.length,
    sectionCount: 3
  });
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function testAFreshProfileHasNoDocuments() {
  resetStorage();
  if ((await getKnowledgeDocuments()).length !== 0) return 'A fresh profile should have no documents';
  if ((await getKnowledgeDocument('anything')) !== null) return 'An unknown id should be null';
  if ((await getKnowledgeDocumentByFilename('books/chemistry.md')) !== null) {
    return 'An unknown filename should be null';
  }
  return true;
}

async function testAnAddRoundTripsThroughStorage() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const list = await getKnowledgeDocuments();
  if (list.length !== 1) return `Expected 1 document, got ${list.length}`;
  if (list[0].id !== created.id) return 'The stored id does not match the returned one';
  if (list[0].filename !== 'books/chemistry.md') return 'The filename was not normalized';
  if (list[0].category !== 'books') return 'The category was not derived';
  if (list[0].content !== CHEMISTRY_MD) return 'The content was altered — knowledge is stored verbatim';
  if (list[0].hash !== hashContent(CHEMISTRY_MD)) return 'The hash was not computed';
  if (list[0].version !== 1) return `A new document should be version 1, got ${list[0].version}`;
  if (!isDocumentEnabled(list[0])) return 'A newly added document should be enabled';
  return true;
}

async function testTheContentIsStoredInTheRawKeyNotASettingsKey() {
  // The whole point of reading `knowledgeDocuments` directly: a user with a large knowledge
  // base must not have it copied and deep-merged on every queue iteration. If this ever
  // moves into DEFAULT_CONFIG, this case is what catches it.
  resetStorage();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const raw = readStore();
  if (!Array.isArray(raw[STORAGE_KEYS.DOCUMENTS])) {
    return 'Documents are not stored under knowledgeDocuments';
  }
  if (raw.triggers !== undefined || raw.replyBehavior !== undefined) {
    return 'Knowledge documents leaked into the settings blob';
  }
  return true;
}

async function testDocumentsAreReadableByIdAndFilename() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  if ((await getKnowledgeDocument(created.id)).filename !== 'books/chemistry.md') {
    return 'Lookup by id failed';
  }
  // The messy form must find the same document: this is what a user typing
  // "Books\Chemistry.md" into the file box gets.
  const byName = await getKnowledgeDocumentByFilename('.\\Books\\Chemistry.md');
  if (!byName || byName.id !== created.id) return 'Lookup by filename failed or did not normalize';
  return true;
}

async function testMalformedStoredEntriesAreDroppedNotReturned() {
  resetStorage();
  const good = await addKnowledgeDocument({ filename: 'good.md', content: CHEMISTRY_MD });

  // A hand-edited or partially-written store must not answer a comment. Note this DROPS
  // rather than deletes: a missing field should not destroy a user's file.
  const raw = readStore();
  raw[STORAGE_KEYS.DOCUMENTS].push({ filename: 'broken.md' }, 'nonsense', null, { filename: 'x.txt', content: 'x' });
  await chrome.storage.local.set({ [STORAGE_KEYS.DOCUMENTS]: raw[STORAGE_KEYS.DOCUMENTS] });

  const list = await getKnowledgeDocuments();
  if (list.length !== 1) return `Expected only the usable document, got ${list.length}`;
  if (list[0].id !== good.id) return 'The wrong document survived';
  return true;
}

async function testACorruptStoreReadsAsEmptyRatherThanThrowing() {
  // The UI must still open and the pipeline must see an empty base, which resolves the index
  // to EMPTY and skips. That is the safe direction for a storage problem.
  resetStorage();
  await chrome.storage.local.set({ [STORAGE_KEYS.DOCUMENTS]: { not: 'an array' } });
  if ((await getKnowledgeDocuments()).length !== 0) return 'A corrupt store should read as empty';
  if ((await getKnowledgeStats()).total !== 0) return 'Stats should report an empty base';
  return true;
}

// ── Add ───────────────────────────────────────────────────────────────────────

async function testInvalidAddsAreRefusedWithAReason() {
  resetStorage();
  const cases = [
    [null, STORE_REJECTION.NOT_AN_OBJECT],
    ['nope', STORE_REJECTION.NOT_AN_OBJECT],
    [{ content: 'x' }, STORE_REJECTION.BAD_FILENAME],
    [{ filename: 'notes.txt', content: 'x' }, STORE_REJECTION.BAD_FILENAME],
    [{ filename: '../escape.md', content: 'x' }, STORE_REJECTION.BAD_FILENAME],
    [{ filename: 'a.md' }, STORE_REJECTION.NOT_AN_OBJECT],
    [{ filename: 'a.md', content: '   \n ' }, STORE_REJECTION.EMPTY_CONTENT],
    [{ filename: 'a.md', content: 'x'.repeat(MAX_DOCUMENT_CHARS + 1) }, STORE_REJECTION.CONTENT_TOO_LONG]
  ];
  for (const [input, reason] of cases) {
    const outcome = await expectRejection(() => addKnowledgeDocument(input), reason, JSON.stringify(input));
    if (outcome !== true) return outcome;
  }
  if ((await getKnowledgeDocuments()).length !== 0) return 'A refused add still wrote something';
  return true;
}

async function testADuplicateFilenameIsRefusedCaseInsensitively() {
  resetStorage();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  // Two files claiming one name are a conflict the user has not resolved. Catching it here
  // is far cheaper than reporting CONFLICTING_KNOWLEDGE on every price question afterwards.
  const outcome = await expectRejection(
    () => addKnowledgeDocument({ filename: 'Books/Chemistry.MD', content: '370 جنيه' }),
    STORE_REJECTION.DUPLICATE_FILENAME,
    'a case-differing duplicate'
  );
  if (outcome !== true) return outcome;

  if ((await getKnowledgeDocuments()).length !== 1) return 'The duplicate was written anyway';
  return true;
}

async function testTheDocumentListIsCapped() {
  resetStorage();
  for (let i = 0; i < MAX_KNOWLEDGE_DOCUMENTS; i++) {
    await addKnowledgeDocument({ filename: `doc-${i}.md`, content: `# ${i}` });
  }
  const outcome = await expectRejection(
    () => addKnowledgeDocument({ filename: 'one-too-many.md', content: '# x' }),
    STORE_REJECTION.TOO_MANY_DOCUMENTS,
    'the document cap'
  );
  if (outcome !== true) return outcome;
  if ((await getKnowledgeDocuments()).length !== MAX_KNOWLEDGE_DOCUMENTS) return 'The cap was exceeded';
  return true;
}

/** Content of an exact length, comfortably inside MAX_DOCUMENT_CHARS. */
function padded(chars) {
  return 'سعر الكتاب 350 جنيه.\n'.repeat(Math.ceil(chars / 21)).slice(0, chars);
}

async function testTheTotalSizeIsCapped() {
  // chrome.storage.local is quota-limited and SHARED with settings, logs, handled comments
  // and pending jobs, so the budget is enforced here rather than discovered as a QUOTA_BYTES
  // failure somewhere else entirely. Each document stays legal; it is the SUM that must be
  // refused, which is why this needs several documents rather than one giant one.
  resetStorage();
  const near = MAX_DOCUMENT_CHARS - 10;

  let stored = 0;
  for (let i = 0; stored + near <= MAX_TOTAL_KNOWLEDGE_CHARS; i++) {
    await addKnowledgeDocument({ filename: `doc-${i}.md`, content: padded(near) });
    stored += near;
  }

  const outcome = await expectRejection(
    () => addKnowledgeDocument({ filename: 'one-more.md', content: padded(near) }),
    STORE_REJECTION.STORE_TOO_LARGE,
    'the total size cap'
  );
  if (outcome !== true) return outcome;

  const stats = await getKnowledgeStats();
  if (stats.chars > MAX_TOTAL_KNOWLEDGE_CHARS) return `Stored ${stats.chars} chars, over the budget`;
  return true;
}

// ── Update ────────────────────────────────────────────────────────────────────

async function testAContentEditBumpsTheVersionAndTheHash() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const updated = await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });

  if (updated.version !== created.version + 1) return `Version should have bumped, got ${updated.version}`;
  if (updated.hash === created.hash) return 'The hash did not change with the content';
  if (updated.id !== created.id) return 'The id changed on an update';
  if ((await getKnowledgeDocument(created.id)).hash !== updated.hash) return 'The new hash was not persisted';
  return true;
}

async function testReplacingAFileWithTheSameTextIsNotARevision() {
  // A user who opens the editor and saves without changing anything has not superseded the
  // document. Bumping the version here would make an old file outrank a genuinely newer one.
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const resaved = await updateKnowledgeDocument(created.id, { content: CHEMISTRY_MD });

  if (resaved.version !== created.version) return 'Re-saving identical text bumped the version';
  if (resaved.updatedAt !== created.updatedAt) return 'Re-saving identical text moved updatedAt';
  return true;
}

async function testAMetadataEditLeavesTheRevisionAlone() {
  // This asymmetry is load-bearing. `updatedAt` means "this document's text was last
  // edited", which is what §18 precedence reads. If switching a document off and on again
  // touched it, re-enabling an old price list would make it the most recent document and it
  // would start winning conflicts — visible to the user as "it answered with the old price".
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const disabled = await updateKnowledgeDocument(created.id, { enabled: false });
  if (disabled.version !== created.version) return 'Disabling bumped the version';
  if (disabled.updatedAt !== created.updatedAt) return 'Disabling moved updatedAt';
  if (disabled.hash !== created.hash) return 'Disabling changed the hash';
  if (isDocumentEnabled(disabled)) return 'Disabling did not take effect';

  const reprioritised = await updateKnowledgeDocument(created.id, { priority: 5 });
  if (reprioritised.version !== created.version) return 'A priority change bumped the version';
  if (reprioritised.updatedAt !== created.updatedAt) return 'A priority change moved updatedAt';
  if (reprioritised.priority !== 5) return 'The priority was not stored';
  return true;
}

async function testAnUpdatePreservesFieldsItDoesNotMention() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await updateKnowledgeDocument(created.id, { priority: 7, enabled: false });

  const updated = await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });
  if (updated.priority !== 7) return 'The priority was lost';
  if (updated.enabled !== false) return 'The enabled flag was lost';
  if (updated.filename !== 'books/chemistry.md') return 'The filename was lost';
  return true;
}

async function testARenameMovesUpdatedAtButNotTheVersion() {
  // A rename changes no fact, so it does not supersede a version — but the path a fact is
  // cited under is part of the evidence a reply carries, so updatedAt does move.
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'old.md', content: CHEMISTRY_MD });
  const renamed = await updateKnowledgeDocument(created.id, { filename: 'books/chemistry.md' });

  if (renamed.filename !== 'books/chemistry.md') return 'The rename was not applied';
  if (renamed.category !== 'books') return 'The category was not re-derived';
  if (renamed.version !== created.version) return 'A rename should not bump the version';
  if (renamed.updatedAt < created.updatedAt) return 'A rename should move updatedAt';
  return true;
}

async function testARenameCannotCollideWithAnotherDocument() {
  resetStorage();
  const a = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'books/biology.md', content: SHIPPING_MD });

  const outcome = await expectRejection(
    () => updateKnowledgeDocument(a.id, { filename: 'books/biology.md' }),
    STORE_REJECTION.DUPLICATE_FILENAME,
    'a colliding rename'
  );
  if (outcome !== true) return outcome;

  const list = await getKnowledgeDocuments();
  if (list[0].filename !== 'books/chemistry.md') return 'The failed rename was written anyway';
  return true;
}

async function testARenameToItsOwnNameIsNotACollision() {
  // Saving the form without touching the path is the most ordinary thing a user does, and it
  // must not be refused as a duplicate of itself.
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const updated = await updateKnowledgeDocument(created.id, { filename: 'books/chemistry.md' });

  if (updated.filename !== 'books/chemistry.md') return 'The no-op rename broke the document';
  return true;
}

async function testUpdatingAnUnknownDocumentIsRefused() {
  resetStorage();
  const outcome = await expectRejection(
    () => updateKnowledgeDocument('kdoc-nope', { content: 'x' }),
    STORE_REJECTION.NOT_FOUND,
    'an unknown id'
  );
  if (outcome !== true) return outcome;

  const empty = await expectRejection(() => updateKnowledgeDocument('', { content: 'x' }), STORE_REJECTION.NOT_FOUND, 'an empty id');
  return empty === true;
}

async function testAnUpdateCannotWriteAnInvalidDocument() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  // An update goes through the same normalizer `add` uses, so it cannot write a shape the
  // add path would have refused.
  const empty = await expectRejection(
    () => updateKnowledgeDocument(created.id, { content: '   ' }),
    STORE_REJECTION.EMPTY_CONTENT,
    'emptying the content'
  );
  if (empty !== true) return empty;

  const badName = await expectRejection(
    () => updateKnowledgeDocument(created.id, { filename: 'notes.txt' }),
    STORE_REJECTION.BAD_FILENAME,
    'renaming to a non-Markdown file'
  );
  if (badName !== true) return badName;

  const traversal = await expectRejection(
    () => updateKnowledgeDocument(created.id, { filename: '../../etc/passwd.md' }),
    STORE_REJECTION.BAD_FILENAME,
    'renaming to a traversal path'
  );
  if (traversal !== true) return traversal;

  const stored = await getKnowledgeDocument(created.id);
  if (stored.content !== CHEMISTRY_MD) return 'The refused update damaged the document';
  return true;
}

async function testAnUpdateCannotExceedTheTotalSizeCap() {
  // The cap must hold on the update path too, not just on add: a user pasting a larger
  // revision into an existing file is the likeliest way to blow the quota.
  resetStorage();
  const near = MAX_DOCUMENT_CHARS - 10;
  let stored = 0;
  for (let i = 0; stored + near <= MAX_TOTAL_KNOWLEDGE_CHARS; i++) {
    await addKnowledgeDocument({ filename: `doc-${i}.md`, content: padded(near) });
    stored += near;
  }

  // One document is created small, then grown past what the base can hold.
  const target = await addKnowledgeDocument({ filename: 'grow.md', content: '# صغير\n' });
  const outcome = await expectRejection(
    () => updateKnowledgeDocument(target.id, { content: padded(MAX_DOCUMENT_CHARS) }),
    STORE_REJECTION.STORE_TOO_LARGE,
    'growing the base past the budget'
  );
  if (outcome !== true) return outcome;

  const survivor = await getKnowledgeDocument(target.id);
  if (survivor.content !== '# صغير\n') return 'The refused update damaged the document';
  return true;
}

// ── Remove ────────────────────────────────────────────────────────────────────

async function testRemoveDeletesTheDocument() {
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });

  await removeKnowledgeDocument(created.id);
  const list = await getKnowledgeDocuments();
  if (list.length !== 1) return `Expected 1 remaining document, got ${list.length}`;
  if (list[0].filename !== 'shipping.md') return 'The wrong document was removed';

  const outcome = await expectRejection(
    () => removeKnowledgeDocument(created.id),
    STORE_REJECTION.NOT_FOUND,
    'removing it twice'
  );
  return outcome === true;
}

// ── Index invalidation ────────────────────────────────────────────────────────

async function testEveryMutationInvalidatesTheIndex() {
  // THIS IS §38 TEST 10. If a mutation ever forgets to mark the index stale, a comment is
  // answered from knowledge the user has already changed — and no later milestone can
  // detect it, because the sections are not stored anywhere to contradict that.
  resetStorage();
  const created = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });

  const expectNotFresh = async (label) => {
    const state = resolveIndexState(await getKnowledgeIndexMeta(), await getKnowledgeDocuments());
    if (state === INDEX_STATE.FRESH) return `${label} left the index FRESH`;
    if (state !== INDEX_STATE.STALE && state !== INDEX_STATE.EMPTY) return `${label} produced ${state}`;
    return true;
  };

  await markIndexFresh();
  await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });
  const added = await expectNotFresh('An add');
  if (added !== true) return added;

  await markIndexFresh();
  await updateKnowledgeDocument(created.id, { content: CHEMISTRY_UPDATED_MD });
  const edited = await expectNotFresh('A content edit');
  if (edited !== true) return edited;

  await markIndexFresh();
  await updateKnowledgeDocument(created.id, { enabled: false });
  const toggled = await expectNotFresh('A metadata edit');
  if (toggled !== true) return toggled;

  await markIndexFresh();
  const enabled = (await getKnowledgeDocuments()).find(isDocumentEnabled);
  await removeKnowledgeDocument(enabled.id);
  const removed = await expectNotFresh('Removing an enabled document');
  return removed === true;
}

async function testRemovingADisabledDocumentKeepsTheIndexUsable() {
  // The counterpart to invalidation, and the case that proves the fingerprint is doing real
  // work rather than being invalidated unconditionally.
  //
  // A document that is already switched OFF is not in the fingerprint — it cannot be
  // retrieved from and cannot be cited as evidence. Deleting it therefore changes nothing
  // about what any future answer would say, so the index stays FRESH and the base is not
  // re-parsed for a file nobody could read anyway.
  resetStorage();
  const kept = await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const retired = await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });
  await updateKnowledgeDocument(retired.id, { enabled: false });
  await markIndexFresh();

  if (resolveIndexState(await getKnowledgeIndexMeta(), await getKnowledgeDocuments()) !== INDEX_STATE.FRESH) {
    return 'The base should be fresh before the removal';
  }
  await removeKnowledgeDocument(retired.id);

  const after = resolveIndexState(await getKnowledgeIndexMeta(), await getKnowledgeDocuments());
  if (after !== INDEX_STATE.FRESH) return `Removing a disabled document invalidated the index (${after})`;
  if ((await getKnowledgeDocument(kept.id)) === null) return 'The wrong document was removed';
  return true;
}

async function testAFreshIndexSurvivesANoOpSave() {
  // The other half of invalidation: a save that changes nothing must NOT invalidate, or the
  // index would rebuild on every visit to the Options page.
  resetStorage();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  await markIndexFresh();

  const stored = await getKnowledgeDocuments();
  if (resolveIndexState(await getKnowledgeIndexMeta(), stored) !== INDEX_STATE.FRESH) {
    return 'A matching fingerprint should read as FRESH';
  }

  await updateKnowledgeDocument(stored[0].id, { filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const after = resolveIndexState(await getKnowledgeIndexMeta(), await getKnowledgeDocuments());
  if (after !== INDEX_STATE.FRESH) return `A no-op save invalidated a usable index (${after})`;
  return true;
}

async function testIndexMetadataIsReadAndSanitized() {
  resetStorage();
  if ((await getKnowledgeIndexMeta()).state !== INDEX_STATE.EMPTY) return 'A fresh store should read as EMPTY';

  await saveKnowledgeIndexMeta({ fingerprint: 'abc', state: INDEX_STATE.FRESH, sectionCount: 4, builtAt: 123 });
  const meta = await getKnowledgeIndexMeta();
  if (meta.fingerprint !== 'abc' || meta.state !== INDEX_STATE.FRESH) return 'Metadata did not round trip';
  if (meta.sectionCount !== 4 || meta.builtAt !== 123) return 'Counts did not round trip';

  // A FAILED record keeps its reason for the UI, and is still never retrievable.
  await saveKnowledgeIndexMeta({ fingerprint: 'abc', state: INDEX_STATE.FAILED, error: 'parser blew up' });
  const failed = await getKnowledgeIndexMeta();
  if (failed.error !== 'parser blew up') return 'The failure reason was dropped';
  if (resolveIndexState(failed, await getKnowledgeDocuments()) === INDEX_STATE.FRESH) {
    return 'A FAILED record must not read as retrievable';
  }
  return true;
}

// ── Concurrency ───────────────────────────────────────────────────────────────

async function testOverlappingMutationsDoNotLoseEachOther() {
  // Every mutation is a read-modify-write. Three adds fired at once without the write chain
  // would each read the same empty list, and the last write would win: the user would have
  // added three documents and kept one.
  resetStorage();
  await Promise.all([
    addKnowledgeDocument({ filename: 'a.md', content: '# A' }),
    addKnowledgeDocument({ filename: 'b.md', content: '# B' }),
    addKnowledgeDocument({ filename: 'c.md', content: '# C' })
  ]);

  const list = await getKnowledgeDocuments();
  if (list.length !== 3) return `Expected 3 documents, got ${list.length}`;
  if (new Set(list.map((doc) => doc.filename)).size !== 3) {
    return 'Documents were overwritten rather than appended';
  }
  return true;
}

async function testAFailedMutationDoesNotWedgeTheStore() {
  // A rejected write must not leave the chain rejected, or every later save in the session
  // would fail with the first error.
  resetStorage();
  const rejected = await expectRejection(
    () => addKnowledgeDocument({ filename: 'bad.txt', content: 'x' }),
    STORE_REJECTION.BAD_FILENAME,
    'a rejected add'
  );
  if (rejected !== true) return rejected;

  const created = await addKnowledgeDocument({ filename: 'good.md', content: CHEMISTRY_MD });
  if (!created || !created.id) return 'The store was still wedged after a rejection';
  if ((await getKnowledgeDocuments()).length !== 1) return 'The good document did not save';
  return true;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function testStatsSummarizeTheBase() {
  resetStorage();
  await addKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const second = await addKnowledgeDocument({ filename: 'shipping.md', content: SHIPPING_MD });
  await updateKnowledgeDocument(second.id, { enabled: false });

  const stats = await getKnowledgeStats();
  if (stats.total !== 2) return `Expected 2 documents, got ${stats.total}`;
  if (stats.enabled !== 1) return `Expected 1 enabled document, got ${stats.enabled}`;
  if (stats.disabled !== 1) return `Expected 1 disabled document, got ${stats.disabled}`;
  if (stats.chars !== CHEMISTRY_MD.length + SHIPPING_MD.length) return `Unexpected char count: ${stats.chars}`;
  if (stats.maxDocuments !== MAX_KNOWLEDGE_DOCUMENTS) return 'The cap is not exposed to the UI';

  // The fingerprint must be over the ENABLED documents only: a disabled document cannot
  // affect a retrieval, so it must not affect freshness either.
  const enabledOnly = await getKnowledgeDocuments();
  const expected = computeFingerprint(enabledOnly.filter(isDocumentEnabled));
  if (stats.fingerprint !== expected) return 'The stats fingerprint does not match the enabled set';
  return true;
}

async function runAllTests() {
  console.log('\n=== Knowledge Store Tests (Phase 20.2) ===\n');

  await runTest('A fresh profile has no documents', testAFreshProfileHasNoDocuments);
  await runTest('An add round trips through storage', testAnAddRoundTripsThroughStorage);
  await runTest('Documents live in their own key, not the settings blob', testTheContentIsStoredInTheRawKeyNotASettingsKey);
  await runTest('Documents are readable by id and filename', testDocumentsAreReadableByIdAndFilename);
  await runTest('Malformed stored entries are dropped, not returned', testMalformedStoredEntriesAreDroppedNotReturned);
  await runTest('A corrupt store reads as empty rather than throwing', testACorruptStoreReadsAsEmptyRatherThanThrowing);

  await runTest('Invalid adds are refused with a reason', testInvalidAddsAreRefusedWithAReason);
  await runTest('A duplicate filename is refused case-insensitively', testADuplicateFilenameIsRefusedCaseInsensitively);
  await runTest('The document list is capped', testTheDocumentListIsCapped);
  await runTest('The total size is capped', testTheTotalSizeIsCapped);

  await runTest('A content edit bumps the version and the hash', testAContentEditBumpsTheVersionAndTheHash);
  await runTest('Re-saving identical text is not a revision', testReplacingAFileWithTheSameTextIsNotARevision);
  await runTest('A metadata edit leaves the revision alone', testAMetadataEditLeavesTheRevisionAlone);
  await runTest('An update preserves fields it does not mention', testAnUpdatePreservesFieldsItDoesNotMention);
  await runTest('A rename moves updatedAt but not the version', testARenameMovesUpdatedAtButNotTheVersion);
  await runTest('A rename cannot collide with another document', testARenameCannotCollideWithAnotherDocument);
  await runTest('A rename to its own name is not a collision', testARenameToItsOwnNameIsNotACollision);
  await runTest('Updating an unknown document is refused', testUpdatingAnUnknownDocumentIsRefused);
  await runTest('An update cannot write an invalid document', testAnUpdateCannotWriteAnInvalidDocument);
  await runTest('An update cannot exceed the total size cap', testAnUpdateCannotExceedTheTotalSizeCap);

  await runTest('Remove deletes the document', testRemoveDeletesTheDocument);

  await runTest('Every mutation that changes an answer invalidates the index', testEveryMutationInvalidatesTheIndex);
  await runTest('Removing a disabled document keeps the index usable', testRemovingADisabledDocumentKeepsTheIndexUsable);
  await runTest('A fresh index survives a no-op save', testAFreshIndexSurvivesANoOpSave);
  await runTest('Index metadata is read and sanitized', testIndexMetadataIsReadAndSanitized);

  await runTest('Overlapping mutations do not lose each other', testOverlappingMutationsDoNotLoseEachOther);
  await runTest('A failed mutation does not wedge the store', testAFailedMutationDoesNotWedgeTheStore);

  await runTest('Stats summarize the base', testStatsSummarizeTheBase);

  console.log('\n--- Phase 20.20: the change-detection seam ---');
  await runTest('The diff reports an addition', testDiffReportsAnAddition);
  await runTest('The diff identifies by id, not position', testDiffIdentifiesByIdNotPosition);
  await runTest('The diff reports a removal with the old filename', testDiffReportsARemovalWithTheOldFilename);
  await runTest('The diff treats a rename as remove plus add', testDiffTreatsARenameAsRemovePlusAdd);
  await runTest('The diff survives junk', testDiffSurvivesJunk);
  await runTest('watch registers and unsubscribes', testWatchRegistersAndUnsubscribes);
  await runTest('watch ignores other keys and areas', testWatchIgnoresOtherKeysAndOtherAreas);
  await runTest('watch is inert without storage', testWatchIsInertWithoutStorage);
  await runTest('watch swallows a throwing handler', testWatchSwallowsAThrowingHandler);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}


/**
 * ── Phase 20.20: the change-detection seam ─────────────────────────────────────
 *
 * `watchKnowledgeDocuments()` exists because the worker is forbidden from naming the
 * knowledge keys, so this is the only way change detection can be wired at all. Driving it
 * through a real worker proves the wiring; nothing else proves the DIFF, and a diff that
 * mislabels a removal as an update sends a user looking at the wrong file.
 */

/** Install a minimal `chrome.storage.onChanged` and return the registered listeners. */
function withStorageListener() {
  const listeners = [];
  globalThis.chrome = {
    storage: {
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        }
      }
    }
  };
  return listeners;
}

async function testDiffReportsAnAddition() {
  const changes = diffKnowledgeDocuments([], [{ id: 'a', filename: 'one.md' }]);
  if (changes.length !== 1) return `changes=${changes.length}, expected 1`;
  if (changes[0].operation !== 'added') return `operation=${changes[0].operation}`;
  if (changes[0].filename !== 'one.md') return `filename=${changes[0].filename}`;
  return true;
}

async function testDiffIdentifiesByIdNotPosition() {
  // Identity is the document id. Comparing positions would call a reorder an update of two
  // unrelated files, which is exactly the kind of plausible-but-wrong entry that sends a
  // user to the wrong document.
  const changes = diffKnowledgeDocuments(
    [{ id: 'a', filename: 'one.md' }, { id: 'b', filename: 'two.md' }],
    [{ id: 'b', filename: 'two.md' }, { id: 'a', filename: 'one.md' }]
  );
  if (changes.length !== 2) return `changes=${changes.length}, expected 2`;
  if (!changes.every((c) => c.operation === 'updated')) {
    return `a reorder must not change any operation: ${changes.map((c) => c.operation).join(',')}`;
  }
  return true;
}

async function testDiffReportsARemovalWithTheOldFilename() {
  const changes = diffKnowledgeDocuments([{ id: 'a', filename: 'gone.md' }], []);
  if (changes.length !== 1) return `changes=${changes.length}`;
  if (changes[0].operation !== 'removed') return `operation=${changes[0].operation}`;
  // The only place this filename exists: a removal has no new list to read it from.
  if (changes[0].filename !== 'gone.md') return `filename="${changes[0].filename}"`;
  return true;
}

async function testDiffTreatsARenameAsRemovePlusAdd() {
  // A rename changes the id, so it really is two documents from the index's point of view.
  // Labelling it "updated" would hide that the old name is gone.
  const changes = diffKnowledgeDocuments(
    [{ id: 'a', filename: 'old.md' }],
    [{ id: 'b', filename: 'new.md' }]
  );
  const ops = changes.map((c) => c.operation).sort().join(',');
  return ops === 'added,removed' || `operations=${ops}`;
}

async function testDiffSurvivesJunk() {
  if (diffKnowledgeDocuments(undefined, undefined).length !== 0) return 'undefined lists must diff to nothing';
  if (diffKnowledgeDocuments([null, {}], [{ id: 'a' }]).length !== 1) return 'a null entry must be skipped';
  // A document with no id cannot be tracked across a change, so it is not reported at all
  // rather than reported as a phantom addition.
  if (diffKnowledgeDocuments([{ id: '' }], []).length !== 0) return 'an id-less document must not be reported';
  return true;
}

async function testWatchRegistersAndUnsubscribes() {
  const listeners = withStorageListener();
  const off = watchKnowledgeDocuments(() => {});
  if (listeners.length !== 1) return `listeners=${listeners.length}, expected 1`;
  off();
  if (listeners.length !== 0) return `the unsubscribe left ${listeners.length} listeners`;
  return true;
}

async function testWatchIgnoresOtherKeysAndOtherAreas() {
  const listeners = withStorageListener();
  const seen = [];
  watchKnowledgeDocuments((payload) => seen.push(payload));

  // Another key entirely — `enabled` changes on every options save, so a listener that
  // matched loosely would fire constantly and drown the one event that matters.
  listeners[0]({ enabled: { newValue: false } }, 'local');
  // The right key, wrong storage area.
  listeners[0]({ knowledgeDocuments: { newValue: [] } }, 'sync');
  if (seen.length !== 0) return `the handler fired ${seen.length} time(s) for irrelevant events`;

  listeners[0]({
    knowledgeDocuments: {
      oldValue: [{ id: 'a', filename: 'one.md' }],
      newValue: [{ id: 'a', filename: 'one.md' }, { id: 'b', filename: 'two.md' }]
    }
  }, 'local');
  if (seen.length !== 1) return `the relevant change was not delivered`;
  if (seen[0].documents.length !== 2) return `documents=${seen[0].documents.length}`;
  if (seen[0].changes.length !== 2) return `changes=${seen[0].changes.length}`;
  return true;
}

async function testWatchIsInertWithoutStorage() {
  delete globalThis.chrome;
  let off;
  try {
    off = watchKnowledgeDocuments(() => {});
  } catch (error) {
    return `it threw without chrome.storage: ${error.message}`;
  }
  if (typeof off !== 'function') return 'it must still return an unsubscribe function';
  return true;
}

async function testWatchSwallowsAThrowingHandler() {
  // A notification must never be able to break the worker: `chrome.storage.onChanged`
  // listeners run on the event loop, and an exception there surfaces nowhere useful.
  const listeners = withStorageListener();
  watchKnowledgeDocuments(() => {
    throw new Error('boom');
  });
  try {
    listeners[0]({ knowledgeDocuments: { oldValue: [], newValue: [] } }, 'local');
  } catch (error) {
    return `the handler exception escaped: ${error.message}`;
  }
  return true;
}

export default runAllTests;