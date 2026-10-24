/**
 * Knowledge Index — Phase 20.4
 *
 * Turns the stored Markdown documents into the searchable section records that retrieval
 * (20.5) reads. It is the joining point of the three layers built so far: `knowledge-store.js`
 * supplies the documents, `markdown-parser.js` supplies the sections, and this module holds
 * the result together with the freshness rule.
 *
 * THE ONE INVARIANT THAT SHAPES EVERYTHING HERE
 * ---------------------------------------------
 * **The index lives in memory and nowhere else.** `knowledgeDocuments` is the only source of
 * truth, and `knowledgeIndexMeta` is five scalars describing a build — never a copy of it.
 *
 * That is not a storage optimisation, it is what makes acceptance Test 10 ("update the
 * document, the new retrieval must use 370 and the old cached knowledge must not be used")
 * structurally impossible to fail. There is no stored section that could go stale, because
 * there is no stored section. The alternative — persisting derived sections — would create a
 * second source of truth, and §34's warning about stale caches overriding newer knowledge is
 * exactly what that would set up.
 *
 * THE REBUILD DECISION IS NOT A CACHING OPTIMISATION
 * --------------------------------------------------
 * `getKnowledgeIndex()` rebuilds whenever `resolveIndexState()` does not report FRESH, and
 * FRESH after a service-worker restart means "an index was built from these documents", NOT
 * "an index exists in memory". An MV3 worker is torn down after ~30 seconds idle, so the
 * honest reading is that there is no index and one must be built.
 *
 * That sounds wasteful and is not: parsing is local, deterministic and fast, it happens at
 * most once per worker lifetime rather than once per comment, and §33 explicitly asks for
 * this — deterministic local processing handles indexing and hashing, and unnecessary
 * REPEATED work is what's to be avoided, not necessary work.
 *
 * THE IN-MEMORY CACHE IS KEYED BY FINGERPRINT
 * --------------------------------------------
 * On top of the gate there is a plain memo keyed on the documents' fingerprint, so a comment
 * arriving after the first one in a run reuses the index rather than re-parsing the base
 * 47 times. The cache is only ever consulted when `resolveIndexState()` has already said
 * FRESH, so it can never authorize a stale retrieval on its own.
 *
 * ONE BAD DOCUMENT FAILS THE WHOLE BUILD
 * ---------------------------------------
 * If any document cannot be indexed, the build fails and the index is not served.
 *
 * This is deliberately strict, and the reasoning is the phase's own: a partial base is not
 * an unsafe answer, it is a SILENTLY incomplete one. Four of five price files indexed means
 * every question about the fifth returns NO_SUPPORTED_ANSWER, which the user reads as "the
 * extension does not know" rather than "one file is broken" — and §2's rule is that skipping
 * is preferred to inventing, not that degrading quietly is preferred to telling the truth.
 * The failing filenames go in the error so the UI can name them.
 */

import { YTAR_DEVLOG, startTimer, DEV_LOG_COMPONENT as C, newRequestId } from './debug.js';
import { normalizeArabic } from './matchers/arabic-normalizer.js';
import {
  INDEX_STATE,
  KNOWLEDGE_ERROR,
  isDocumentEnabled,
  computeFingerprint,
  resolveIndexState,
  isRetrievableState
} from './knowledge-schema.js';
import { getKnowledgeDocuments, getKnowledgeIndexMeta, saveKnowledgeIndexMeta } from './knowledge-store.js';
import { parseDocumentSections } from './markdown-parser.js';

/**
 * Most sections a single index may hold.
 *
 * A guard against a pathological document producing a section per line, and against the
 * retrieval prompt growing without bound. Exceeding it FAILS the build with a named error
 * rather than truncating: silently dropping sections is the same "silently incomplete
 * answer" failure the whole module refuses to commit elsewhere.
 */
export const MAX_INDEXED_SECTIONS = 5000;

/**
 * The in-memory index. `fingerprint` is the memo key AND the correctness check.
 *
 * Reset to this shape by `clearKnowledgeIndexCache()`, which is what a service-worker
 * restart does implicitly and what the tests do between cases.
 */
