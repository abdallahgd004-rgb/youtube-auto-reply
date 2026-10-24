/**
 * Folder Sync — Phase 21.1
 *
 * Pulls a user's Markdown folder into the Knowledge Base, so they do not paste documents
 * into the Options page one at a time. The feature the base was designed around — §4's tree
 * of Markdown files — was in fact only ever reachable as a textarea.
 *
 * ── WHY THIS IS A SEPARATE MODULE ───────────────────────────────────────────
 *
 * Everything here is split at a line that is easy to get wrong. `planFolderSync()` is PURE:
 * two lists in, one plan out, no IO. `collectFolderFiles()` walks a FileSystemDirectoryHandle
 * that is INJECTED. That split is not tidiness — it is the only reason this is testable at all,
 * because `run-tests.mjs` drives suites over `file://` in headless Chrome where no picker can
 * open and no folder exists. The walk is exercised against a fake handle; the plan, which is
 * where the decisions live, is exercised against plain arrays.
 *
 * ── THE THREE RULES THE USER CHOSE ──────────────────────────────────────────
 *
 * ONE WAY. The folder is the source of truth. A document edited in the Options page is
 * overwritten by the next sync. The opposite direction was rejected deliberately: writing to
 * the user's disk from an extension is how a real file gets clobbered, and a folder the user
 * also syncs through git or a backup tool is exactly where that hurts most.
 *
 * MIRROR DELETES. A file removed from the folder is removed from the base. Anything else lets
 * a deleted price list keep answering, and the user has no way to see why.
 *
 * FLAGS SURVIVE. `enabled` and `priority` are the user's explicit overrides, and a sync must
 * not reset them. This is not a detail — §18 precedence reads them, so a sync that re-enabled
 * a retired price list would make the OLD file win every conflict and start answering with a
 * price the user deleted months ago. The failure is silent and looks exactly like the feature
 * working.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * It does not decide WHO may write. `knowledge-store.js` remains the sole writer of the
 * knowledge keys, and the folder is just another source of content feeding it. A second
 * writer would mean a second invalidation rule, and §33's "update the document, the old
 * cached knowledge must not be used" would fail with nothing to detect it.
 *
 * PURE as a whole: no `chrome.*`, no DOM, no direct IndexedDB. The handle arrives from the
 * caller.
 */

import {
  normalizeFilename,
  isSameDocumentFilename,
  hashContent,
  MAX_KNOWLEDGE_DOCUMENTS,
  MAX_DOCUMENT_CHARS,
} from './knowledge-schema.js';

/**
 * Limits for a folder walk.
 *
 * `maxFiles` is not arbitrary: it is `MAX_KNOWLEDGE_DOCUMENTS`, because a folder with more
 * Markdown files than the base can hold cannot be synced into it, and finding that out after
 * reading a thousand files is a worse experience than saying so up front.
 *
 * `maxDepth` stops a pathological tree. It is a guard, not a policy — a real knowledge folder
 * is two or three levels deep.
 */
export const FOLDER_SYNC_DEFAULTS = Object.freeze({
  maxFiles: MAX_KNOWLEDGE_DOCUMENTS,
  maxDepth: 6,
  maxFileChars: MAX_DOCUMENT_CHARS,
  extensions: Object.freeze(['.md', '.markdown']),
});

/** Why a file in the folder did not become a document. */
export const FOLDER_SKIP = Object.freeze({
  NOT_MARKDOWN: 'not-markdown',
  HIDDEN: 'hidden',
  TOO_DEEP: 'too-deep',
  TOO_MANY_FILES: 'too-many-files',
  TOO_LARGE: 'too-large',
  UNREADABLE: 'unreadable',
  BAD_NAME: 'bad-name',
});

/** Human-readable text for one skip reason. Shown in the Options sync summary. */
const SKIP_MESSAGES = {
  [FOLDER_SKIP.NOT_MARKDOWN]: 'not a Markdown file',
  [FOLDER_SKIP.HIDDEN]: 'hidden file or folder',
  [FOLDER_SKIP.TOO_DEEP]: 'nested too deeply',
  [FOLDER_SKIP.TOO_MANY_FILES]: 'over the document limit',
  [FOLDER_SKIP.TOO_LARGE]: 'larger than one document may be',
  [FOLDER_SKIP.UNREADABLE]: 'could not be read',
  [FOLDER_SKIP.BAD_NAME]: 'the path is not a usable document name',
};

/**
 * Explain one skip reason.
 *
 * A skip the user cannot see is a silent gap: the file is in their folder, the answer is not
 * coming from it, and nothing says why. The one exception is NOT_MARKDOWN, which is the
 * expected majority in a mixed folder and is counted rather than listed.
 *
 * @param {string} reason
 * @returns {string}
 */
