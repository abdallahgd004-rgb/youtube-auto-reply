/**
 * Knowledge Folder Sync tests
 *
 * Phase 21.1. The feature exists because §4's premise is a TREE of Markdown files the user
 * already keeps, and the only way in was a textarea.
 *
 * These cover the DECISIONS, which is where the risk is:
 *   1. the walk: recursion, hidden folders, extensions, caps, never throwing
 *   2. the plan: add / update / unchanged / remove, and the flags that must SURVIVE
 *   3. reading: size caps and unreadable files becoming skips, not failures
 *
 * The walk runs against a FAKE directory handle. That is the seam that makes this testable at
 * all: `run-tests.mjs` drives suites over `file://` in headless Chrome, where no picker opens
 * and no folder exists, so a suite that needed a real directory would simply never run —
 * and a feature whose tests are always skipped is a feature whose rules drift.
 *
 * Runs in the browser from knowledge-folder-sync-tests.html.
 */

import {
  FOLDER_SYNC_DEFAULTS,
  FOLDER_SKIP,
  classifyEntryName,
  collectFolderFiles,
  readFolderEntry,
  planFolderSync,
  planHasChanges,
  summarizePlan,
  describeSkip,
} from '../knowledge-folder-sync.js';
import { toKnowledgeDocument } from '../knowledge-schema.js';

const results = { total: 0, passed: 0, failed: 0 };

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

// ── the fake handle ──────────────────────────────────────────────────────────

/**
 * A directory handle stand-in.
 *
 * Implements only what `collectFolderFiles()` actually uses — `values()` yielding entries with
 * `name`/`kind`, and `getFile()` — which is the point: the walk depends on that shape and not
 * on the browser's implementation of it.
 *
 * @param {Object} tree - { 'a.md': 'text', 'sub/b.md': 'text' } or an explicit node shape
 * @param {Object} [opts] - `{ failValues: true }` to make iteration throw
 */
function fakeDirectory(tree, opts = {}) {
  const entries = Object.entries(tree).map(([path, value]) => {
    const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    const prefix = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const depth = (prefix.match(/\//g) || []).length;

    if (value && value.__dir) {
      return {
        name,
        kind: 'directory',
        values: () => fakeDirectory(value.children, opts)[Symbol.asyncIterator](),
      };
    }
    if (typeof value === 'object' && value && !value.__dir) {
      return {
        name,
        kind: 'file',
        getFile: async () => {
          if (value.unreadable) throw new Error('EACCES');
          return {
            text: async () => {
              if (value.throwOnText) throw new Error('EIO');
              return value.text;
            },
          };
        },
      };
    }

    // A plain string means a FILE at that path. Group everything under one directory.
    return {
      name,
      kind: 'file',
      getFile: async () => ({ text: async () => value }),
    };
  });

  return {
    async *[Symbol.asyncIterator]() {
      if (opts.failValues) throw new Error('EACCES');
      for (const entry of entries) yield entry;
    },
    values() {
      return this[Symbol.asyncIterator]();
    },
  };
}

/** Build a nested fake folder from a flat path map. */
function folderFromPaths(paths, opts = {}) {
  const tree = {};
  for (const [path, text] of Object.entries(paths)) {
    const parts = path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i];
      node[dir] = node[dir] || { __dir: true, children: {} };
      node = node[dir].children;
    }
    node[parts[parts.length - 1]] = { text };
  }
  return fakeDirectory(tree, opts);
}

/** A stored document, as `toKnowledgeDocument()` would produce it. */
function stored(filename, content, extra = {}) {
  const doc = toKnowledgeDocument({ filename, content });
  if (!doc) throw new Error(`fixture is not a valid document: ${filename}`);
  return { ...doc, ...extra };
}

// ── 1. classifying entries ───────────────────────────────────────────────────