let cache = { fingerprint: '', sections: [], documentCount: 0, builtAt: 0, built: false };

/** Last build's outcome, for the UI to show why there is no index. */
let lastFailure = { code: '', message: '', documents: [] };

/**
 * The text a local search compares against.
 *
 * Built once at index time rather than per query: normalization is pure but not free, and a
 * retrieval may score every section in the base. The heading path is prepended so that a
 * comment naming the SUBJECT ("منتجات كيمياء تالتة ثانوي") matches a section whose body
 * only ever says the price — the product name lives in the heading, not in the sentence.
 *
 * The section's own `content` is left untouched; this is a derived search field, never
 * something that can be cited.
 */
function toSearchText(section) {
  const headings = Array.isArray(section.headingPath) ? section.headingPath.join(' ') : '';
  return normalizeArabic(`${headings} ${section.content}`);
}

/**
 * Parse one document's sections, or report why it could not be done.
 *
 * Wrapped per document rather than around the whole build so the error can name the file
 * that failed. The parser is written not to throw, so the interesting failure is not an
 * exception: it is a document that HAS text and yields NO sections, which means the file is
 * not Markdown the parser can read and is contributing nothing while looking fine.
 *
 * A document with no text at all is NOT a failure. An empty file, or one made only of
 * bodyless headings, contributes no facts — the same as not being there — and refusing to
 * build over it would make an empty knowledge base look like a broken one.
 *
 * @param {Object} document
 * @returns {{sections: Array<Object>}|{error: string}}
 */
function indexDocument(document) {
  const hasContent = typeof document?.content === 'string' && document.content.trim() !== '';

  try {
    const sections = parseDocumentSections(document);
    if (!Array.isArray(sections)) {
      return { error: 'the parser did not return a section list' };
    }
    if (hasContent && sections.length === 0) {
      return { error: 'the document has text but produced no sections' };
    }

    return {
      sections: sections.map((section) => ({
        ...section,
        charCount: section.content.length,
        searchText: toSearchText(section)
      }))
    };
  } catch (error) {
    return { error: (error && error.message) || 'unknown parsing error' };
  }
}

/**
 * Parse every enabled document into one flat section list.
 *
 * Pure with respect to storage: it takes documents and returns sections, so the build can be
 * reasoned about (and tested) without a store.
 *
 * @param {Array<Object>} documents
 * @returns {{sections: Array<Object>, failed: Array<{filename: string, error: string}>}}
 */
export function buildSections(documents) {
  const enabled = Array.isArray(documents) ? documents.filter(isDocumentEnabled) : [];
  const sections = [];
  const failed = [];

  for (const document of enabled) {
    const result = indexDocument(document);
    if (result.error) {
      failed.push({ filename: document.filename || '(unnamed)', error: result.error });
      continue;
    }
    sections.push(...result.sections);
  }

  return { sections, failed };
}

/**
 * Build the index from a document set, without touching storage.
 *
 * Split out from `getKnowledgeIndex()` so the failure rules can be read — and tested —
 * without a mock store, and so the storage path stays a thin wrapper over a decision that
 * lives in one place.
 *
 * @param {Array<Object>} documents
 * @returns {{ok: boolean, sections: Array<Object>, documentCount: number,
 *   fingerprint: string, code: string, message: string, failed: Array<Object>}}
 */
