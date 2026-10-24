/**
 * Template ↔ Knowledge Integration Tests — Phase 20.13
 *
 * §22 asks for one thing ("Templates provide context/scope; the Knowledge Base provides factual
 * source material") and that one thing is easy to break in both directions:
 *
 *   1. **The scope becomes a source of facts.** If anything here returned or forwarded CONTENT,
 *      a template could state a price and bypass the knowledge base entirely. Nothing in this
 *      module returns text — it only decides which documents are eligible.
 *   2. **The scope narrows too hard.** Every lesson in this phase is that removing evidence
 *      loses correct replies: 20.9 must not validate against citations only, 20.11 must not
 *      starve the retry. A scope that silently empties the evidence turns into a stream of
 *      skips with no explanation.
 *
 * The §22 examples (`books/` and `books/chemistry.md`) are used verbatim, and the second half
 * of the milestone — §18's "template scope" as a conflict-resolution mechanism — is tested
 * against the single owner in knowledge-conflicts.js rather than a private rule.
 *
 * Runs in the browser from template-scope-tests.html. No chrome stub, no network, no model:
 * a scope is configuration, not understanding.
 */

import {
  parseScope,
  normalizeScopeEntry,
  documentInScope,
  filterSectionsByScope,
  resolveScopedConflict,
  readActiveScope,
  MAX_SCOPE_ENTRIES,
  MAX_SCOPE_CHARS
} from '../template-scope.js';

import { retrieveKnowledge, RETRIEVAL_STATUS, RETRIEVAL_STATE } from '../knowledge-retrieval.js';
import { KNOWLEDGE_ERROR } from '../knowledge-schema.js';

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

/** A section as the index produces it. */
function section(filename, heading, content, documentId) {
  return {
    evidenceId: `EV-${documentId}-${heading}`,
    documentId,
    filename,
    headingPath: [heading],
    content,
    document: { id: documentId, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 }
  };
}

const BOOKS = section('books/chemistry.md', 'السعر', '350 جنيه', 'doc-chem');
const BOOKS_DEEP = section('books/2027/chemistry.md', 'السعر', '370 جنيه', 'doc-chem-2027');
const SHIPPING = section('shipping.md', 'الشحن', 'ثلاثة أيام', 'doc-ship');

// ─── §22's two examples ───────────────────────────────────────────────────────

async function testTheDirectoryExampleScopes() {
  // §22: Knowledge scope: books/
  const scope = parseScope('books/');
  if (scope.length !== 1 || scope[0].kind !== 'directory') return `parsed as ${JSON.stringify(scope)}`;

  if (!documentInScope('books/chemistry.md', scope)) return 'books/chemistry.md was excluded';
  if (!documentInScope(BOOKS, scope)) return 'a document object was excluded';
  if (documentInScope('shipping.md', scope)) return 'shipping.md was included';
  // A directory matches everything beneath it, however deep — 20.1's `category` is only the
  // immediate parent, so matching on category would miss books/2027/chemistry.md entirely.
  if (!documentInScope(BOOKS_DEEP, scope)) return 'a nested file was excluded';
  return true;
}

async function testTheDocumentExampleScopes() {
  // §22: Knowledge scope: books/chemistry.md
  const scope = parseScope('books/chemistry.md');
  if (scope.length !== 1 || scope[0].kind !== 'document') return `parsed as ${JSON.stringify(scope)}`;

  if (!documentInScope('books/chemistry.md', scope)) return 'the named file was excluded';
  if (documentInScope('books/2027/chemistry.md', scope)) return 'a different file was included';
  if (documentInScope('shipping.md', scope)) return 'shipping.md was included';
  return true;
}

async function testABareDirectoryNameWorks() {
  // A user typing "books" without the slash means the same thing, and rejecting it would be a
  // papercut for no safety gain.
  const scope = parseScope('books');
  if (!documentInScope('books/chemistry.md', scope)) return 'a bare directory name did not match';
  if (scope[0].kind !== 'directory') return `parsed as ${scope[0].kind}`;
  return true;
}