async function testOnlyMarkdownFilesAreImported() {
  const cases = [
    ['notes.md', true],
    ['notes.MD', true],
    ['notes.markdown', true],
    ['notes.txt', false],
    ['notes', false],
    ['image.png', false],
    ['archive.md.zip', false],
  ];

  for (const [name, expected] of cases) {
    const got = classifyEntryName(name).ok === true;
    if (got !== expected) return `${name}: expected ${expected ? 'import' : 'skip'}, got ${got}`;
  }
  return true;
}

/**
 * Dot-files AND dot-folders are skipped.
 *
 * The folder case is the one that matters: a user keeping a knowledge folder next to a git
 * repo, or inside `~/.config`, would otherwise have the walk descend into a `.git` directory
 * with tens of thousands of objects.
 */
async function testHiddenEntriesAreSkipped() {
  if (classifyEntryName('.hidden.md').ok) return 'a dot-file must be skipped';
  if (classifyEntryName('.git').ok) return 'a dot-folder must be skipped';

  const dir = folderFromPaths({ '.git/config.md': 'x', 'real.md': 'y', 'a/.cache/inner.md': 'z' });
  const { files, skips } = await collectFolderFiles(dir);

  const paths = files.map((f) => f.path);
  if (paths.some((p) => p.includes('.git') || p.includes('.cache'))) {
    return `hidden directories were walked: ${paths.join(', ')}`;
  }
  if (paths.length !== 1 || paths[0] !== 'real.md') {
    return `expected only real.md, got ${paths.join(', ') || '(nothing)'}`;
  }
  if (!skips.some((s) => s.reason === FOLDER_SKIP.HIDDEN)) return 'hidden entries were not recorded as skips';
  return true;
}

// ── 2. the walk ──────────────────────────────────────────────────────────────

async function testSubfoldersBecomePartOfTheFilename() {
  const dir = folderFromPaths({
    'chemistry.md': 'top level',
    'books/chemistry.md': 'nested',
    'books/2027/physics.md': 'deeply nested',
  });

  const { files } = await collectFolderFiles(dir);
  const paths = files.map((f) => f.path).sort();

  const expected = ['books/2027/physics.md', 'books/chemistry.md', 'chemistry.md'];
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    return `expected ${expected.join(', ')}, got ${paths.join(', ')}`;
  }
  return true;
}

/**
 * The walk order is deterministic.
 *
 * Without sorting, a sync reshuffles on every run and "nothing changed" becomes unstatable —
 * and worse, when a path is reachable twice the order decides which file wins.
 */
async function testTheWalkOrderIsDeterministic() {
  const dir = folderFromPaths({ 'c.md': '1', 'a.md': '2', 'b.md': '3' });
  const first = (await collectFolderFiles(dir)).files.map((f) => f.path);
  const second = (await collectFolderFiles(dir)).files.map((f) => f.path);
  if (JSON.stringify(first) !== JSON.stringify(second)) return 'two walks of one folder disagreed';
  if (first.join() !== 'a.md,b.md,c.md') return `expected sorted paths, got ${first.join()}`;
  return true;
}

async function testTheWalkIsDepthLimited() {
  const paths = {};
  // One level deeper than the default limit allows.
  for (let i = 0; i < FOLDER_SYNC_DEFAULTS.maxDepth + 2; i += 1) {
    paths[`${'d/'.repeat(i)}file.md`] = 'deep';
  }

  const { files, skips } = await collectFolderFiles(folderFromPaths(paths));

  // `maxDepth` bounds DIRECTORY nesting; a file sits inside one, so the deepest legal file
  // path has maxDepth + 1 segments. Asserting on the directory depth states the rule the
  // walk actually applies.
  const dirDepth = (path) => path.split('/').length - 1;
  if (files.some((f) => dirDepth(f.path) > FOLDER_SYNC_DEFAULTS.maxDepth)) {
    return `a file nested deeper than ${FOLDER_SYNC_DEFAULTS.maxDepth} directories was collected`;
  }
  if (files.length === 0) return 'the depth limit collected nothing at all';

  // And the files it DID keep are the shallower ones.
  if (files.some((f) => dirDepth(f.path) >= FOLDER_SYNC_DEFAULTS.maxDepth + 1)) {
    return 'a file beyond the depth limit was kept';
  }
  if (!skips.some((s) => s.reason === FOLDER_SKIP.TOO_DEEP)) {
    return 'the depth limit did not report a skip';
  }
  return true;
}

