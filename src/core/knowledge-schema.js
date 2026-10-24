/**
 * Knowledge Schema — Phase 20.1
 *
 * The Phase 20 contract in one sentence is "the Knowledge Base is the source of truth and
 * the model may only use information supported by it". That is only enforceable if the KB
 * has a shape that can be *traced*, *invalidated* and *resolved*, so this file defines that
 * shape before a single line of retrieval or generation exists.
 *
 * Four things live here, and nothing else:
 *
 *   1. THE DOCUMENT MODEL — one user-authored Markdown file.
 *   2. THE SECTION MODEL — one heading's worth of content inside a document.
 *   3. THE INDEX LIFECYCLE — how a caller knows whether an index is usable.
 *   4. THE ERROR MODEL — the stable codes §32 of the phase names.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * No parsing (that is 20.3, src/core/markdown-parser.js), no indexing, no retrieval, no
 * `chrome.*`, no DOM, no network. It is a pure description of shapes plus the small
 * deterministic helpers every later milestone needs: filename normalization, a content
 * hash, an evidence id, a fingerprint, and a precedence comparison.
 *
 * THE STORAGE DECISION, AND WHY IT IS THE SAFE DIRECTION
 * ------------------------------------------------------
 * `chrome.storage.local` holds TWO knowledge keys and no more:
 *
 *   knowledgeDocuments — the user's Markdown, the single source of truth.
 *   knowledgeIndexMeta — { fingerprint, sectionCount, builtAt, state }: about five scalars.
 *
 * The INDEXED SECTIONS ARE NEVER PERSISTED. They are derived, and a derived copy that
 * lives in storage is a second source of truth that goes stale. Test 10 of the phase
 * ("update the document, the new retrieval must use 370 and the old cached knowledge must
 * not be used") is the failure this rule exists to make structurally impossible: there is
 * no stored section to be stale, and the in-memory index is validated against the
 * documents' fingerprint before every use, so a knowledge edit is detected rather than
 * trusted.
 *
 * What `knowledgeIndexMeta` IS for: answering "was this index built from the documents I
 * have now?" after a service-worker restart, without re-parsing anything, and showing the
 * user a real indexing status instead of a spinner that never resolves.
 *
 * WHY `enabled` AND NOT `active`
 * -----------------------------
 * §18 lists `active` among the conflict-resolution fields. The field here is named
 * `enabled` because that is the name every other user-facing on/off switch in this codebase
 * already uses (trigger rules, context templates), and one vocabulary for "the user turned
 * this off" is worth more than matching a name in a design document. It means exactly what
 * `active` would have meant.
 *
 * WHY THE HASH IS NOT CRYPTOGRAPHIC
 * ---------------------------------
 * It is used only to answer "did this text change since last time?" — never to detect
 * tampering, never in a security decision. FNV-1a is used because it is SYNCHRONOUS and
 * behaves identically in the service worker, in a browser page and in Node, which
 * `crypto.subtle.digest` cannot promise without making every caller async. Two seeded
 * passes give 16 hex characters, which is far beyond what change detection needs across a
 * handful of documents.
 */

import { normalizeArabic } from './matchers/arabic-normalizer.js';

// ─── Limits ────────────────────────────────────────────────────────────────────

/**
 * Most documents kept in the knowledge base.
 *
 * Bounds the storage blob and, more importantly, the retrieval candidate pool: §11 reranks
 * with the model, so a base of unbounded size would make every comment cost a large prompt.
 */
export const MAX_KNOWLEDGE_DOCUMENTS = 50;

/**
 * Longest accepted document, in characters.
 *
 * `chrome.storage.local` is quota-limited (10 MB with the `storage` permission this
 * extension declares, and the whole store also holds settings, logs, handled comments and
 * pending jobs). Fifty documents at this ceiling would already exhaust it, so the bound is
 * here to make a single pasted wall of text a visible refusal rather than a storage write
 * that fails somewhere else entirely.
 */
export const MAX_DOCUMENT_CHARS = 100_000;

/** Longest accepted filename, in characters. It is a label and a path, not a document. */
export const MAX_DOCUMENT_FILENAME_CHARS = 120;

/** Longest evidence id, in characters. See buildEvidenceId() for the truncation rule. */
export const MAX_EVIDENCE_ID_CHARS = 120;

