/**
 * Knowledge Store — Phase 20.2
 *
 * The user's Markdown knowledge documents, and nothing else. This is the CRUD layer: add,
 * replace/update, remove, load, basic metadata and validation.
 *
 * WHY THIS IS NOT A SETTINGS MODULE
 * ---------------------------------
 * `knowledgeDocuments` and `knowledgeIndexMeta` are read straight from
 * `chrome.storage.local`, exactly like `handledComments`, `pendingJobs` and `activityLogs`.
 * They must NOT be added to `DEFAULT_CONFIG` or to the explicit key list in `getSettings()`:
 * they are user content, and deep-merging a 40-document knowledge base into a fresh object
 * on every queue iteration would be both absurd and slow. Nothing here imports storage.js.
 *
 * WHY WRITE FAILURES THROW HERE BUT ARE SWALLOWED ELSEWHERE
 * ---------------------------------------------------------
 * `handled-comments.js` and `queue-persistence.js` deliberately swallow storage errors,
 * because they run on the hot reply path and a storage hiccup must never stop replies. This
 * module is the opposite case: every call is a user action on the Options page, and a silent
 * failure there would leave the screen showing a document that was never saved. A user who
 * pastes their price list deserves to be told it did not save. The error is still logged.
 *
 * EVERY MUTATION INVALIDATES THE INDEX
 * -------------------------------------
 * Each write also marks `knowledgeIndexMeta` STALE. That is the whole of §38 Test 10's
 * protection at this layer: an edit the user made cannot be answered from an index built
 * before it. There is nothing else to do here, and nothing to forget later — the invalidation
 * lives in the one place every mutation goes through.
 *
 * PRIVACY
 * -------
 * `knowledgeDocuments` holds the user's own commercial content (prices, policies), which is
 * the most sensitive data this extension stores. It never leaves the profile except as the
 * retrieved sections the model is asked to ground a reply in, and docs/SECURITY_REVIEW.md
 * records it.
 */

import { logError, devWarn, YTAR_DEVLOG, DEV_LOG_COMPONENT as C } from './debug.js';
import {
  STORAGE_KEYS,
  INDEX_STATE,
  MAX_KNOWLEDGE_DOCUMENTS,
  MAX_DOCUMENT_CHARS,
  normalizeFilename,
  toKnowledgeDocument,
  toIndexMeta,
  computeFingerprint,
  isSameDocumentFilename,
  isDocumentEnabled,
  hashContent
} from './knowledge-schema.js';

/**
 * Most characters of knowledge the extension will hold in total.
 *
 * `chrome.storage.local` is quota-limited (10 MB with the `storage` permission declared in
 * this manifest) and that quota is SHARED with settings, activity logs, handled comments
 * and pending jobs. At worst case three bytes per character (CJK), one million characters
 * is about 3 MB — comfortably inside it — so a user who hits this limit gets a clear
 * message here instead of a `QUOTA_BYTES` failure somewhere else entirely.
 */
export const MAX_TOTAL_KNOWLEDGE_CHARS = 1_000_000;

/**
 * Why a document operation was refused.
 *
 * Attached to the thrown Error as `.reason` so the Options page and the tests can branch
 * on the code without parsing an English message, which is free to be reworded.
 */
export const STORE_REJECTION = Object.freeze({
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  BAD_FILENAME: 'BAD_FILENAME',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  CONTENT_TOO_LONG: 'CONTENT_TOO_LONG',
  DUPLICATE_FILENAME: 'DUPLICATE_FILENAME',
  TOO_MANY_DOCUMENTS: 'TOO_MANY_DOCUMENTS',
  STORE_TOO_LARGE: 'STORE_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  WRITE_FAILED: 'WRITE_FAILED'
});

/** Messages paired with the reasons above, so the user is told something actionable. */
const REJECTION_MESSAGES = Object.freeze({
  [STORE_REJECTION.NOT_AN_OBJECT]: 'Invalid knowledge document: must be a non-null object',
  [STORE_REJECTION.BAD_FILENAME]: 'Invalid knowledge document: the filename must end in .md or .markdown',
  [STORE_REJECTION.EMPTY_CONTENT]: 'Invalid knowledge document: the content is empty',
  [STORE_REJECTION.CONTENT_TOO_LONG]: 'Invalid knowledge document: the content is too long',
  [STORE_REJECTION.DUPLICATE_FILENAME]: 'A knowledge document with that filename already exists',
  [STORE_REJECTION.TOO_MANY_DOCUMENTS]: `Cannot add more than ${MAX_KNOWLEDGE_DOCUMENTS} knowledge documents`,
  [STORE_REJECTION.STORE_TOO_LARGE]: `The knowledge base is too large (limit ${MAX_TOTAL_KNOWLEDGE_CHARS} characters)`,
  [STORE_REJECTION.NOT_FOUND]: 'Knowledge document not found',
  [STORE_REJECTION.WRITE_FAILED]: 'Could not save the knowledge base'
});