export function computeIndex(documents) {
  const enabled = Array.isArray(documents) ? documents.filter(isDocumentEnabled) : [];
  const fingerprint = computeFingerprint(enabled);

  if (enabled.length === 0) {
    // Not a failure. §13 and §24 both make "nothing to answer from" a normal, deliberate
    // outcome, and an empty knowledge base must not look like a broken one.
    return {
      ok: true, sections: [], documentCount: 0, fingerprint,
      code: '', message: '', failed: []
    };
  }

  const { sections, failed } = buildSections(enabled);

  if (failed.length > 0) {
    // The strict rule from the file header: one unindexable file fails the build rather than
    // quietly shrinking what the extension knows.
    const names = failed.map((f) => f.filename).join(', ');
    return {
      ok: false, sections: [], documentCount: enabled.length, fingerprint,
      code: KNOWLEDGE_ERROR.INVALID_KNOWLEDGE_DOCUMENT,
      message: `could not index: ${names}`,
      failed
    };
  }

  if (sections.length > MAX_INDEXED_SECTIONS) {
    return {
      ok: false, sections: [], documentCount: enabled.length, fingerprint,
      code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED,
      message: `the knowledge base produced ${sections.length} sections, over the ${MAX_INDEXED_SECTIONS} limit`,
      failed: []
    };
  }

  return {
    ok: true, sections, documentCount: enabled.length, fingerprint,
    code: '', message: '', failed: []
  };
}

/**
 * A snapshot describing the index, safe to send to the Options page and the Side Panel.
 *
 * Returns no section CONTENT: the panel has no need for the user's price lists, and the
 * index is the most sensitive object in the extension.
 *
 * @param {{sections?: Array<Object>, documentCount?: number, fingerprint?: string, builtAt?: number}} index
 * @returns {Object}
 */
export function toIndexSnapshot(index) {
  return {
    documentCount: index?.documentCount || 0,
    sectionCount: Array.isArray(index?.sections) ? index.sections.length : 0,
    fingerprint: index?.fingerprint || '',
    builtAt: index?.builtAt || 0
  };
}

/**
 * Build the single failure return value.
 *
 * Retrieval must never THROW. A knowledge problem is a reason not to answer a comment, and
 * an exception escaping into the reply pipeline would be reported as a generic failure —
 * losing the code and the reason that make the skip explainable.
 */
function buildFailure({ code, message, documentCount, builtAt }) {
  return {
    retrievable: false,
    state: INDEX_STATE.FAILED,
    sections: [],
    documentCount: documentCount || 0,
    sectionCount: 0,
    fingerprint: '',
    builtAt: builtAt || 0,
    code,
    message
  };
}

/**
 * The index, building it first if necessary.
 *
 * THE GATE. Retrieval calls this and reads `sections` only when `retrievable` is true, and
 * `retrievable` is `isRetrievableState(state)` — the same single rule §20.1 declared, with
 * no second path to an index anywhere in the phase.
 *
 * The order matters and is the whole safety property:
 *
 *   1. read the documents and the stored metadata
 *   2. ask `resolveIndexState()` — the ONLY thing that authorizes retrieval
 *   3. if not FRESH, or if the in-memory cache does not match this fingerprint, rebuild
 *   4. re-ask, and report what the state actually is
 *
 * A caller therefore cannot receive a stale index by forgetting to check, cannot receive a
 * partial one, and cannot receive an exception.
 *
 * @param {{forceRebuild?: boolean}} [options] `forceRebuild` is the manual reload (§20.20)
 * @returns {Promise<{retrievable: boolean, state: string, sections: Array<Object>,
 *   documentCount: number, sectionCount: number, fingerprint: string, builtAt: number,
 *   code: string, message: string}>}
 */