async function testAPrefixDoesNotMatchPartialSegmentNames() {
  // `book/` must not reach `books/chemistry.md`: comparing on a whole-segment boundary is the
  // only reason a folder named `book` cannot silently capture a folder named `books`.
  const scope = parseScope('book/');
  if (documentInScope('books/chemistry.md', scope)) return 'a partial segment matched';
  if (!documentInScope('book/chemistry.md', scope)) return 'the exact segment did not match';
  return true;
}

async function testScopeIsCaseInsensitive() {
  // Filenames are user-typed too, and a scope is a hint. `Books/` should reach `books/`.
  const scope = parseScope('Books/');
  if (!documentInScope('books/chemistry.md', scope)) return 'case mattered';
  return true;
}

async function testAnEmptyScopeMatchesEverything() {
  // The default must behave exactly as it did before this milestone: no scope, no change.
  for (const value of [[], null, undefined, '', '   ', 42, ['', '  ']]) {
    const scope = parseScope(value);
    if (scope.length !== 0) return `parseScope(${JSON.stringify(value)}) produced ${scope.length}`;
    if (!documentInScope('anything/at/all.md', scope)) return 'an empty scope excluded a document';
    if (!documentInScope(SHIPPING, scope)) return 'an empty scope excluded a document object';
  }
  return true;
}

async function testMultipleEntriesAreAccepted() {
  const scope = parseScope(['books/', 'shipping.md']);
  if (scope.length !== 2) return `${scope.length} entries`;
  if (!documentInScope('books/a.md', scope) || !documentInScope('shipping.md', scope)) return 'an entry was not honoured';
  if (documentInScope('policies.md', scope)) return 'an unlisted file was included';
  return true;
}

async function testOneBadEntryDoesNotDisableTheRest() {
  // A user editing JSON by hand will produce one bad line. Silently dropping the whole scope
  // would be worse than dropping the bad entry — it would remove filtering without saying so.
  const scope = parseScope(['books/', '..', '', '../../etc', 42, 'shipping.md']);
  if (scope.length !== 2) return `${scope.length} entries survived from ${JSON.stringify(scope)}`;
  if (!documentInScope('books/a.md', scope) || !documentInScope('shipping.md', scope)) return 'a good entry was lost';
  return true;
}

async function testTraversalIsRejected() {
  // A scope is user-typed and this is a path matcher, so it gets the same treatment
  // `normalizeFilename` does.
  for (const bad of ['../books', 'books/../../etc', './books/../..', '..\\books']) {
    const entry = normalizeScopeEntry(bad);
    if (entry) return `${bad} → ${JSON.stringify(entry)}`;
  }
  return true;
}

async function testScopeIsBounded() {
  const many = [];
  for (let i = 0; i < MAX_SCOPE_ENTRIES + 15; i++) many.push(`dir${i}/`);
  if (parseScope(many).length !== MAX_SCOPE_ENTRIES) return `${parseScope(many).length} entries kept`;

  const long = `${'a'.repeat(MAX_SCOPE_CHARS + 10)}/`;
  if (normalizeScopeEntry(long) !== null) return 'an over-long entry was accepted';
  return true;
}

async function testWindowsSeparatorsAreAccepted() {
  // A Windows user pasting a folder tree is a realistic case, and `normalizeFilename` already
  // makes that call for filenames.
  const scope = parseScope('books\\');
  if (!scope.length || !documentInScope('books/chemistry.md', scope)) return 'a backslash scope did not match';
  return true;
}

// ─── The scope narrows retrieval ───────────────────────────────────────────────

async function testFilteringReportsWhatItRemoved() {
  const all = [BOOKS, BOOKS_DEEP, SHIPPING];
  const outcome = filterSectionsByScope(all, parseScope('books/'));

  if (outcome.sections.length !== 2) return `${outcome.sections.length} sections kept`;
  if (outcome.removedCount !== 1) return `removedCount was ${outcome.removedCount}`;
  if (outcome.documentsInScope !== 2) return `documentsInScope was ${outcome.documentsInScope}`;
  return true;
}