/** Throw a rejection carrying both a stable code and a readable message. */
function reject(reason, detail) {
  const error = new Error(detail ? `${REJECTION_MESSAGES[reason]} (${detail})` : REJECTION_MESSAGES[reason]);
  error.reason = reason;
  throw error;
}

/**
 * Serialize writes through a single promise chain.
 *
 * Every mutation is a read-modify-write, and unlike the queue these come from user clicks
 * that can genuinely overlap (two rapid saves, or a save racing a remove). Chaining keeps
 * both without inventing a lock. A failed task does not block the next one — the chain
 * carries a catch so one failure cannot wedge the store for the rest of the session.
 */
let writeChain = Promise.resolve();

function serialize(task) {
  const run = writeChain.then(task);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Refuse an input that `toKnowledgeDocument()` rejected, naming WHY.
 *
 * `toKnowledgeDocument()` returns null without saying which rule it broke, and "it is
 * null" is not an answer a user can act on. The checks run in the same order the schema
 * applies them, so the reason matches the constraint that actually failed.
 *
 * @param {*} input
 * @throws {Error} always — with `.reason` set
 */
function rejectUnusableDocument(input) {
  if (!input || typeof input !== 'object') reject(STORE_REJECTION.NOT_AN_OBJECT);

  const filename = normalizeFilename(input.filename);
  if (!filename) reject(STORE_REJECTION.BAD_FILENAME);

  const content = input.content;
  if (typeof content !== 'string') reject(STORE_REJECTION.NOT_AN_OBJECT);
  if (content.trim().length === 0) reject(STORE_REJECTION.EMPTY_CONTENT);
  if (content.length > MAX_DOCUMENT_CHARS) reject(STORE_REJECTION.CONTENT_TOO_LONG);

  // Unreachable in practice: toKnowledgeDocument() accepted this very input.
  reject(STORE_REJECTION.NOT_AN_OBJECT);
}

/** Total characters of content across a document list. */
function totalChars(documents) {
  return documents.reduce((sum, doc) => sum + (doc && typeof doc.content === 'string' ? doc.content.length : 0), 0);
}

// ── Internal IO ───────────────────────────────────────────────────────────────

/**
 * Read both knowledge keys.
 *
 * Returns raw values; normalization is the caller's business because only the document list
 * needs it. A read failure returns empty shapes rather than throwing: the UI must still open
 * and say "no documents", and the reply pipeline must see an empty base — which resolves
 * the index to EMPTY and skips, the safe direction.
 */
async function readStore() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.DOCUMENTS, STORAGE_KEYS.INDEX_META]);
    return {
      documents: result && Array.isArray(result[STORAGE_KEYS.DOCUMENTS]) ? result[STORAGE_KEYS.DOCUMENTS] : [],
      meta: toIndexMeta(result ? result[STORAGE_KEYS.INDEX_META] : null)
    };
  } catch (error) {
    logError('knowledge store read error:', error.message);
    return { documents: [], meta: toIndexMeta(null) };
  }
}

/**
 * Write the document list, marking the index STALE.
 *
 * Always called inside `serialize()`, so the read-modify-write and this write cannot
 * interleave with another mutation.
 *
 * @param {Array<Object>} documents
 * @throws {Error} when storage rejects the write — the user must be told
 */