/** Extensions accepted. Plain Markdown only — §4 forbids making users convert anything. */
export const ACCEPTED_EXTENSIONS = Object.freeze(['.md', '.markdown']);

// ─── Storage keys ──────────────────────────────────────────────────────────────
/**
 * The only two knowledge keys this feature writes.
 *
 * NOT settings: neither key may be added to DEFAULT_CONFIG or to the explicit key list in
 * getSettings(). They are read straight from `chrome.storage.local`, exactly like
 * `pendingJobs` and `activityLogs`, because they are user content rather than
 * configuration — a user with a 40-document knowledge base must not have every one of them
 * copied and deep-merged into a fresh object on every single queue iteration.
 */
export const STORAGE_KEYS = Object.freeze({
  DOCUMENTS: 'knowledgeDocuments',
  INDEX_META: 'knowledgeIndexMeta',
});

// ─── Index lifecycle ───────────────────────────────────────────────────────────

/**
 * The index's lifecycle states.
 *
 * This exists so "may I use the index?" is one comparison rather than a judgement call at
 * every call site. In particular `FRESH` is the ONLY state that authorizes retrieval: a
 * stale index is re-built, and a failed one is reported, because answering a comment from
 * an index whose documents have since changed is how the extension ends up publishing a
 * price the user has already corrected.
 */
export const INDEX_STATE = Object.freeze({
  /** No documents, or none enabled. There is nothing to retrieve and nothing to say. */
  EMPTY: 'empty',
  /** Built from the documents currently on disk. Safe to retrieve from. */
  FRESH: 'fresh',
  /** Documents changed since the last build. Must be rebuilt before use. */
  STALE: 'stale',
  /** A build is in flight. */
  BUILDING: 'building',
  /** The last build threw. Recorded with its error so the UI can show why. */
  FAILED: 'failed',
});

// ─── Error model ───────────────────────────────────────────────────────────────

/**
 * The error codes §32 of the phase enumerates.
 *
 * FROZEN and spelled exactly as the phase spells them, because these strings end up in
 * `activityLogs`, in the Side Panel and in bug reports. Renaming one later silently
 * invalidates every saved log line and every diagnostic filter built on it.
 *
 * The most important distinction in this list is between EXPECTED_SKIP and failure.
 * NO_SUPPORTED_ANSWER is the phase working correctly — it is the deliberate outcome of §24
 * — and must never be presented to the user as an error.
 */
export const KNOWLEDGE_ERROR = Object.freeze({
  /** The comment is understood, but the knowledge does not support any factual answer. */
  NO_SUPPORTED_ANSWER: 'NO_SUPPORTED_ANSWER',
  /** Retrieval found nothing relevant to the comment at all. */
  NO_RELEVANT_KNOWLEDGE: 'NO_RELEVANT_KNOWLEDGE',
  /** Two documents disagree and precedence cannot resolve it. */
  CONFLICTING_KNOWLEDGE: 'CONFLICTING_KNOWLEDGE',
  /** A document could not be read, parsed or stored. */
  INVALID_KNOWLEDGE_DOCUMENT: 'INVALID_KNOWLEDGE_DOCUMENT',
  /** The intent call came back unreadable. */
  INTENT_PARSE_FAILED: 'INTENT_PARSE_FAILED',
  /** The answerability call came back unreadable. */
  ANSWERABILITY_PARSE_FAILED: 'ANSWERABILITY_PARSE_FAILED',
  /** Grounded generation failed. */
  GENERATION_FAILED: 'GENERATION_FAILED',
  /**
   * The grounding validator itself could not be read (Phase 20.10).
   *
   * Deliberately NOT the same code as GROUNDING_VALIDATION_FAILED. Both mean "do not
   * publish", but one means "the reply contained a claim the knowledge does not support" and
   * the other means "we could not tell". Reporting a flaky validator as a safety rejection
   * would tell the user their knowledge base is producing wrong answers when the reply may
   * have been perfectly correct — the same misreading AGENTS.md records for a missed trigger
   * match, and the reason the AI and safety buckets exist separately.
   */
  GROUNDING_CHECK_FAILED: 'GROUNDING_CHECK_FAILED',
  /** The reply contains a claim the retrieved knowledge does not support. */
  GROUNDING_VALIDATION_FAILED: 'GROUNDING_VALIDATION_FAILED',
  /** The reply failed the EXISTING validator, not the knowledge one. */
  REPLY_VALIDATION_FAILED: 'REPLY_VALIDATION_FAILED',
  /** The index could not be built. */
  KNOWLEDGE_INDEX_FAILED: 'KNOWLEDGE_INDEX_FAILED',
});