export async function getKnowledgeIndex(options = {}) {
  const forceRebuild = options.forceRebuild === true;

  const documents = await getKnowledgeDocuments();
  const meta = await getKnowledgeIndexMeta();
  const state = resolveIndexState(meta, documents);
  const enabled = documents.filter(isDocumentEnabled);
  const fingerprint = computeFingerprint(enabled);

  // Fast path: the gate said FRESH and this worker's memory already holds an index built
  // from exactly these documents. Both halves are required — FRESH alone is true after a
  // worker restart, when the cache is empty.
  if (
    !forceRebuild &&
    isRetrievableState(state) &&
    cache.built &&
    cache.fingerprint === fingerprint
  ) {
    return {
      retrievable: true,
      state,
      sections: cache.sections,
      code: '',
      message: '',
      ...toIndexSnapshot(cache)
    };
  }

  // BUILDING is recorded so the Options page can say "re-indexing" rather than showing a
  // stale status while the work happens. It is also self-healing: a worker killed mid-build
  // leaves BUILDING behind, and resolveIndexState() downgrades that to STALE, so the next
  // worker rebuilds instead of waiting forever on a status nobody will finish writing.
  //
  // Failing to record the attempt fails the whole call. The index in memory would be
  // correct, but the stored metadata is what authorizes retrieval, so serving it would mean
  // trusting one layer while another says no.
  try {
    await saveKnowledgeIndexMeta({ ...meta, state: INDEX_STATE.BUILDING });
  } catch (error) {
    clearKnowledgeIndexCache();
    const message = `could not record the index build: ${(error && error.message) || 'storage write failed'}`;
    lastFailure = { code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, message, documents: [] };
    YTAR_DEVLOG.error(C.KNOWLEDGE, 'KNOWLEDGE_INDEX_FAILED', {
      message,
      error,
      data: { stage: 'mark_building', willRetrieve: false }
    });
    return buildFailure({
      code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED,
      message,
      documentCount: enabled.length,
      builtAt: Date.now()
    });
  }

  const timer = startTimer({
    component: C.KNOWLEDGE,
    event: 'KNOWLEDGE_INDEX',
    endEvent: 'KNOWLEDGE_INDEX_BUILT',
    errorEvent: 'KNOWLEDGE_INDEX_FAILED',
    requestId: newRequestId(),
    data: {
      documentCount: enabled.length,
      previousFingerprint: meta.fingerprint || null,
      currentFingerprint: fingerprint || null,
      reason: forceRebuild ? 'manual reload' : state
    }
  });

  const result = computeIndex(documents);
  const builtAt = Date.now();

  if (!result.ok) {
    // The cache is CLEARED on failure, not left in place. A stale index left behind after a
    // failed rebuild would be served by a later FRESH resolution whose fingerprint happened
    // to match — which is exactly the stale-knowledge bug this module exists to prevent.
    clearKnowledgeIndexCache();
    lastFailure = { code: result.code, message: result.message, documents: result.failed };

    // Best effort: the failure reason is kept so the UI can explain it, but a failure to
    // WRITE that reason must not turn into a second, less useful error. The state is left
    // as BUILDING, which resolveIndexState() downgrades to STALE — so the next call
    // rebuilds either way, which is the behaviour that matters.
    try {
      await saveKnowledgeIndexMeta({
        fingerprint: meta.fingerprint,
        state: INDEX_STATE.FAILED,
        documentCount: enabled.length,
        builtAt,
        error: result.message
      });
    } catch (_) {
      // Deliberately ignored; see above.
    }

    YTAR_DEVLOG.error(C.KNOWLEDGE, 'KNOWLEDGE_INDEX_FAILED', {
      message: result.message,
      data: {
        code: result.code,
        documentCount: enabled.length,
        failedDocuments: result.failed,
        willRetrieve: false
      }
    });
    timer.fail(null, { code: result.code, ok: false, willRetrieve: false });

    return buildFailure({
      code: result.code,
      message: result.message,
      documentCount: enabled.length,
      builtAt
    });
  }

  // Written LAST, and only on success. The fingerprint is what makes a later resolution say
  // FRESH, so recording it before the sections exist would authorize an index that was never
  // built — the exact stale-knowledge hole, in the one place it would be invisible.
  try {
    await saveKnowledgeIndexMeta({
      fingerprint: result.fingerprint,
      state: INDEX_STATE.FRESH,
      documentCount: result.documentCount,
      sectionCount: result.sections.length,
      builtAt,
      error: ''
    });
  } catch (error) {
    clearKnowledgeIndexCache();
    const message = `could not record the finished index: ${(error && error.message) || 'storage write failed'}`;
    lastFailure = { code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, message, documents: [] };
    YTAR_DEVLOG.error(C.KNOWLEDGE, 'KNOWLEDGE_INDEX_FAILED', {
      message,
      error,
      data: { stage: 'mark_fresh', willRetrieve: false }
    });
    timer.fail(null, { code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED, ok: false, willRetrieve: false });
    return buildFailure({
      code: KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED,
      message,
      documentCount: enabled.length,
      builtAt
    });
  }

  cache = {
    fingerprint: result.fingerprint,
    sections: result.sections,
    documentCount: result.documentCount,
    builtAt,
    built: true
  };
  lastFailure = { code: '', message: '', documents: [] };

  timer.done({
    ok: true,
    documentCount: result.documentCount,
    sectionCount: result.sections.length,
    // How much of the base was actually retrievable. A document whose headings are all
    // bodyless is legal and contributes nothing, and a high ratio here is the first hint
    // that a knowledge file is shaped wrong.
    usableSectionCount: result.sections.filter((s) => s.empty !== true).length
  });

  return {
    retrievable: true,
    state: INDEX_STATE.FRESH,
    sections: result.sections,
    code: '',
    message: '',
    ...toIndexSnapshot(cache)
  };
}