/**
 * The file cap matches what the base can hold.
 *
 * Not a tuning choice: a folder with more Markdown files than `MAX_KNOWLEDGE_DOCUMENTS` cannot
 * be synced in full, and discovering that after reading everything is a worse answer than
 * stopping and saying so.
 */
async function testTheWalkStopsAtTheDocumentLimit() {
  const paths = {};
  for (let i = 0; i < FOLDER_SYNC_DEFAULTS.maxFiles + 5; i += 1) paths[`f${i}.md`] = 'x';

  const { files, truncated } = await collectFolderFiles(folderFromPaths(paths));
  if (files.length !== FOLDER_SYNC_DEFAULTS.maxFiles) {
    return `expected the walk to stop at ${FOLDER_SYNC_DEFAULTS.maxFiles}, got ${files.length}`;
  }
  if (truncated !== true) return 'truncation was not reported';
  return true;
}

/**
 * A folder the user cannot read is a skip, never a throw.
 *
 * A real desktop folder contains things the extension should ignore and at least one thing it
 * cannot open. A sync that aborts on the first of those is useless in practice.
 */
async function testAnUnreadableFolderDoesNotThrow() {
  const dir = folderFromPaths({ 'a.md': 'x' }, { failValues: true });
  let result = null;
  try {
    result = await collectFolderFiles(dir);
  } catch (error) {
    return `the walk threw instead of reporting a skip: ${error.message}`;
  }
  if (result.files.length !== 0) return 'an unreadable folder produced files';
  if (!result.skips.some((s) => s.reason === FOLDER_SKIP.UNREADABLE)) return 'no unreadable skip recorded';
  return true;
}

async function testAMissingHandleIsNotAnError() {
  const result = await collectFolderFiles(null);
  if (result.files.length !== 0) return 'a null handle produced files';
  return true;
}

// ── 3. reading ───────────────────────────────────────────────────────────────

async function testReadingProducesTheDocumentShape() {
  const dir = folderFromPaths({ 'books/chemistry.md': '# Chemistry\n\n## Price\n\n350 EGP' });
  const { files } = await collectFolderFiles(dir);

  const read = await readFolderEntry(files[0]);
  if (!read.ok) return `read failed: ${read.reason}`;
  if (read.document.filename !== 'books/chemistry.md') return `filename was ${read.document.filename}`;
  if (!read.document.content.includes('350')) return 'the content did not survive the read';
  return true;
}

/**
 * A file that cannot be read becomes a skip, not a sync failure.
 *
 * One locked file must not cost the other forty-nine. This is the reason reading returns a
 * result rather than throwing.
 */
async function testAnUnreadableFileIsSkippedNotFatal() {
  const dir = folderFromPaths({ 'good.md': 'fine' });
  const { files } = await collectFolderFiles(dir);

  const bad = await readFolderEntry({ path: 'locked.md', handle: { getFile: async () => { throw new Error('EACCES'); } } });
  if (bad.ok) return 'an unreadable file was accepted';
  if (bad.reason !== FOLDER_SKIP.UNREADABLE) return `reason was ${bad.reason}`;

  const good = await readFolderEntry(files[0]);
  if (!good.ok) return 'the readable file alongside it was not read';
  return true;
}

async function testAnOversizedFileIsSkipped() {
  const huge = 'x'.repeat(FOLDER_SYNC_DEFAULTS.maxFileChars + 1);
  const read = await readFolderEntry({ path: 'huge.md', handle: { getFile: async () => ({ text: async () => huge }) } });
  if (read.ok) return 'a file over the document limit was accepted';
  if (read.reason !== FOLDER_SKIP.TOO_LARGE) return `reason was ${read.reason}`;
  return true;
}