/**
 * The buckets of §32, as code.
 *
 * The bucket is what the processing UI groups by: "answerable but skipped" and "the model
 * failed" are both skips to a user, but only one of them is the feature behaving.
 */
export const ERROR_CATEGORY = Object.freeze({
  /** Expected skip — the feature working. */
  EXPECTED_SKIP: 'expected_skip',
  /** Nothing relevant was retrieved. */
  RETRIEVAL: 'retrieval',
  /** The knowledge itself is the problem: conflicts, unreadable documents. */
  KNOWLEDGE: 'knowledge',
  /** An LM Studio call failed or was unreadable. */
  AI: 'ai',
  /** A reply was produced but rejected. */
  SAFETY: 'safety',
  /** The system could not do its job: index build, storage. */
  SYSTEM: 'system',
});

/**
 * Which bucket each code belongs to.
 *
 * A table rather than a property on the codes themselves, because Object.freeze is what
 * keeps the code strings stable and adding behaviour to them would break that.
 */
const ERROR_CATEGORY_BY_CODE = Object.freeze({
  [KNOWLEDGE_ERROR.NO_SUPPORTED_ANSWER]: ERROR_CATEGORY.EXPECTED_SKIP,
  [KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE]: ERROR_CATEGORY.RETRIEVAL,
  [KNOWLEDGE_ERROR.CONFLICTING_KNOWLEDGE]: ERROR_CATEGORY.KNOWLEDGE,
  [KNOWLEDGE_ERROR.INVALID_KNOWLEDGE_DOCUMENT]: ERROR_CATEGORY.KNOWLEDGE,
  [KNOWLEDGE_ERROR.INTENT_PARSE_FAILED]: ERROR_CATEGORY.AI,
  [KNOWLEDGE_ERROR.ANSWERABILITY_PARSE_FAILED]: ERROR_CATEGORY.AI,
  [KNOWLEDGE_ERROR.GENERATION_FAILED]: ERROR_CATEGORY.AI,
  [KNOWLEDGE_ERROR.GROUNDING_CHECK_FAILED]: ERROR_CATEGORY.AI,
  [KNOWLEDGE_ERROR.GROUNDING_VALIDATION_FAILED]: ERROR_CATEGORY.SAFETY,
  [KNOWLEDGE_ERROR.REPLY_VALIDATION_FAILED]: ERROR_CATEGORY.SAFETY,
  [KNOWLEDGE_ERROR.KNOWLEDGE_INDEX_FAILED]: ERROR_CATEGORY.SYSTEM,
});

/**
 * Bucket a knowledge error code.
 *
 * An unknown code falls back to SYSTEM rather than throwing: this is called while
 * formatting a skip for display, and a formatting helper that can throw is a formatting
 * helper that loses the original error.
 *
 * @param {string} code
 * @returns {string} one of ERROR_CATEGORY
 */
export function categorizeKnowledgeError(code) {
  return ERROR_CATEGORY_BY_CODE[code] || ERROR_CATEGORY.SYSTEM;
}

/**
 * Whether a code means "the knowledge base answered, and the answer was no".
 *
 * True for the codes where replying was correctly withheld. Callers use this to keep the
 * NO_SUPPORTED_ANSWER case out of the failure counters — conflating the two is what makes
 * the Side Panel read "failed 40" on a healthy knowledge base full of unsupported
 * questions.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isExpectedKnowledgeSkip(code) {
  return categorizeKnowledgeError(code) === ERROR_CATEGORY.EXPECTED_SKIP;
}

// ─── Filenames and paths ───────────────────────────────────────────────────────

/**
 * Normalize a user-supplied knowledge filename to the one stored form.
 *
 * Accepts what a person actually types (`.\books\chemistry.md`, `books//chemistry.md`,
 * a stray leading slash) and refuses what would be dangerous or ambiguous. Traversal is
 * rejected outright rather than stripped: `../../secrets.md` is not a filename anyone
 * meant to add, and silently "fixing" it would make the stored path disagree with what
 * the user sees in the list.
 *
 * @param {*} value
 * @returns {string} the normalized path, or '' when unusable
 */