/**
 * The index's status without building it.
 *
 * For the Options page, which must be able to show "stale — click re-index" without paying
 * for a build just to answer the question. Retrieval uses `getKnowledgeIndex()` instead.
 *
 * @returns {Promise<{state: string, retrievable: boolean, fingerprint: string,
 *   documentCount: number, sectionCount: number, builtAt: number, error: string,
 *   code: string, cached: boolean}>}
 */
export async function getKnowledgeIndexStatus() {
  const documents = await getKnowledgeDocuments();
  const meta = await getKnowledgeIndexMeta();
  const state = resolveIndexState(meta, documents);
  const fingerprint = computeFingerprint(documents.filter(isDocumentEnabled));

  return {
    state,
    // Deliberately NOT `state === FRESH`. The stored metadata can say FRESH while this
    // worker holds no index at all, and telling the user "ready" when the first comment will
    // trigger a rebuild is a small lie that costs a visible pause.
    retrievable: isRetrievableState(state) && cache.built && cache.fingerprint === fingerprint,
    fingerprint: meta.fingerprint || '',
    // What is INDEXED, from the stored metadata. Zero before anything has ever been built.
    documentCount: meta.documentCount || 0,
    // What is IN THE BASE right now, counted from storage — Phase 20.20.
    //
    // Added because `documentCount` cannot answer "do I have any knowledge files?", which is
    // the first question a user has when they add one. Before the first build both are zero,
    // so a UI that only read `documentCount` would tell someone with one saved file that they
    // have "no knowledge files yet" — and then answer from it on the very next comment.
    // Two counts, because the gap between them is itself the useful signal: files on disk
    // that are not indexed means a build is pending or failed.
    storedDocumentCount: documents.length,
    sectionCount: meta.sectionCount || 0,
    builtAt: meta.builtAt || 0,
    error: meta.error || '',
    code: lastFailure.code || '',
    cached: cache.built
  };
}

/**
 * Drop the in-memory index.
 *
 * What a service-worker restart does implicitly, exposed for the tests and for the manual
 * reload path. It clears MEMORY only — the documents and the index metadata are untouched,
 * because they are the source of truth and this module does not own their lifecycle.
 *
 * @returns {void}
 */
export function clearKnowledgeIndexCache() {
  cache = { fingerprint: '', sections: [], documentCount: 0, builtAt: 0, built: false };
  lastFailure = { code: '', message: '', documents: [] };
}

/**
 * Every section in the index that is allowed to be retrieved from and cited as evidence.
 *
 * A convenience over `getKnowledgeIndex()` for retrieval's first step, and the single place
 * that applies `isSectionUsable()`. Retrieving from an EMPTY or DISABLED section would put
 * unusable text in front of the model as if it were knowledge.
 *
 * @param {{sections?: Array<Object>}} index
 * @returns {Array<Object>}
 */
export function usableSections(index) {
  if (!Array.isArray(index?.sections)) return [];
  return index.sections.filter((s) => s && s.empty !== true && isDocumentEnabled(s));
}