async function writeDocuments(documents) {
  const previous = await readStore();

  // Invalidation is decided by the FINGERPRINT, not by the fact that a write happened.
  //
  // The obvious implementation — mark STALE on every write — is wrong for the most ordinary
  // action a user can take: opening the editor and saving without changing anything. It
  // would invalidate a perfectly good index, and §33 asks for exactly the opposite ("avoid
  // unnecessary repeated work"), because rebuilding means re-parsing the whole base.
  //
  // The fingerprint covers content, version, enabled and priority, and deliberately not
  // `updatedAt`. So a save that changes nothing about what a retrieval would return keeps the
  // same fingerprint and the index stays FRESH, while any real edit — including flipping
  // `enabled`, which changes what may be retrieved from — invalidates it. That is §38 Test 10,
  // enforced by the same comparison the reader uses.
  //
  // Only FRESH is ever preserved. A FAILED or BUILDING record stays what it is: this module
  // cannot know the build finished, so it must not upgrade a state it did not produce.
  const enabled = documents.filter(isDocumentEnabled);
  const fingerprint = computeFingerprint(enabled);
  const unchanged =
    previous.meta.state === INDEX_STATE.FRESH && previous.meta.fingerprint === fingerprint;

  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.DOCUMENTS]: documents,
      // The fingerprint of the last build is kept so the UI can still say what the index was
      // built from even after it went stale.
      [STORAGE_KEYS.INDEX_META]: {
        ...previous.meta,
        fingerprint: previous.meta.fingerprint,
        state: unchanged ? INDEX_STATE.FRESH : INDEX_STATE.STALE
      }
    });
  } catch (error) {
    logError('knowledge store write error:', error.message);
    YTAR_DEVLOG.error(C.KNOWLEDGE, 'KNOWLEDGE_WRITE_FAILED', {
      message: 'could not write the knowledge base',
      error,
      data: { reason: STORE_REJECTION.WRITE_FAILED, documentCount: documents.length }
    });
    reject(STORE_REJECTION.WRITE_FAILED, error.message);
  }
}

/**
 * Normalize stored entries and drop the ones that cannot be used.
 *
 * A document that fails normalization is NOT deleted from storage — a hand-edited store or
 * a future schema change should not destroy a user's file because one field went missing.
 * It is simply not returned, so it cannot be retrieved from, cited as evidence or win a
 * conflict. The drop is counted in the log, because a knowledge base that is quietly smaller
 * than the user thinks is exactly the kind of thing that gets diagnosed from a count.
 *
 * @param {*} raw
 * @returns {Array<Object>}
 */