export function normalizeFilename(value) {
  if (typeof value !== 'string') return '';

  let path = value
    .trim()
    // Windows separators, because a Windows user pasting a folder tree is a realistic
    // case and this extension is loaded unpacked on whatever machine the user has.
    .replace(/\\/g, '/')
    // Collapse repeated slashes and drop a single leading "./" or "/".
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

  if (!path) return '';
  if (path.length > MAX_DOCUMENT_FILENAME_CHARS) return '';

  // Traversal, checked AFTER the normalization above so `a/../../b.md` is caught too.
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return '';
  // A trailing slash means the user pointed at a directory, not a document.
  if (segments[segments.length - 1] === '') return '';

  const extension = extensionOf(path);
  if (!ACCEPTED_EXTENSIONS.includes(extension)) return '';

  return path;
}

/**
 * The lower-cased extension of a path, including the dot, or '' when there is none.
 *
 * @param {string} path
 * @returns {string}
 */
function extensionOf(path) {
  const name = String(path).split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Split a stored filename into its category folder and its basename.
 *
 * `category` is the single path segment above the file, which is how the phase's example
 * tree (`knowledge/books/chemistry.md`) gives a document its scope. It is the CONCEPTUAL
 * category: the extension never sees a disk, so a folder name here is a label the user
 * chose, not a filesystem location.
 *
 * @param {string} filename
 * @returns {{category: string, basename: string}}
 */
export function splitCategory(filename) {
  const path = typeof filename === 'string' ? filename : '';
  const segments = path.split('/').filter(Boolean);
  const basename = segments.pop() || '';
  // Only the IMMEDIATE parent folder. A deeper tree still works — the extra segments stay
  // in `filename`, which is what gets logged and stored — but `category` stays one label.
  return { category: segments.length ? segments[segments.length - 1] : '', basename };
}

/**
 * Reduce any heading or filename fragment to an evidence-id token.
 *
 * Unicode letters and digits survive, so an Arabic heading produces a readable Arabic
 * token rather than an empty one — the model has to echo this string back verbatim in its
 * evidence list (§15), and a token it cannot read is a token it will mangle. Everything
 * else collapses to single hyphens.
 *
 * @param {*} value
 * @returns {string}
 */
export function slugify(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).normalize('NFC');
  return text
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the stable evidence id §15 requires for a section.
 *
 * Shape: `KNOWLEDGE-<CATEGORY>-<BASENAME>-<HEADING>...`, e.g.
 * `KNOWLEDGE-BOOKS-CHEMISTRY-PRICE`.
 *
 * STABLE ON PURPOSE: the id is derived only from the document's path and heading path, so
 * re-indexing unchanged knowledge yields the same ids and every evidence reference already
 * handed to the validator stays valid. That is what lets the cache be thrown away and
 * rebuilt freely.
 *
 * A path longer than MAX_EVIDENCE_ID_CHARS is truncated and given a short hash suffix
 * rather than simply cut. Cutting alone would let two long paths collide on one id, and a
 * collided evidence id is a grounding-validation hole: a reply could cite the wrong
 * section and pass.
 *
 * @param {{category?: string, filename?: string, headingPath?: string[]}} source
 * @returns {string}
 */
export function buildEvidenceId(source) {
  const parts = [slugify(source?.category)];
  const basename = splitCategory(source?.filename).basename.replace(/\.(md|markdown)$/i, '');
  parts.push(slugify(basename));
  for (const heading of Array.isArray(source?.headingPath) ? source.headingPath : []) {
    parts.push(slugify(heading));
  }

  const tokens = parts.filter(Boolean);
  const id = `KNOWLEDGE-${tokens.length ? tokens.join('-') : 'UNTITLED'}`;
  if (id.length <= MAX_EVIDENCE_ID_CHARS) return id;

  // '-HASH-' plus eight hex characters is fifteen characters of disambiguator, and they
  // come out of the same budget — a truncated id is still a bounded-length id.
  const suffix = hashString(id).slice(0, 8);
  return `${id.slice(0, MAX_EVIDENCE_ID_CHARS - 15)}-HASH-${suffix}`;
}

// ─── Hashing ───────────────────────────────────────────────────────────────────

/**
 * One FNV-1a pass over a string's UTF-16 code units.
 *
 * Both bytes of each code unit are folded in, so the hash sees Arabic and emoji rather
 * than only their low byte.
 *
 * @param {string} text
 * @param {number} seed
 * @returns {number} a 32-bit unsigned integer
 */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hash a string for change detection.
 *
 * Two seeded passes, 16 hex characters. Not cryptographic, and not used as if it were: see
 * the file header.
 *
 * @param {*} value
 * @returns {string} 16 hex characters, or the hash of '' for a non-string
 */
export function hashString(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const a = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(text, 0x01000193).toString(16).padStart(8, '0');
  return a + b;
}

/**
 * Hash a document's CONTENT specifically.
 *
 * Normalizes Arabic first, then folds whitespace. That makes the fingerprint answer the
 * question the user actually asks — "did the answer to a comment change?" — rather than
 * "did a byte move?". Re-saving a file with the retyped diacritics, or with the line
 * endings a Windows editor rewrote, must not invalidate the index; changing 350 to 370
 * must.
 *
 * @param {*} content
 * @returns {string}
 */
/**
 * Phase 20.21 — a bounded cache for {@link hashContent}.
 *
 * `hashContent()` runs the FULL Arabic normalization over a document's entire text, and
 * `toKnowledgeDocument()` calls it once per document. Since `getKnowledgeDocuments()` is on
 * the reply path — `getKnowledgeIndex()` reads it once per comment to compare the
 * fingerprint — every comment re-normalized and re-hashed the WHOLE knowledge base to
 * recompute values that could not possibly have changed. Measured at a 100k-character base
 * that was ~4ms per comment, and ~10ms at the size where the section ceiling is reached.
 *
 * This is a cache of a PURE function, so it cannot go stale: the same text always hashed to
 * the same value, and the text is the cache key.
 *
 * Bounded by ENTRY count rather than by character count, and deliberately sized to
 * `MAX_KNOWLEDGE_DOCUMENTS`: the only caller hashes one document list at a time, so that is
 * exactly the working set, and total memory therefore stays within the store's own
 * `MAX_TOTAL_KNOWLEDGE_CHARS` limit. Eviction is FIFO rather than LRU — a base being edited
 * is the case where LRU would matter and FIFO is within a few percent of it.
 */
const contentHashCache = new Map();

/** Drop every memoized hash. Exported for tests and for a deliberate cold start. */
export function clearContentHashCache() {
  contentHashCache.clear();
}

export function hashContent(content) {
  const text = content === null || content === undefined ? '' : String(content);

  const cached = contentHashCache.get(text);
  if (cached !== undefined) {
    return cached;
  }

  const normalized = normalizeArabic(text).replace(/\s+/g, ' ').trim();
  const value = hashString(normalized);

  if (contentHashCache.size >= MAX_KNOWLEDGE_DOCUMENTS) {
    const oldest = contentHashCache.keys().next();
    if (!oldest.done) contentHashCache.delete(oldest.value);
  }
  contentHashCache.set(text, value);
  return value;
}

/**
 * One fingerprint for a whole set of documents.
 *
 * Computed over id, content hash, version, enabled and priority — the five fields that
 * change what a retrieval would return. `updatedAt` is deliberately EXCLUDED: re-saving an
 * unchanged document, or re-ordering the list, must not invalidate a usable index.
 *
 * The set is sorted by id first, so the fingerprint does not depend on the order documents
 * happen to be stored in.
 *
 * @param {Array<Object>} documents
 * @returns {string} a fingerprint, or '' when the set is empty
 */
export function computeFingerprint(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return '';

  const parts = documents
    .filter((doc) => doc && typeof doc === 'object')
    .map((doc) => [doc.id, doc.hash, doc.version, doc.enabled === false ? 0 : 1, doc.priority].join('~'))
    .sort()
    .join('|');

  return hashString(parts);
}

// ─── Document model ────────────────────────────────────────────────────────────

/** Generate a document id in the same shape trigger-crud.js and context-templates.js use. */
function generateDocumentId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 7);
  return `kdoc-${timestamp}-${random}`;
}