export function describeSkip(reason) {
  return SKIP_MESSAGES[reason] || 'skipped';
}

/**
 * Whether a folder entry should become a knowledge document.
 *
 * Only the extension decides this, not the folder's own layout: a user who keeps notes in
 * the same folder as their knowledge base has non-Markdown files in it, and importing those
 * would fill the base with documents that carry no headings and answer nothing.
 *
 * Dot-files and dot-FOLDERS are skipped as a unit, so a `.git` directory never costs a walk.
 *
 * @param {string} name - the entry's own name, not a path
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function classifyEntryName(name) {
  const value = String(name == null ? '' : name);

  if (value.startsWith('.')) return { ok: false, reason: FOLDER_SKIP.HIDDEN };

  const dot = value.lastIndexOf('.');
  const extension = dot > 0 ? value.slice(dot).toLowerCase() : '';
  if (!FOLDER_SYNC_DEFAULTS.extensions.includes(extension)) {
    return { ok: false, reason: FOLDER_SKIP.NOT_MARKDOWN };
  }

  return { ok: true };
}

/**
 * Walk a directory handle and collect every usable Markdown file.
 *
 * The RELATIVE path becomes the document filename, so a folder tree arrives as a tree.
 * That matters for more than looks: `category` is the segment above the file, and §18's
 * precedence and §22's template scope both read it.
 *
 * Depth-limited and count-limited, and it never throws — a folder the user cannot read, or a
 * file that vanished mid-walk, becomes a skip. A sync that aborts on the first unreadable
 * file would be useless on a real desktop folder, which is full of things the extension
 * should simply not care about.
 *
 * NEVER REJECTS. Every failure is a skip.
 *
 * @param {Object} dirHandle - a FileSystemDirectoryHandle (or a fake with the same shape)
 * @param {Object} [options]
 * @returns {Promise<{files: Array<{path: string, handle: Object}>, skips: Array<{path: string, reason: string}>, truncated: boolean}>}
 */
export async function collectFolderFiles(dirHandle, options = {}) {
  const limits = { ...FOLDER_SYNC_DEFAULTS, ...(options || {}) };
  const files = [];
  const skips = [];
  let truncated = false;

  if (!dirHandle || typeof dirHandle.values !== 'function') {
    return { files, skips, truncated };
  }

  /** Recursive walk. Iterative by hand would need an explicit stack for no benefit here. */
  const walk = async (handle, prefix, depth) => {
    if (truncated) return;

    let entries;
    try {
      entries = [];
      // Async iteration over a directory handle. A fake handle in the suite implements the
      // same shape, which is why this is the one place the walk touches an object it did
      // not create.
      for await (const entry of handle.values()) entries.push(entry);
    } catch (_) {
      skips.push({ path: prefix || '.', reason: FOLDER_SKIP.UNREADABLE });
      return;
    }

    for (const entry of entries) {
      if (truncated) return;

      const name = String((entry && entry.name) || '');
      if (!name) continue;

      const path = prefix ? `${prefix}/${name}` : name;

      // Hidden entries are skipped before they are classified, and a hidden DIRECTORY is
      // never descended into — that is the whole point of skipping `.git`.
      if (name.startsWith('.')) {
        skips.push({ path, reason: FOLDER_SKIP.HIDDEN });
        continue;
      }

      if (entry.kind === 'directory') {
        if (depth + 1 > limits.maxDepth) {
          skips.push({ path, reason: FOLDER_SKIP.TOO_DEEP });
          continue;
        }
        await walk(entry, path, depth + 1);
        continue;
      }

      if (entry.kind !== 'file') continue;

      const verdict = classifyEntryName(name);
      if (!verdict.ok) {
        skips.push({ path, reason: verdict.reason });
        continue;
      }

      // A name the store would reject is dropped HERE rather than failing the sync later.
      // `normalizeFilename` is the same function the store validates with, so a path this
      // accepts is a path that will not be refused for its name.
      if (!normalizeFilename(path)) {
        skips.push({ path, reason: FOLDER_SKIP.BAD_NAME });
        continue;
      }

      if (files.length >= limits.maxFiles) {
        truncated = true;
        skips.push({ path, reason: FOLDER_SKIP.TOO_MANY_FILES });
        return;
      }

      files.push({ path, handle: entry });
    }
  };

  await walk(dirHandle, '', 0);

  // Sorted so a sync is deterministic: without this the walk order decides which file wins
  // when the same document is reachable twice, and a plan that reshuffles on every run makes
  // "nothing changed" impossible to state.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, skips, truncated };
}

/**
 * Read one collected entry into `{filename, content}`.
 *
 * Returns a failure instead of throwing, for the same reason the walk does: one unreadable
 * file must not cost the other forty-nine.
 *
 * @param {{path: string, handle: Object}} entry
 * @param {Object} [options]
 * @returns {Promise<{ok: true, document: {filename: string, content: string}} | {ok: false, reason: string, path: string}>}
 */