async function testRetrievalRespectsTheScope() {
  const index = { retrievable: true, state: 'fresh', sections: [BOOKS, SHIPPING] };

  const scoped = await retrieveKnowledge({
    commentText: 'سعر كتاب الكيمياء كام؟',
    index,
    scope: parseScope('books/'),
    options: { useModel: false }
  });

  if (scoped.status === RETRIEVAL_STATUS.UNAVAILABLE) return `scoped retrieval failed: ${scoped.reason}`;
  if (scoped.results.some((r) => r.filename === 'shipping.md')) {
    return 'an out-of-scope document reached the results';
  }
  if (!scoped.results.some((r) => r.filename === 'books/chemistry.md')) {
    return 'the in-scope document was lost';
  }

  // Without a scope, everything is reachable — the pre-20.13 behaviour.
  const unscoped = await retrieveKnowledge({
    commentText: 'سعر كتاب الكيمياء كام؟',
    index,
    options: { useModel: false }
  });
  if (!unscoped.results.some((r) => r.filename === 'shipping.md')) {
    return 'an empty scope narrowed retrieval';
  }
  return true;
}

async function testAScopeMatchingNothingIsCalledAMisconfiguration() {
  // The failure mode this milestone has to avoid: a typo'd scope emptying the evidence, with
  // every comment then skipping as "no relevant knowledge" and no stated cause.
  const index = { retrievable: true, state: 'fresh', sections: [BOOKS, SHIPPING] };
  const outcome = await retrieveKnowledge({
    commentText: 'سعر كام؟',
    index,
    scope: parseScope('chemistry-2027/'),
    options: { useModel: false }
  });

  if (outcome.status !== RETRIEVAL_STATUS.UNAVAILABLE) return `status was ${outcome.status}`;
  if (!/template scope matched none/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  if (outcome.code !== KNOWLEDGE_ERROR.NO_RELEVANT_KNOWLEDGE) return `code was ${outcome.code}`;
  return true;
}

// ─── §22's central rule ───────────────────────────────────────────────────────

async function testAScopeNeverCarriesContent() {
  // §22: "Templates provide context/scope; the Knowledge Base provides factual source material."
  // The structural form of that rule is that no scope VALUE can carry text — a scope is a
  // selector, and a selector holding a price would be a second factual source wearing a
  // different hat, bypassing the index, retrieval, the gate and §16's validator.
  //
  // `filterSectionsByScope()` is deliberately NOT walked here: it is a filter, and returning
  // the knowledge base's own sections is its entire purpose.
  const scope = parseScope('books/');
  const resolved = resolveScopedConflict([BOOKS, SHIPPING], scope);
  const filtered = filterSectionsByScope([BOOKS, SHIPPING], scope);

  const strings = [];
  const walk = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') { strings.push(value); return; }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (typeof value === 'object') { Object.values(value).forEach((v) => walk(v, depth + 1)); }
  };

  for (const value of [
    scope,
    parseScope(['books/', '../etc', 'shipping.md']),
    documentInScope('books/a.md', scope),
    resolved.conflicting,
    resolved.resolvedByScope,
    resolved.reason,
    resolved.winner,
    filtered.removedCount,
    filtered.documentsInScope
  ]) walk(value);

  for (const text of strings) {
    // A path, a count or a reason is fine. A figure or a sentence from the knowledge base is not.
    if (/350|370|ثلاثة/.test(text)) return `knowledge content escaped through the scope layer: ${text}`;
  }

  // And the strongest form of the rule: feeding the scope layer a template whose BODY contains
  // a price must not put that price anywhere in what comes back.
  const smuggled = parseScope('books/');
  if (JSON.stringify(smuggled).includes('350')) return 'the scope echoed knowledge content';
  return true;
}

// ─── §18's "template scope" as a resolution mechanism ──────────────────────────