/**
 * Why a document input was refused.
 *
 * Stable tokens, for tests and for the Options page to turn into a message. Kept separate
 * from the thrown Error text so the wording can be improved without breaking a caller.
 */
export const DOCUMENT_REJECTION = Object.freeze({
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  BAD_FILENAME: 'BAD_FILENAME',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  CONTENT_TOO_LONG: 'CONTENT_TOO_LONG',
  NOT_A_STRING: 'NOT_A_STRING',
});

/**
 * Validate a document before it is stored, without building one.
 *
 * @param {Object} input
 * @returns {{valid: boolean, reason: (string|null)}}
 */
export function validateDocumentInput(input) {
  if (!input || typeof input !== 'object') return { valid: false, reason: DOCUMENT_REJECTION.NOT_AN_OBJECT };
  if (!normalizeFilename(input.filename)) return { valid: false, reason: DOCUMENT_REJECTION.BAD_FILENAME };
  if (typeof input.content !== 'string') return { valid: false, reason: DOCUMENT_REJECTION.NOT_A_STRING };
  if (input.content.trim().length === 0) return { valid: false, reason: DOCUMENT_REJECTION.EMPTY_CONTENT };
  if (input.content.length > MAX_DOCUMENT_CHARS) return { valid: false, reason: DOCUMENT_REJECTION.CONTENT_TOO_LONG };
  return { valid: true, reason: null };
}