function normalizeStored(raw) {
  if (!Array.isArray(raw)) return [];

  const usable = [];
  let dropped = 0;
  for (const entry of raw) {
    // Per entry, and in a try: one entry that cannot even be READ — a corrupted value, or a
    // shape that throws when its fields are touched — must not take out the whole read. The
    // Options page would otherwise fail to open, and retrieval would see no base at all,
    // over one bad file among fifty.
    let doc = null;
    try {
      doc = toKnowledgeDocument(entry);
    } catch (_) {
      doc = null;
    }
    if (doc) usable.push(doc);
    else dropped++;
  }

  if (dropped > 0) {
    devWarn(C.KNOWLEDGE, 'KNOWLEDGE_DOCUMENTS_DROPPED', {
      message: `${dropped} stored knowledge document(s) were unusable and are not searchable`,
      data: { dropped, kept: usable.length }
    });
  }
  return usable;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Every usable knowledge document, normalized.
 *
 * The single read path for retrieval, the indexer and the UI, so all three see the same
 * list and therefore the same fingerprint.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getKnowledgeDocuments() {
  const { documents } = await readStore();
  return normalizeStored(documents);
}

/**
 * One document by id.
 *
 * @param {string} documentId
 * @returns {Promise<Object|null>}
 */
export async function getKnowledgeDocument(documentId) {
  if (typeof documentId !== 'string' || !documentId) return null;
  const documents = await getKnowledgeDocuments();
  return documents.find((doc) => doc.id === documentId) || null;
}

/**
 * One document by its normalized filename.
 *
 * Case-insensitive, matching isSameDocumentFilename(): `Chemistry.md` and `chemistry.md`
 * name the same file to the user, and returning two documents for one query is how a
 * conflict gets created by accident.
 *
 * @param {string} filename
 * @returns {Promise<Object|null>}
 */
export async function getKnowledgeDocumentByFilename(filename) {
  const normalized = normalizeFilename(filename);
  if (!normalized) return null;
  const documents = await getKnowledgeDocuments();
  return documents.find((doc) => isSameDocumentFilename(doc, { filename: normalized })) || null;
}

/**
 * Add a document.
 *
 * The filename must be unique across the base, case-insensitively: two files claiming the
 * same name are a knowledge conflict the user has not resolved yet, and refusing it here is
 * cheaper than reporting CONFLICTING_KNOWLEDGE on every price question afterwards.
 *
 * @param {{filename: string, content: string, enabled?: boolean, priority?: number}} input
 * @returns {Promise<Object>} the stored document
 * @throws {Error} with `.reason` set to one of STORE_REJECTION
 */
export function addKnowledgeDocument(input) {
  return serialize(async () => {
    const created = toKnowledgeDocument(input);
    if (!created) rejectUnusableDocument(input);

    const { documents: raw } = await readStore();
    const existing = normalizeStored(raw);

    if (existing.length >= MAX_KNOWLEDGE_DOCUMENTS) {
      reject(STORE_REJECTION.TOO_MANY_DOCUMENTS);
    }
    if (existing.some((doc) => isSameDocumentFilename(doc, created))) {
      reject(STORE_REJECTION.DUPLICATE_FILENAME, created.filename);
    }
    if (totalChars(existing) + created.content.length > MAX_TOTAL_KNOWLEDGE_CHARS) {
      reject(STORE_REJECTION.STORE_TOO_LARGE);
    }

    await writeDocuments([...existing, created]);

    YTAR_DEVLOG.log({
      component: C.KNOWLEDGE,
      event: 'KNOWLEDGE_DOCUMENT_ADDED',
      data: {
        documentId: created.id,
        filename: created.filename,
        category: created.category,
        chars: created.content.length,
        documentCount: existing.length + 1,
        enabled: created.enabled
      }
    });

    return created;
  });
}

/**
 * Replace or update a document.
 *
 * Two kinds of change, deliberately treated differently:
 *
 *   - CONTENT (content, filename): bumps `version`, recomputes `hash` and moves `updatedAt`.
 *     This is the change that makes the old index wrong, and §18's precedence uses version
 *     and updatedAt to decide which document supersedes which.
 *   - METADATA (enabled, priority): leaves version, hash and updatedAt ALONE.
 *
 * The asymmetry is load-bearing. `updatedAt` means "this document's text was last edited",
 * which is what conflict resolution is about. If switching a document off and on again
 * touched it, re-enabling an old price list would make it the most recently edited document
 * and it would start winning conflicts against a genuinely newer one — a bug the user would
 * see as "it answered with the old price again".
 *
 * Fields the caller omits are preserved, including an explicit `content: ''`… which is
 * refused, because an empty knowledge document answers nothing and is far more likely to be
 * a paste that failed than an intent.
 *
 * @param {string} documentId
 * @param {{content?: string, filename?: string, enabled?: boolean, priority?: number}} updates
 * @returns {Promise<Object>} the stored document
 * @throws {Error} with `.reason` set to one of STORE_REJECTION
 */
export function updateKnowledgeDocument(documentId, updates) {
  return serialize(async () => {
    if (typeof documentId !== 'string' || !documentId) reject(STORE_REJECTION.NOT_FOUND);

    const { documents: raw } = await readStore();
    const existing = normalizeStored(raw);
    const index = existing.findIndex((doc) => doc.id === documentId);
    if (index < 0) reject(STORE_REJECTION.NOT_FOUND, documentId);

    const original = existing[index];
    const incoming = updates && typeof updates === 'object' ? updates : {};

    // Validate the merged result through the same normalizer `add` uses, so an update can
    // never write a shape that add would have refused.
    const mergedInput = {
      ...original,
      filename: incoming.filename !== undefined ? incoming.filename : original.filename,
      content: incoming.content !== undefined ? incoming.content : original.content,
      enabled: incoming.enabled !== undefined ? incoming.enabled : original.enabled,
      priority: incoming.priority !== undefined ? incoming.priority : original.priority
    };
    const merged = toKnowledgeDocument(mergedInput);
    if (!merged) rejectUnusableDocument(mergedInput);

    // A rename must not collide with another document either — same rule as add.
    if (existing.some((doc) => doc.id !== documentId && isSameDocumentFilename(doc, merged))) {
      reject(STORE_REJECTION.DUPLICATE_FILENAME, merged.filename);
    }
    if (totalChars(existing) - original.content.length + merged.content.length > MAX_TOTAL_KNOWLEDGE_CHARS) {
      reject(STORE_REJECTION.STORE_TOO_LARGE);
    }

    const contentChanged =
      incoming.content !== undefined && hashContent(incoming.content) !== original.hash;
    const filenameChanged =
      incoming.filename !== undefined && merged.filename !== original.filename;

    const updated = {
      ...merged,
      // Version tracks CONTENT revisions only. `updatedAt` moves for a rename too, because
      // the path a fact was retrieved from is part of the evidence the reply cites.
      version: contentChanged ? original.version + 1 : original.version,
      updatedAt: contentChanged || filenameChanged ? Date.now() : original.updatedAt
    };

    const next = [...existing];
    next[index] = updated;
    await writeDocuments(next);

    YTAR_DEVLOG.log({
      component: C.KNOWLEDGE,
      event: 'KNOWLEDGE_DOCUMENT_UPDATED',
      data: {
        documentId: updated.id,
        filename: updated.filename,
        contentChanged,
        filenameChanged,
        version: updated.version,
        enabled: updated.enabled,
        priority: updated.priority,
        // The old and new hashes are what make "the price changed from 350 to 370" visible
        // in the log without echoing either document's text.
        previousHash: contentChanged ? original.hash : null,
        hash: contentChanged ? updated.hash : null
      }
    });

    return updated;
  });
}

/**
 * Remove a document.
 *
 * The document is gone, not disabled: a knowledge file the user deleted must not come back
 * as a stale index hit, and the index is invalidated by the same write anyway.
 *
 * @param {string} documentId
 * @returns {Promise<void>}
 * @throws {Error} with `.reason` set to one of STORE_REJECTION
 */
export function removeKnowledgeDocument(documentId) {
  return serialize(async () => {
    if (typeof documentId !== 'string' || !documentId) reject(STORE_REJECTION.NOT_FOUND);

    const { documents: raw } = await readStore();
    const existing = normalizeStored(raw);
    const target = existing.find((doc) => doc.id === documentId);
    if (!target) reject(STORE_REJECTION.NOT_FOUND, documentId);

    await writeDocuments(existing.filter((doc) => doc.id !== documentId));

    YTAR_DEVLOG.log({
      component: C.KNOWLEDGE,
      event: 'KNOWLEDGE_DOCUMENT_REMOVED',
      data: { documentId, filename: target.filename, documentCount: existing.length - 1 }
    });
  });
}

/**
 * The stored index metadata, for the UI's indexing status.
 *
 * Reads only what storage holds — it does NOT compute the live state. `resolveIndexState()`
 * from knowledge-schema.js is what decides whether the index is usable, and it needs the
 * documents, so it is deliberately not smuggled in here behind an extra storage read.
 *
 * @returns {Promise<Object>}
 */

/**
 * Phase 21.1 — apply a folder-sync plan.
 *
 * This is the ONLY path by which a folder reaches the base, which is the point: a second
 * writer would mean a second invalidation rule, and §33's "update the document and the old
 * cached knowledge must not be used" would fail with nothing to detect it. The folder is just
 * another SOURCE of content feeding the store that already owns the keys.
 *
 * WHY ONE TRANSACTION RATHER THAN N CALLS TO add/update/remove
 *
 * The obvious implementation is to loop the plan through the existing mutators. That is
 * correct and it is also wrong for this feature, for three reasons that only apply at folder
 * scale:
 *
 *  1. Each mutator reads the whole document list. A fifty-file sync becomes fifty full
 *     storage reads and fifty writes.
 *  2. They are each `serialize()`d, so the REMOVEs and the UPDATEs interleave with a user
 *     clicking Save in the Options page — and a user watching their base rebuild file by
 *     file will click.
 *  3. Most seriously, a failure halfway through leaves the base HALF-SYNCED: some files
 *     updated, some not, with the folder as the source of truth. The next sync would repair
 *     it, but until then the base is a mix of two versions of the user's own content, and
 *     every answer drawn from it is wrong in a way nothing reports.
 *
 * So the plan is applied to one in-memory list and written once. Atomic with respect to
 * storage, and a quota or serialization failure leaves the previous base entirely intact.
 *
 * `version` and `updatedAt` move on CONTENT edits only — see the header. An unchanged file is
 * never rewritten, so a sync that finds nothing new does not bump a version, does not move
 * `updatedAt`, and (because the fingerprint does not include `updatedAt`) does not invalidate
 * the index either.
 *
 * @param {{add: Array, update: Array, remove: Array}} plan - from `planFolderSync()`
 * @returns {Promise<{applied: boolean, documentCount: number, skipped: number}>}
 * @throws {Error} on a storage failure — the user must be told, not left with a half base
 */
export function applyFolderSync(plan) {
  return serialize(async () => {
    const p = plan && typeof plan === 'object' ? plan : {};
    const toAdd = Array.isArray(p.add) ? p.add : [];
    const toUpdate = Array.isArray(p.update) ? p.update : [];
    const toRemove = Array.isArray(p.remove) ? p.remove : [];

    const { documents: raw } = await readStore();
    let next = normalizeStored(raw);
    let skipped = 0;

    // REMOVE first, then update, then add — so the count and total-size limits below are
    // checked against what the base will actually hold. A mirrored delete freeing space for a
    // new file is the common case: the user replaced a chapter.
    if (toRemove.length) {
      const gone = new Set(toRemove.map((doc) => doc && doc.id).filter(Boolean));
      next = next.filter((doc) => !gone.has(doc.id));
    }

    for (const change of toUpdate) {
      const index = next.findIndex((doc) => doc && doc.id === change.id);
      if (index === -1) {
        // The document was removed by someone else between planning and applying. Adding it
        // back would resurrect a deletion the user just made, so it is counted and dropped.
        skipped++;
        continue;
      }

      const merged = toKnowledgeDocument({
        ...next[index],
        filename: change.filename,
        content: change.content,
        // Carried from the plan, which carried them from the stored document: the user's
        // overrides survive a sync.
        enabled: change.enabled,
        priority: change.priority
      });
      if (!merged) {
        skipped++;
        continue;
      }
      next[index] = merged;
    }

    for (const addition of toAdd) {
      const created = toKnowledgeDocument(addition);
      if (!created) {
        skipped++;
        continue;
      }
      if (next.length >= MAX_KNOWLEDGE_DOCUMENTS) {
        skipped++;
        continue;
      }
      if (next.some((doc) => isSameDocumentFilename(doc, created))) {
        skipped++;
        continue;
      }
      next = [...next, created];
    }

    // A plan that changes nothing must not write. The write would recompute the same
    // fingerprint and leave the index FRESH, so it would be harmless — but it would also fire
    // the change listener that 20.19's audit and 20.20's rebuild are driven by, turning a
    // no-op sync into visible work for nothing.
    if (!toAdd.length && !toUpdate.length && !toRemove.length) {
      return { applied: false, documentCount: next.length, skipped };
    }

    const total = totalChars(next);
    if (total > MAX_TOTAL_KNOWLEDGE_CHARS) {
      // Refuse the WHOLE plan rather than applying what fits. A partial sync is the exact
      // state this function exists to prevent, and stopping with a clear message is
      // recoverable in a way a silently-mixed base is not.
      reject(STORE_REJECTION.STORE_TOO_LARGE);
    }

    await writeDocuments(next);

    YTAR_DEVLOG.log({
      component: C.KNOWLEDGE,
      event: 'KNOWLEDGE_FOLDER_SYNCED',
      data: {
        added: toAdd.length,
        updated: toUpdate.length,
        removed: toRemove.length,
        skipped,
        documentCount: next.length,
        chars: total
      }
    });

    return { applied: true, documentCount: next.length, skipped };
  });
}

/**
 * Phase 20.20 — what happened to a document in a storage write.
 *
 * Named here rather than in the caller because the caller cannot see the before/after
 * lists, and `verify-extension.mjs` deliberately forbids any module outside the store and
 * the schema from naming the knowledge keys at all. That is not pedantry: a second place
 * that resolves the key is a second place that can disagree about what a document list is.
 */
export const KNOWLEDGE_CHANGE = Object.freeze({
  ADDED: 'added',
  UPDATED: 'updated',
  REMOVED: 'removed'
});

/**
 * Diff two document lists into per-document changes.
 *
 * Split out from `watchKnowledgeDocuments()` so the shape can be tested without a
 * `chrome.storage.onChanged` event, which is otherwise untestable outside a real worker.
 *
 * @param {Array<Object>} before
 * @param {Array<Object>} after
 * @returns {Array<{id: string, filename: string, operation: string}>}
 */
export function diffKnowledgeDocuments(before, after) {
  const beforeList = Array.isArray(before) ? before : [];
  const afterList = Array.isArray(after) ? after : [];

  const beforeIds = new Set(beforeList.map((doc) => String((doc && doc.id) || '')).filter(Boolean));
  const afterIds = new Set(afterList.map((doc) => String((doc && doc.id) || '')).filter(Boolean));

  const changes = [];
  for (const doc of afterList) {
    if (!doc) continue;
    const id = String(doc.id || '');
    if (!id) continue;
    changes.push({
      id,
      filename: String(doc.filename || ''),
      operation: beforeIds.has(id) ? KNOWLEDGE_CHANGE.UPDATED : KNOWLEDGE_CHANGE.ADDED
    });
  }
  for (const doc of beforeList) {
    const id = String((doc && doc.id) || '');
    if (!id || afterIds.has(id)) continue;
    // The filename is carried from the OLD list, which is the only place it exists for a
    // removal: an entry naming nothing is not a useful thing to log.
    changes.push({ id, filename: String((doc && doc.filename) || ''), operation: KNOWLEDGE_CHANGE.REMOVED });
  }
  return changes;
}

/**
 * Phase 20.20 — subscribe to knowledge-document changes.
 *
 * The worker is NOT allowed to name the knowledge storage keys (see
 * `verify-extension.mjs`), so this seam is how change detection is wired at all: the store
 * owns both the key and the meaning of a document list, and hands the caller a diff.
 *
 * Returns an unsubscribe function. It is best-effort by nature — an MV3 worker is torn
 * down when idle, so this simply stops firing while the worker sleeps, and correctness
 * does not depend on it: `getKnowledgeIndex()` recomputes the fingerprint from storage on
 * every read, so the next comment after an edit rebuilds the index anyway. This is a
 * NOTICE, not a correctness mechanism.
 *
 * `knowledgeIndexMeta` is deliberately NOT watched. The indexer writes that key itself on
 * every build, so a listener on it would fire inside its own rebuild.
 *
 * @param {(payload: {changes: Array<Object>, documents: Array<Object>}) => void} handler
 * @returns {() => void} unsubscribe
 */
export function watchKnowledgeDocuments(handler) {
  if (typeof handler !== 'function') return () => {};
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
    return () => {};
  }

  const listener = (changes, areaName) => {
    try {
      if (areaName !== 'local' || !changes) return;
      const change = changes[STORAGE_KEYS.DOCUMENTS];
      if (!change) return;
      const after = Array.isArray(change.newValue) ? change.newValue : [];
      handler({ changes: diffKnowledgeDocuments(change.oldValue, after), documents: after });
    } catch (_) {
      // A notification must never be able to break the worker, and the fingerprint path
      // still guarantees the next comment sees the new knowledge.
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch (_) {
      // Nothing to do: the worker is going away regardless.
    }
  };
}

export async function getKnowledgeIndexMeta() {
  const { meta } = await readStore();
  return meta;
}

/**
 * Record the outcome of an index build.
 *
 * Used by the indexer (20.4) and by the manual reload (20.20). Exposed here because this
 * module owns the two keys, and a second module writing `knowledgeIndexMeta` directly would
 * be two writers for one record.
 *
 * @param {Object} meta
 * @returns {Promise<Object>} the stored metadata
 * @throws {Error} with `.reason` set to STORE_REJECTION.WRITE_FAILED
 */
export function saveKnowledgeIndexMeta(meta) {
  return serialize(async () => {
    const normalized = toIndexMeta(meta);
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.INDEX_META]: { ...normalized, fingerprint: normalized.fingerprint || computeFingerprint([]) }
      });
    } catch (error) {
      logError('knowledge index metadata write error:', error.message);
      reject(STORE_REJECTION.WRITE_FAILED, error.message);
    }
    return normalized;
  });
}

/**
 * A summary for the Options page: how many documents, how many active, how big.
 *
 * @returns {Promise<{total: number, enabled: number, disabled: number, chars: number,
 *   fingerprint: string, maxDocuments: number, maxChars: number}>}
 */
export async function getKnowledgeStats() {
  const documents = await getKnowledgeDocuments();
  const enabled = documents.filter(isDocumentEnabled);
  return {
    total: documents.length,
    enabled: enabled.length,
    disabled: documents.length - enabled.length,
    chars: totalChars(documents),
    // Exposed so the caller can tell a stale index from a fresh one without a second read.
    fingerprint: computeFingerprint(enabled),
    maxDocuments: MAX_KNOWLEDGE_DOCUMENTS,
    maxChars: MAX_TOTAL_KNOWLEDGE_CHARS
  };
}