/** A blank note must not become a document the store will refuse. */
async function testAnEmptyFileIsSkipped() {
  const read = await readFolderEntry({ path: 'blank.md', handle: { getFile: async () => ({ text: async () => '   \n ' }) } });
  if (read.ok) return 'a whitespace-only file became a document';
  return true;
}

// ── 4. the plan ──────────────────────────────────────────────────────────────

async function testANewFileBecomesAnAdd() {
  const plan = planFolderSync([], [{ filename: 'books/chem.md', content: 'price 350' }]);
  if (plan.add.length !== 1) return `expected one add, got ${plan.add.length}`;
  if (plan.add[0].filename !== 'books/chem.md') return `filename was ${plan.add[0].filename}`;
  return true;
}

async function testChangedContentBecomesAnUpdate() {
  const current = stored('books/chem.md', 'price 350');
  const plan = planFolderSync([current], [{ filename: 'books/chem.md', content: 'price 400' }]);

  if (plan.update.length !== 1) return `expected one update, got ${plan.update.length}`;
  if (plan.update[0].id !== current.id) return 'the update did not carry the stored document id';
  if (plan.remove.length) return 'an updated document was also scheduled for removal';
  return true;
}

/**
 * IDENTICAL content is not an update.
 *
 * Two reasons, and both are silent failures without this. A no-op update bumps `version`,
 * which §18 precedence reads — so a sync that rewrites unchanged files can make an old
 * document start winning conflicts. And it makes "nothing changed" unstatable, which is the
 * one thing the sync summary exists to tell the user.
 */
async function testIdenticalContentIsUnchangedNotAnUpdate() {
  const current = stored('a.md', 'price 350');
  const plan = planFolderSync([current], [{ filename: 'a.md', content: 'price 350' }]);

  if (plan.update.length !== 0) return 'identical content produced an update';
  if (plan.unchanged.length !== 1) return `expected one unchanged, got ${plan.unchanged.length}`;
  if (planHasChanges(plan)) return 'an identical file reported as a change';
  return true;
}

/**
 * THE FLAG RULE. `enabled` and `priority` survive a sync.
 *
 * §18 precedence reads both, so a sync that reset them would silently re-promote a document the
 * user retired: the old price list comes back and starts winning conflicts, and the symptom is
 * "it answered with the old price again" with nothing in the log to explain it.
 */
async function testEnabledAndPrioritySurviveASync() {
  const current = stored('a.md', 'old', { enabled: false, priority: 7 });
  const plan = planFolderSync([current], [{ filename: 'a.md', content: 'new' }]);

  if (plan.update.length !== 1) return 'expected an update';
  if (plan.update[0].enabled !== false) return 'a disabled document was re-enabled by a sync';
  if (plan.update[0].priority !== 7) return `priority became ${plan.update[0].priority}`;
  return true;
}

async function testAFileDeletedFromTheFolderIsRemoved() {
  const current = stored('gone.md', 'x');
  const plan = planFolderSync([current], []);

  if (plan.remove.length !== 1) return `expected one removal, got ${plan.remove.length}`;
  if (plan.remove[0].id !== current.id) return 'the removal named the wrong document';
  return true;
}

/**
 * Filenames match the way the STORE matches them — case-insensitively.
 *
 * A folder written on macOS and edited on Windows (or vice versa) will hand back
 * `Chemistry.md` for a stored `chemistry.md`. Matching case-sensitively here would plan an ADD
 * beside the UPDATE, and the base would end up holding two documents for one file — which
 * `isSameDocumentFilename()` then treats as a conflict waiting to happen.
 */
async function testFilenameMatchingIsCaseInsensitive() {
  const current = stored('Books/Chem.md', 'old');
  const plan = planFolderSync([current], [{ filename: 'books/chem.md', content: 'new' }]);

  if (plan.add.length !== 0) return `a case-differing filename produced an add (${plan.add.length})`;
  if (plan.update.length !== 1) return 'a case-differing filename did not produce an update';
  if (plan.remove.length !== 0) return 'a case-differing filename also removed the stored document';
  return true;
}