/**
 * Reduce any input to the stored document shape, or null when it is unusable.
 *
 * Every field is normalized here rather than at the call sites, so a document read back out
 * of storage is indistinguishable from one just written by the Options page. That is what
 * lets the fingerprint be trustworthy.
 *
 * `enabled` defaults to TRUE and `priority` to 0, because a user who adds a knowledge file
 * expects it to be used. Opt-out for `enabled` is the same convention the trigger rules
 * follow, and it is what makes a hand-edited document with no `enabled` field still answer
 * questions rather than silently disappear from the base.
 *
 * @param {Object} input
 * @returns {Object|null} the document, or null when unusable
 */
export function toKnowledgeDocument(input) {
  if (!validateDocumentInput(input).valid) return null;

  const filename = normalizeFilename(input.filename);
  const { category } = splitCategory(filename);

  return {
    id: typeof input.id === 'string' && input.id ? input.id : generateDocumentId(),
    filename,
    category,
    content: input.content,
    hash: hashContent(input.content),
    version:
      typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0
        ? input.version
        : 1,
    updatedAt:
      typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt > 0
        ? input.updatedAt
        : Date.now(),
    enabled: input.enabled !== false,
    priority:
      typeof input.priority === 'number' && Number.isInteger(input.priority)
        ? input.priority
        : 0,
  };
}

/**
 * Whether a document may be searched at all.
 *
 * A disabled document is kept — the user may want it back in a week — but it must never be
 * retrieved from, never cited as evidence and never win a conflict.
 *
 * @param {*} doc
 * @returns {boolean}
 */
export function isDocumentEnabled(doc) {
  return !!doc && typeof doc === 'object' && doc.enabled !== false;
}

/**
 * Whether two stored documents are the same file as far as the list is concerned.
 *
 * Case-insensitive on the filename, because two documents called `Chemistry.md` and
 * `chemistry.md` are the same document to a person and two sources of truth to a model —
 * and §18 says an unresolvable conflict must skip, not pick.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function isSameDocumentFilename(a, b) {
  const left = normalizeFilename(a?.filename);
  const right = normalizeFilename(b?.filename);
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Which of two documents wins a conflict, and why.
 *
 * The order is §18's list, most explicit first:
 *   1. enabled  — an active document beats a disabled one, always
 *   2. priority — the user's explicit override, highest wins
 *   3. version  — higher wins (a replacement supersedes what it replaced)
 *   4. updatedAt — most recently edited wins
 *   5. id       — deterministic tie-break, so the same pair always resolves the same way
 *
 * The tie-break exists so the comparator is a total order and callers cannot get
 * different winners from the same input in the same run. It does NOT make an ambiguous
 * conflict resolvable: `resolveDocumentPrecedence()` reports that case separately, because
 * §18 requires a skip and not a guess.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number} positive when `a` wins, negative when `b` wins, 0 when identical
 */
export function compareDocumentPrecedence(a, b) {
  const enabledA = isDocumentEnabled(a);
  const enabledB = isDocumentEnabled(b);
  if (enabledA !== enabledB) return enabledA ? 1 : -1;

  const priorityA = typeof a?.priority === 'number' ? a.priority : 0;
  const priorityB = typeof b?.priority === 'number' ? b.priority : 0;
  if (priorityA !== priorityB) return priorityA > priorityB ? 1 : -1;

  const versionA = typeof a?.version === 'number' ? a.version : 1;
  const versionB = typeof b?.version === 'number' ? b.version : 1;
  if (versionA !== versionB) return versionA > versionB ? 1 : -1;

  const updatedA = typeof a?.updatedAt === 'number' ? a.updatedAt : 0;
  const updatedB = typeof b?.updatedAt === 'number' ? b.updatedAt : 0;
  if (updatedA !== updatedB) return updatedA > updatedB ? 1 : -1;

  const idA = String(a?.id || '');
  const idB = String(b?.id || '');
  if (idA === idB) return 0;
  return idA > idB ? 1 : -1;
}