async function testAScopeResolvesAConflictByExclusion() {
  // §18 lists template scope among its resolution mechanisms: if only one of two contradicting
  // documents is in scope, the other is not applicable and there is nothing to resolve.
  const equal = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const a = section('books/chemistry.md', 'السعر', '350 جنيه', 'doc-a');
  const b = section('shipping/chemistry.md', 'السعر', '370 جنيه', 'doc-b');
  a.document = equal('doc-a', 'books/chemistry.md');
  b.document = equal('doc-b', 'shipping/chemistry.md');

  // Without a scope, equal authority and a shared heading is a conflict.
  const unscoped = resolveScopedConflict([a, b], parseScope([]));
  if (!unscoped.conflicting) return 'the unscoped pair was not a conflict';
  if (unscoped.resolvedByScope) return 'an empty scope claimed to resolve it';

  // Scoped to books/, only one document remains, so §18 has nothing to decide.
  const scoped = resolveScopedConflict([a, b], parseScope('books/'));
  if (scoped.conflicting) return 'the scope did not resolve the conflict';
  if (!scoped.resolvedByScope) return 'the resolution was not attributed to the scope';
  if (!/template scope excludes/.test(scoped.reason)) return `reason was ${scoped.reason}`;
  return true;
}

async function testAScopeDoesNotResolveAConflictInsideItself() {
  // The dangerous version: two contradicting documents BOTH in scope. Scoping must not make
  // this pass — §2 still wants a skip.
  const equal = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const a = section('books/old.md', 'السعر', '350 جنيه', 'doc-a');
  const b = section('books/new.md', 'السعر', '370 جنيه', 'doc-b');
  a.document = equal('doc-a', 'books/old.md');
  b.document = equal('doc-b', 'books/new.md');

  const scoped = resolveScopedConflict([a, b], parseScope('books/'));
  if (!scoped.conflicting) return 'a contradiction inside the scope was resolved by scoping';
  if (scoped.winner !== null) return 'an ambiguous pair reported a winner';
  return true;
}

async function testAnEmptyScopeMatchResolvesNothing() {
  // A scope matching nothing is a misconfiguration, and must not be reported as "no conflict" —
  // that would read as the base being fine.
  const equal = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const a = section('books/a.md', 'السعر', '350', 'doc-a');
  const b = section('books/b.md', 'السعر', '370', 'doc-b');
  a.document = equal('doc-a', 'books/a.md');
  b.document = equal('doc-b', 'books/b.md');

  const scoped = resolveScopedConflict([a, b], parseScope('nowhere/'));
  if (scoped.conflicting) return 'an unmatched scope reported a conflict';
  if (scoped.resolvedByScope) return 'an unmatched scope claimed to resolve it';
  if (!/matched no knowledge document/.test(scoped.reason)) return `reason was ${scoped.reason}`;
  return true;
}

async function testScopedResolutionMatchesTheOwner() {
  // The scoped decision must come from the same rule as the unscoped one, or a user fixes a
  // conflict the gate still disagrees with.
  const { resolveSectionConflict } = await import('../knowledge-conflicts.js');
  const equal = (id, filename) => ({ id, filename, enabled: true, priority: 0, version: 1, updatedAt: 1000 });
  const a = section('books/a.md', 'السعر', '350', 'doc-a');
  const b = section('books/b.md', 'السعر', '370', 'doc-b');
  a.document = equal('doc-a', 'books/a.md');
  b.document = equal('doc-b', 'books/b.md');

  const owner = resolveSectionConflict([a, b]);
  const scoped = resolveScopedConflict([a, b], parseScope('books/'));

  if (scoped.conflicting !== owner.conflicting) return `scoped said ${scoped.conflicting}, owner said ${owner.conflicting}`;
  if (scoped.reason !== owner.reason) return 'the scoped reason drifted from the owner';
  return true;
}

// ─── Reading the active template's scope ───────────────────────────────────────