export async function readFolderEntry(entry, options = {}) {
  const limits = { ...FOLDER_SYNC_DEFAULTS, ...(options || {}) };

  if (!entry || !entry.handle || typeof entry.handle.getFile !== 'function') {
    return { ok: false, reason: FOLDER_SKIP.UNREADABLE, path: (entry && entry.path) || '' };
  }

  try {
    const file = await entry.handle.getFile();
    const content = await file.text();

    if (content.length > limits.maxFileChars) {
      return { ok: false, reason: FOLDER_SKIP.TOO_LARGE, path: entry.path };
    }
    // An empty file is a skip, not a document. `toKnowledgeDocument()` would refuse it anyway,
    // and letting it through would fail the whole sync on a stray blank note.
    if (!content.trim()) {
      return { ok: false, reason: FOLDER_SKIP.TOO_LARGE, path: entry.path };
    }

    return { ok: true, document: { filename: normalizeFilename(entry.path), content } };
  } catch (_) {
    return { ok: false, reason: FOLDER_SKIP.UNREADABLE, path: entry.path };
  }
}

/**
 * Compare what is stored against what the folder holds, and say what should change.
 *
 * PURE, and the whole decision lives here. `applyFolderSync()` in the store only executes a
 * plan this produced, so the rules that decide which file wins are testable without a disk.
 *
 * The three moves:
 *   - a stored document whose file is gone      → REMOVE (the mirror-delete rule)
 *   - a file whose content hash differs         → UPDATE, keeping `enabled`/`priority`
 *   - a file with no stored document            → ADD
 *
 * Comparison is on the CONTENT HASH, never on a mtime or a version counter. A hash says
 * "did this text change", which is the only question being asked; a timestamp would report a
 * change for a file that was merely re-saved, and turn every sync into noise.
 *
 * @param {Array<Object>} stored - the documents currently in the base
 * @param {Array<{filename: string, content: string}>} incoming - what the folder yielded
 * @returns {{add: Array, update: Array, unchanged: Array, remove: Array}}
 */
export function planFolderSync(stored, incoming) {
  const storedList = Array.isArray(stored) ? stored.filter(Boolean) : [];
  const incomingList = Array.isArray(incoming) ? incoming.filter(Boolean) : [];

  const add = [];
  const update = [];
  const unchanged = [];
  const remove = [];
  const matchedStored = new Set();

  for (const candidate of incomingList) {
    const filename = normalizeFilename(candidate && candidate.filename);
    if (!filename) continue;

    const current = storedList.find((doc) => !matchedStored.has(doc) && isSameDocumentFilename(doc, { filename }));

    if (!current) {
      add.push({ filename, content: String(candidate.content) });
      continue;
    }

    matchedStored.add(current);

    if (hashContent(current.content) === hashContent(String(candidate.content))) {
      unchanged.push(current);
      continue;
    }

    update.push({
      id: current.id,
      filename,
      content: String(candidate.content),
      // The user's overrides survive a sync. See the header: `enabled` and `priority` are
      // what §18 precedence reads, so resetting them silently re-promotes documents the
      // user retired.
      enabled: current.enabled !== false,
      priority: typeof current.priority === 'number' ? current.priority : 0,
    });
  }

  // Whatever is left in the base was not in the folder. The mirror-delete rule, and the one
  // that makes the base trustworthy: a knowledge base that keeps answering from a file the
  // user deleted is worse than one that says it does not know.
  for (const doc of storedList) {
    if (!matchedStored.has(doc)) remove.push(doc);
  }

  return { add, update, unchanged, remove };
}

/**
 * Whether a plan would change anything.
 *
 * A sync that rewrites identical documents is not harmless: it bumps `version`, which §18
 * precedence reads, so a no-op sync can make an old file start winning conflicts.
 *
 * @param {{add: Array, update: Array, unchanged: Array, remove: Array}} plan
 * @returns {boolean}
 */
export function planHasChanges(plan) {
  if (!plan) return false;
  return Boolean(
    (plan.add && plan.add.length) ||
    (plan.update && plan.update.length) ||
    (plan.remove && plan.remove.length)
  );
}

/**
 * Reduce a plan to the counts the Options page shows.
 *
 * @param {Object} plan
 * @param {Array} [skips]
 * @returns {{added: number, updated: number, unchanged: number, removed: number, skipped: number}}
 */
export function summarizePlan(plan, skips = []) {
  const p = plan || {};
  return {
    added: (p.add || []).length,
    updated: (p.update || []).length,
    unchanged: (p.unchanged || []).length,
    removed: (p.remove || []).length,
    skipped: Array.isArray(skips) ? skips.length : 0,
  };
}