/**
 * Whether two documents are genuinely indistinguishable for conflict purposes.
 *
 * Deliberately ignores the id: ids exist to make the comparator deterministic, not to
 * manufacture a decision. Two documents that agree on enabled, priority, version and
 * updatedAt say the same thing about their authority, and §18's answer to that is
 * CONFLICTING_KNOWLEDGE, not "whichever id sorts higher".
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function isAmbiguousConflict(a, b) {
  if (!a || !b) return true;
  return (
    isDocumentEnabled(a) === isDocumentEnabled(b) &&
    (a.priority || 0) === (b.priority || 0) &&
    (a.version || 1) === (b.version || 1) &&
    (a.updatedAt || 0) === (b.updatedAt || 0)
  );
}

/**
 * Reduce a candidate set to the one document that wins a conflict.
 *
 * @param {Array<Object>} documents
 * @returns {{winner: (Object|null), ambiguous: boolean, reason: string}}
 *   `ambiguous: true` means the caller must report CONFLICTING_KNOWLEDGE and skip.
 */
export function resolveDocumentPrecedence(documents) {
  const usable = Array.isArray(documents)
    ? documents.filter((doc) => doc && typeof doc === 'object')
    : [];
  if (usable.length === 0) return { winner: null, ambiguous: false, reason: 'no candidates' };
  if (usable.length === 1) return { winner: usable[0], ambiguous: false, reason: 'single candidate' };

  // Only ENABLED documents compete. A disabled document is not a conflict, it is simply
  // out of scope, so mixing it into the comparison would make every base with a switched-off
  // document ambiguous.
  const enabled = usable.filter(isDocumentEnabled);
  if (enabled.length === 0) return { winner: null, ambiguous: false, reason: 'no enabled candidates' };
  if (enabled.length === 1) return { winner: enabled[0], ambiguous: false, reason: 'single enabled candidate' };

  // DESCENDING. `compareDocumentPrecedence` returns a positive number when `a` WINS, so
  // sorting ascending puts the LOWEST-authority document first — and taking `sorted[0]`
  // then returned the loser. It went unnoticed because the only consumer until now used the
  // `ambiguous` flag and never looked at which document actually won; §18's resolution was
  // therefore reporting the wrong file as authoritative, and the Phase 20.12 audit inherits
  // it. Nothing incorrect reached a viewer (the winner is never used to build a reply), but it
  // would have named the wrong document in the UI.
  const sorted = [...enabled].sort((a, b) => compareDocumentPrecedence(b, a));
  const top = sorted[0];
  const runnerUp = sorted[1];

  if (isAmbiguousConflict(top, runnerUp)) {
    return { winner: null, ambiguous: true, reason: 'candidates have equal authority' };
  }
  return { winner: top, ambiguous: false, reason: 'resolved by precedence' };
}

// ─── Section model ─────────────────────────────────────────────────────────────

/**
 * Reduce parser output to the stored section shape, or null when unusable.
 *
 * An EMPTY section is legal and kept: §5 lists empty sections among the cases the parser
 * must handle, and an empty `## Notes` heading is real structure the user wrote. It is
 * marked `empty: true` so retrieval can skip it and the UI can show it, rather than
 * dropped here where the heading hierarchy would silently change shape.
 *
 * @param {Object} input
 * @returns {Object|null}
 */