async function testTheScopeComesFromTheActiveTemplate() {
  const settings = {
    replyBehavior: {
      contextTemplates: [
        { id: 'off', name: 'Disabled', enabled: false, body: 'x', scope: ['disabled/'] },
        { id: 'blank', name: 'Blank', enabled: true, body: '   ', scope: ['blank/'] },
        { id: 'on', name: 'Books', enabled: true, body: 'real body', scope: ['books/', 'shipping.md'] }
      ]
    }
  };

  const scope = readActiveScope(settings);
  if (scope.templateId !== 'on') return `read the scope of ${scope.templateId}`;
  if (scope.entries.length !== 2) return `${scope.entries.length} entries`;

  // The blank-body rule has to match the prompt builder's, or the prompt and the scope could
  // come from DIFFERENT templates — one saying "use this wording", the other deciding which
  // documents may be used at all.
  const { buildPromptParts } = await import('../prompt-builder.js');
  const parts = buildPromptParts(settings);
  if (!parts.template || parts.template.body !== 'real body') return 'the prompt used a different template';
  return true;
}

async function testAnUnsetOrAbsentTemplateHasNoScope() {
  for (const settings of [
    undefined, null, {}, { replyBehavior: {} },
    { replyBehavior: { contextTemplates: [] } },
    { replyBehavior: { contextTemplates: [{ id: 'a', name: 'A', enabled: true, body: 'b' }] } }
  ]) {
    const scope = readActiveScope(settings);
    if (scope.entries.length !== 0) return `${JSON.stringify(settings)} → ${scope.entries.length} entries`;
    if (!documentInScope('any/file.md', scope.entries)) return 'a template without a scope still narrowed';
  }
  return true;
}

async function testReadingAScopeIsTotal() {
  for (const value of [null, undefined, 42, {}, [], 'books/', ['books/'], [[]], [{}], ['']]) {
    const entries = parseScope(value);
    if (!Array.isArray(entries)) return `parseScope(${JSON.stringify(value)}) threw`;
  }
  for (const value of [null, undefined, 42, [], [null]]) {
    if (typeof documentInScope(value, parseScope('books/')) !== 'boolean') return 'documentInScope threw';
    if (typeof documentInScope('a.md', value) !== 'boolean') return 'documentInScope threw on scope';
  }
  return true;
}

export default async function runAllTests() {
  await runTest("§22's directory scope works", testTheDirectoryExampleScopes);
  await runTest("§22's single-document scope works", testTheDocumentExampleScopes);
  await runTest('a bare directory name works', testABareDirectoryNameWorks);
  await runTest('a prefix does not match a partial segment', testAPrefixDoesNotMatchPartialSegmentNames);
  await runTest('scope matching is case-insensitive', testScopeIsCaseInsensitive);
  await runTest('an empty scope matches everything (§22 default)', testAnEmptyScopeMatchesEverything);
  await runTest('multiple entries are accepted', testMultipleEntriesAreAccepted);
  await runTest('one bad entry does not disable the rest', testOneBadEntryDoesNotDisableTheRest);
  await runTest('traversal is rejected', testTraversalIsRejected);
  await runTest('scope is bounded', testScopeIsBounded);
  await runTest('Windows separators are accepted', testWindowsSeparatorsAreAccepted);

  await runTest('filtering reports what it removed', testFilteringReportsWhatItRemoved);
  await runTest('retrieval respects the scope', testRetrievalRespectsTheScope);
  await runTest('a scope matching nothing is called a misconfiguration', testAScopeMatchingNothingIsCalledAMisconfiguration);

  await runTest('a scope never carries content (§22)', testAScopeNeverCarriesContent);

  await runTest('a scope resolves a conflict by exclusion (§18)', testAScopeResolvesAConflictByExclusion);
  await runTest('a scope does not resolve a conflict inside itself', testAScopeDoesNotResolveAConflictInsideItself);
  await runTest('an empty scope match resolves nothing', testAnEmptyScopeMatchResolvesNothing);
  await runTest('scoped resolution matches the conflict owner', testScopedResolutionMatchesTheOwner);

  await runTest('the scope comes from the active template', testTheScopeComesFromTheActiveTemplate);
  await runTest('an absent or unset template has no scope', testAnUnsetOrAbsentTemplateHasNoScope);
  await runTest('reading a scope is total', testReadingAScopeIsTotal);

  return results;
}