async function testAnUnusablePathIsDropped() {
  const plan = planFolderSync([], [
    { filename: '../escape.md', content: 'x' },
    { filename: '', content: 'x' },
    { filename: 'fine.md', content: 'y' },
  ]);
  if (plan.add.length !== 1 || plan.add[0].filename !== 'fine.md') {
    return `expected only fine.md to be planned, got ${plan.add.map((a) => a.filename).join(', ')}`;
  }
  return true;
}

async function testAnEmptyPlanChangesNothing() {
  if (planHasChanges(planFolderSync([], [])) !== false) return 'two empty lists reported a change';
  if (planHasChanges(null) !== false) return 'a null plan reported a change';
  return true;
}

async function testTheSummaryCountsEveryOutcome() {
  const a = stored('a.md', '1');
  const b = stored('b.md', '2');
  const c = stored('c.md', '3');

  const plan = planFolderSync([a, b, c], [
    { filename: 'a.md', content: '1' },
    { filename: 'b.md', content: 'changed' },
    { filename: 'new.md', content: '4' },
  ]);

  const summary = summarizePlan(plan, [{ path: 'x.pdf', reason: FOLDER_SKIP.NOT_MARKDOWN }]);
  if (summary.added !== 1) return `added was ${summary.added}`;
  if (summary.updated !== 1) return `updated was ${summary.updated}`;
  if (summary.unchanged !== 1) return `unchanged was ${summary.unchanged}`;
  if (summary.removed !== 1) return `removed was ${summary.removed}`;
  if (summary.skipped !== 1) return `skipped was ${summary.skipped}`;
  return true;
}

/** Every skip reason must be explainable, because a skip the user cannot see is a silent gap. */
async function testEverySkipReasonIsDescribed() {
  for (const reason of Object.values(FOLDER_SKIP)) {
    if (!describeSkip(reason) || describeSkip(reason) === 'skipped') {
      return `no description for ${reason}`;
    }
  }
  return true;
}

// ── run ──────────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('--- Classifying entries ---');
  await runTest('Only Markdown files are imported', testOnlyMarkdownFilesAreImported);
  await runTest('Hidden entries are skipped', testHiddenEntriesAreSkipped);

  console.log('\n--- Walking the folder ---');
  await runTest('Subfolders become part of the filename', testSubfoldersBecomePartOfTheFilename);
  await runTest('The walk order is deterministic', testTheWalkOrderIsDeterministic);
  await runTest('The walk is depth limited', testTheWalkIsDepthLimited);
  await runTest('The walk stops at the document limit', testTheWalkStopsAtTheDocumentLimit);
  await runTest('An unreadable folder does not throw', testAnUnreadableFolderDoesNotThrow);
  await runTest('A missing handle is not an error', testAMissingHandleIsNotAnError);

  console.log('\n--- Reading files ---');
  await runTest('Reading produces the document shape', testReadingProducesTheDocumentShape);
  await runTest('An unreadable file is skipped, not fatal', testAnUnreadableFileIsSkippedNotFatal);
  await runTest('An oversized file is skipped', testAnOversizedFileIsSkipped);
  await runTest('An empty file is skipped', testAnEmptyFileIsSkipped);

  console.log('\n--- Planning the sync ---');
  await runTest('A new file becomes an add', testANewFileBecomesAnAdd);
  await runTest('Changed content becomes an update', testChangedContentBecomesAnUpdate);
  await runTest('Identical content is unchanged, not an update', testIdenticalContentIsUnchangedNotAnUpdate);
  await runTest('Enabled and priority survive a sync', testEnabledAndPrioritySurviveASync);
  await runTest('A file deleted from the folder is removed', testAFileDeletedFromTheFolderIsRemoved);
  await runTest('Filename matching is case-insensitive', testFilenameMatchingIsCaseInsensitive);
  await runTest('An unusable path is dropped', testAnUnusablePathIsDropped);
  await runTest('An empty plan changes nothing', testAnEmptyPlanChangesNothing);
  await runTest('The summary counts every outcome', testTheSummaryCountsEveryOutcome);
  await runTest('Every skip reason is described', testEverySkipReasonIsDescribed);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;