export function toKnowledgeSection(input) {
  if (!input || typeof input !== 'object') return null;

  // The document may arrive as the object itself rather than as separate fields, which is
  // how the indexer will call this: it has one document in hand and a parsed section under
  // it, and passing the document through is what keeps the section's provenance impossible
  // to get wrong.
  const source = input.document && typeof input.document === 'object' ? input.document : {};
  const documentId = typeof input.documentId === 'string' && input.documentId
    ? input.documentId
    : (typeof source.id === 'string' ? source.id : '');
  if (!documentId) return null;

  const headingPath = Array.isArray(input.headingPath)
    ? input.headingPath
        .map((heading) => (typeof heading === 'string' ? heading.trim() : ''))
        .filter(Boolean)
    : [];

  const content = typeof input.content === 'string' ? input.content : '';

  const filename = normalizeFilename(input.filename || source.filename) || normalizeFilename(source.filename);
  const category = typeof input.category === 'string' && input.category
    ? input.category
    : splitCategory(filename).category;

  return {
    id: typeof input.id === 'string' && input.id ? input.id : hashString(`${documentId}|${headingPath.join('>')}|${input.ordinal || 0}`),
    evidenceId: buildEvidenceId({ category, filename, headingPath }),
    documentId,
    filename,
    category,
    headingPath,
    content,
    empty: content.trim().length === 0,
    ordinal: Number.isInteger(input.ordinal) && input.ordinal >= 0 ? input.ordinal : 0,
    hash: hashContent(content),
    // Carried through from the document so retrieval can apply the same precedence rules
    // without holding a second copy of the document list.
    enabled: input.enabled !== undefined ? input.enabled !== false : isDocumentEnabled(source),
    priority: typeof input.priority === 'number' ? input.priority : (typeof source.priority === 'number' ? source.priority : 0),
    version: typeof input.version === 'number' ? input.version : (typeof source.version === 'number' ? source.version : 1),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : (typeof source.updatedAt === 'number' ? source.updatedAt : 0),
  };
}

/**
 * Whether a section may be retrieved from and cited as evidence.
 *
 * @param {*} section
 * @returns {boolean}
 */
export function isSectionUsable(section) {
  return !!section && typeof section === 'object' && section.enabled !== false && section.empty !== true;
}

// ─── Index metadata ────────────────────────────────────────────────────────────

/**
 * Reduce anything to the stored index-metadata shape.
 *
 * Five scalars, by design — see the file header. `fingerprint` is the only field that
 * carries meaning: everything else describes a build, and a build is cheap to repeat.
 *
 * @param {Object} input
 * @returns {Object}
 */
export function toIndexMeta(input) {
  const meta = input && typeof input === 'object' ? input : {};
  return {
    fingerprint: typeof meta.fingerprint === 'string' ? meta.fingerprint : '',
    state: Object.values(INDEX_STATE).includes(meta.state) ? meta.state : INDEX_STATE.EMPTY,
    documentCount: Number.isInteger(meta.documentCount) && meta.documentCount >= 0 ? meta.documentCount : 0,
    sectionCount: Number.isInteger(meta.sectionCount) && meta.sectionCount >= 0 ? meta.sectionCount : 0,
    builtAt: typeof meta.builtAt === 'number' && Number.isFinite(meta.builtAt) ? meta.builtAt : 0,
    // A free-text reason for the last failure. Recorded, never displayed raw to the point
    // of replacing the user's own knowledge with an error string.
    error: typeof meta.error === 'string' ? meta.error : '',
  };
}

/**
 * Decide what state an index is in, given the documents currently on disk.
 *
 * The single gate retrieval goes through, so the rule "only FRESH authorizes retrieval"
 * has exactly one implementation:
 *
 *   - no documents, or none enabled → EMPTY
 *   - metadata records THIS fingerprint and was built successfully → FRESH
 *   - anything else → STALE (rebuild before use)
 *
 * A `FAILED` or `BUILDING` record is deliberately downgraded to STALE rather than honoured:
 * both mean there is no usable index, and reporting STALE is what makes the caller rebuild.
 * The failure itself is not lost — `toIndexMeta().error` still carries it for the UI.
 *
 * @param {Object} meta - stored index metadata
 * @param {Array<Object>} documents - the documents on disk right now
 * @returns {string} one of INDEX_STATE
 */
export function resolveIndexState(meta, documents) {
  const stored = toIndexMeta(meta);
  const enabled = Array.isArray(documents) ? documents.filter(isDocumentEnabled) : [];

  if (enabled.length === 0) return INDEX_STATE.EMPTY;

  const fingerprint = computeFingerprint(enabled);
  if (!fingerprint) return INDEX_STATE.EMPTY;

  return stored.state === INDEX_STATE.FRESH && stored.fingerprint === fingerprint
    ? INDEX_STATE.FRESH
    : INDEX_STATE.STALE;
}

/**
 * Whether retrieval may run against an index in this state.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isRetrievableState(state) {
  return state === INDEX_STATE.FRESH;
}