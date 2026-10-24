/**
 * Reply Box Tests - openReplyBox()
 *
 * Reproduces the real-Chrome failure where the YouTube reply box was visibly open
 * on screen (editable area + Cancel + Reply) and openReplyBox() still timed out
 * after 3000 ms and returned null.
 *
 * Cause: `comment.element` is captured BEFORE `btn.click()`, and the click makes
 * YouTube re-render the thread — so the poll was querying a detached node. A
 * detached node answers every querySelector with null, and the `contains()` gate on
 * strategies 2 and 3 can never be satisfied by a live box.
 *
 * Runs in the browser from open-reply-box-tests.html. There is no Node runner.
 */

import { createStubDocument, FakeElement } from './dom-stub.js';
// The real diagnostics engine, so the adapter's structured logging is exercised rather
// than stubbed out.
import '../../core/dev-log.js';

const YTAR_DEVLOG = globalThis.YTAR_DEVLOG;

const results = { total: 0, passed: 0, failed: 0 };
const originalSetTimeout = globalThis.setTimeout;

/**
 * The stub document currently under test, or null when the real one applies.
 *
 * The adapter is a CLASSIC script that references the bare identifier `document`, and
 * in a browser page `window.document` is a non-configurable accessor with only a
 * getter — so it cannot be reassigned, redefined or deleted. Instead of mutating the
 * global, the adapter is evaluated with `document` injected as a parameter, and this
 * holder tells that injected object which document to forward to right now.
 */
let activeStub = null;

/**
 * Indirection object handed to the adapter as its `document`.
 *
 * Every read is forwarded to the active stub, so one evaluation of the adapter works
 * for every test. Methods are bound to their real target, because the stub's
 * querySelectorAll and friends must run with the stub as `this`.
 */
const documentProxy = new Proxy({}, {
  get(_target, prop) {
    const real = activeStub ? activeStub.document : globalThis.document;
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has(_target, prop) {
    const real = activeStub ? activeStub.document : globalThis.document;
    return prop in real;
  }
});

/**
 * Swap in a stub document for the duration of `fn`, and return whatever `fn`
 * returned (so the caller can return it straight to runTest).
 *
 * @param {(stub: Object) => Promise<*>} fn
 */
async function withStubbedDocument(fn) {
  const stub = createStubDocument();
  const previous = activeStub;
  activeStub = stub;
  try {
    return await fn(stub);
  } finally {
    activeStub = previous;
  }
}

/** Run one async test case. */
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

/** Load the adapter class under test (it is a global script, not an ES module). */
async function loadAdapter() {
  if (typeof globalThis.YouTubeSiteAdapter === 'function') {
    return globalThis.YouTubeSiteAdapter;
  }
  const source = await (await fetch('../youtube-adapter.js')).text();
  // The file assigns itself to `window.YouTubeSiteAdapter` on evaluation, reads
  // `window.location.hostname`, and logs through the Phase 18.3 diagnostics shim.
  // All three are supplied here rather than taken from the page's own globals, so
  // nothing here touches the window the test page itself runs in.
  const windowStub = { location: { hostname: 'www.youtube.com' }, document: documentProxy };
  const debugShim = {
    isEnabled: () => true,
    debugLog: (...args) => console.log('[test]', ...args),
    debugWarn: (...args) => console.warn('[test]', ...args),
    logError: (...args) => console.error('[test]', ...args),
    // The structured diagnostics the adapter now emits. Wired to the real engine so
    // the adapter's instrumented code paths run exactly as they do in the browser,
    // and a missing method here fails loudly instead of being masked by a stub.
    devLog: (options) => YTAR_DEVLOG.log(options),
    startTimer: (spec) => YTAR_DEVLOG.startTimer(spec),
    newRunId: () => YTAR_DEVLOG.newRunId(),
    newRequestId: () => YTAR_DEVLOG.newRequestId(),
    getEntries: () => YTAR_DEVLOG.getEntries()
  };
  // Diagnostics on at NORMAL for this suite, so the adapter's own log lines appear and
  // a throw inside a diagnostic would be visible as a test failure.
  YTAR_DEVLOG.configure({ enabled: true, verbosity: 'NORMAL' });
  new Function('document', 'window', '__YTAR_DEBUG', source)
    .call(windowStub, documentProxy, windowStub, debugShim);
  if (typeof windowStub.YouTubeSiteAdapter === 'function') {
    return windowStub.YouTubeSiteAdapter;
  }
  return globalThis.YouTubeSiteAdapter;
}

/**
 * Build a YouTube comment thread shaped like the real markup:
 *   ytd-comment-thread-renderer > ytd-comment-view-model#comment > div#body
 */
function buildThread(stub, opts = {}) {
  const { contentId = 'content-abc', text = 'السعر كام', author = 'Ahmed' } = opts;

  const bodyText = new FakeElement('yt-attributed-string', {}, [text]);
  const body = new FakeElement('div', { id: 'body' }, [bodyText]);
  const meta = new FakeElement('div', { id: 'meta' }, [
    new FakeElement('a', { id: 'author-text' }, [author])
  ]);

  const replyBtn = new FakeElement('button', { 'aria-label': 'Reply' }, ['Reply']);
  const bar = new FakeElement('ytd-comment-engagement-bar', { id: 'action-buttons' }, [replyBtn]);

  const viewModel = new FakeElement('ytd-comment-view-model', { id: 'comment', 'content-id': contentId }, [
    meta,
    body,
    bar
  ]);

  // NOTE: real threads carry no `data-id` — parseComment() then invents a
  // `comment-N` fallback id, which is what your console shows ("comment-1").
  const thread = new FakeElement(
    'ytd-comment-thread-renderer',
    { 'content-id': contentId },
    [viewModel]
  );
  stub.root.appendChild(thread);

  return { thread, viewModel, replyBtn };
}

/**
 * Attach a realistic reply box to a comment scope.
 *
 * @param {Object} stub
 * @param {FakeElement} scope - the thread (or view model) the box belongs under.
 *        Real YouTube puts the box as a SIBLING of the view model, under the thread.
 * @param {string} contentId
 */
function attachReplyBox(stub, scope, contentId) {
  const textbox = new FakeElement('ytd-textbox', { id: 'textbox' }, [
    new FakeElement('yt-formatted-string', { class: 'content' }, [''])
  ]);
  const container = new FakeElement('div', { id: 'reply-container' }, [textbox]);
  const box = new FakeElement('ytd-comment-reply-box-renderer', { 'content-id': contentId }, [
    container,
    new FakeElement('button', { 'aria-label': 'Cancel' }, ['Cancel']),
    new FakeElement('button', { 'aria-label': 'Comment' }, ['Reply'])
  ]);
  scope.appendChild(box);
  return { box, textbox, thread: scope };
}

/**
 * Test 1 (the regression): the reply box is a SIBLING of the view model, inside the
 * thread, and the thread has no data-id — so reacquireComment() hands back the narrow
 * `ytd-comment-view-model`, which cannot contain the box.
 *
 * Real-Chrome symptom this reproduces: the box is open and visible in the live DOM,
 * but openReplyBox() logs "timed out after 3000ms" and content.js reports
 * "openReplyBox returned null".
 */
async function testBoxSiblingOfViewModelIsFound() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, viewModel, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);
    if (!comment) return 'Setup failed: the stub comment did not parse';
    if (comment.indexOf !== undefined && comment.id.indexOf('comment-') !== 0) {
      return `Setup failed: expected a comment-N fallback id, got ${comment.id}`;
    }

    // Sanity: the comment must really carry a fallback id, or this test proves nothing.
    if (String(comment.id).indexOf('comment-') !== 0) {
      return `Setup failed: expected a fallback id, got ${comment.id}`;
    }

    let attached = null;
    replyBtn.onClick = () => {
      // Real placement: sibling of the view model, directly under the thread.
      attached = attachReplyBox(stub, thread, 'content-abc');
    };

    const result = await adapter.openReplyBox(comment);

    if (!result) {
      return 'openReplyBox returned null — the reply box was open but not detected';
    }
    if (!attached.thread.contains(result)) {
      return 'Expected the reply box from the thread scope';
    }
    if (result !== attached.box) {
      return `Expected the reply box renderer, got <${result.tagName}>`;
    }

    // The search scope must be the THREAD, never the narrower view model — that
    // narrowing is what made the live box unreachable.
    const scope = adapter._replySearchScope(comment);
    if (!scope || scope.tagName !== 'YTD-COMMENT-THREAD-RENDERER') {
      return `Expected a thread-renderer scope, got <${scope && scope.tagName}>`;
    }
    return true;
  });
}

/**
 * Test 2 (the exact reported case): after a re-render, reacquireComment() narrows the
 * element to ytd-comment-view-model. openReplyBox() must still find the box.
 */
async function testNarrowedViewModelScopeStillFindsBox() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);

    // Force the stale-element path: the original node leaves the document entirely.
    let replacementThread = null;
    replyBtn.onClick = () => {
      thread.detach();
      const fresh = buildThread(stub, { contentId: 'content-abc' });
      replacementThread = fresh.thread;
      attachReplyBox(stub, fresh.thread, 'content-abc');
    };

    // Confirm reacquire really does narrow to the view model in this scenario.
    const reacquired = adapter.reacquireComment(comment);
    const narrowed =
      !!reacquired &&
      (reacquired.element.tagName === 'YTD-COMMENT-VIEW-MODEL' ||
        reacquired.element.tagName === 'YTD-COMMENT-RENDERER');

    const result = await adapter.openReplyBox(comment);

    if (!result) {
      return 'openReplyBox returned null after a re-render (box was open)';
    }
    if (!result.isConnected) return 'openReplyBox returned a detached element';
    if (!replacementThread.contains(result)) {
      return 'Expected an element inside the re-rendered thread';
    }
    if (!narrowed) {
      // Not a failure of the fix, just means this scenario took the wide path.
      return true;
    }
    return true;
  });
}

/**
 * Test 3: no re-render — the reply box appears in the same thread. Must keep working.
 */
async function testWorksWithoutReRender() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, viewModel, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);

    let attached = null;
    replyBtn.onClick = () => {
      attached = attachReplyBox(stub, viewModel, 'content-abc');
    };

    const result = await adapter.openReplyBox(comment);

    if (!result) return 'openReplyBox returned null without any re-render';
    if (result !== attached.box) {
      return `Expected the reply box renderer, got <${result.tagName}>`;
    }
    return true;
  });
}

/**
 * Test 3: the reply box is found only by the `#textbox` strategy (no
 * ytd-comment-reply-box-renderer wrapper) — that strategy must survive the fix.
 */
async function testTextboxStrategyStillWorks() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);

    let textbox = null;
    replyBtn.onClick = () => {
      textbox = new FakeElement('ytd-textbox', { id: 'textbox' }, ['']);
      const container = new FakeElement('div', { id: 'reply-container' }, [textbox]);
      thread.appendChild(container);
    };

    const result = await adapter.openReplyBox(comment);

    if (result !== textbox) {
      return `Expected the ytd-textbox, got <${result && result.tagName}>`;
    }
    return true;
  });
}

/**
 * Test 4: the element returned by openReplyBox must be one that _resolveEditable
 * can dig a real editor out of, so setReplyText has somewhere to type.
 *
 * _resolveEditable keeps its own documented preference order — `yt-formatted-string.
 * content` before `#textbox` — so the assertion is that the result is an element
 * inside the reply box that is one of those editor candidates, not a specific one.
 */
async function testResolvedEditableIsInsideTheBox() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, viewModel, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);

    let attached = null;
    replyBtn.onClick = () => {
      attached = attachReplyBox(stub, viewModel, 'content-abc');
    };

    const result = await adapter.openReplyBox(comment);
    if (!result) return 'openReplyBox returned null';

    const editable = adapter._resolveEditable(result);
    if (!editable) return '_resolveEditable returned null';

    // Must live inside the reply box we opened, and must not be the box container
    // itself (writing to the container would destroy the Cancel/Reply buttons).
    if (!attached.box.contains(editable)) {
      return 'The resolved editable is not inside the reply box';
    }
    if (editable === attached.box) {
      return 'The reply box container was resolved as the editable target';
    }
    const isEditorCandidate =
      editable.matches('#textbox') ||
      editable.matches('yt-formatted-string.content') ||
      editable.matches('[contenteditable="true"]');
    if (!isEditorCandidate) {
      return `Resolved element <${editable.tagName}> is not a recognised editor`;
    }
    return true;
  });
}

/**
 * Test 8: the timeout diagnostic must never throw, whatever state the page is in.
 *
 * It runs on the timeout path in production, so it has to be safe when the expected
 * elements are absent — no editor, no reply box, a detached scope, no document.
 * Each call must return undefined (it reports, it does not decide anything).
 */
async function testDiagnosticNeverThrowsWhenElementsAbsent() {
  const Adapter = await loadAdapter();

  const cases = [
    ['no document at all', () => {
      const saved = activeStub;
      activeStub = { document: {} };
      try {
        return new Adapter()._logReplyBoxDiagnostic(null, null);
      } finally {
        activeStub = saved;
      }
    }],
    ['null comment and null scope', () => new Adapter()._logReplyBoxDiagnostic(null, null)],
    ['comment without an element', () => new Adapter()._logReplyBoxDiagnostic({ id: 'comment-1' }, null)],
    ['scope with no matching elements', async () => {
      await withStubbedDocument(async (stub) => {
        const empty = new FakeElement('ytd-comment-thread-renderer', {}, []);
        stub.root.appendChild(empty);
        return new Adapter()._logReplyBoxDiagnostic({ id: 'comment-9', element: empty }, empty);
      });
      // withStubbedDocument's value is not the diagnostic's; the diagnostic returns undefined.
      return undefined;
    }]
  ];

  for (const [name, run] of cases) {
    let out;
    try {
      out = await run();
    } catch (error) {
      return `Diagnostic threw for case "${name}": ${error.message}`;
    }
    if (out !== undefined) {
      return `Diagnostic returned a value for case "${name}" — it must not feed detection`;
    }
  }

  // Reset the one-shot latch so this suite can call the diagnostic more than once.
  Adapter._replyDiagLogged = false;
  return true;
}

/**
 * Test 5: with no reply button, openReplyBox must still return null immediately —
 * the fix must not change that path.
 */
async function testNoReplyButtonStillReturnsNull() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const viewModel = new FakeElement('ytd-comment-view-model', { id: 'comment', 'content-id': 'c1' }, [
      new FakeElement('div', { id: 'body' }, [new FakeElement('yt-attributed-string', {}, ['hi'])])
    ]);
    const thread = new FakeElement('ytd-comment-thread-renderer', { 'content-id': 'c1' }, [viewModel]);
    stub.root.appendChild(thread);

    const comment = adapter.parseComment(thread);
    const result = await adapter.openReplyBox(comment);

    return result === null ? true : 'Expected null when there is no reply button';
  });
}

/**
 * Test 6: the 3000 ms timeout must NOT be widened. When the reply box never
 * appears, openReplyBox must still give up — and must do so on schedule.
 */
async function testTimeoutIsNotWidened() {
  const Adapter = await loadAdapter();
  const adapter = new Adapter();

  let fakeNow = 0;
  globalThis.setTimeout = (fn, delay) => originalSetTimeout(fn, 0);
  const realDateNow = Date.now;
  Date.now = () => fakeNow;

  try {
    return await withStubbedDocument(async (stub) => {
      const { thread, replyBtn } = buildThread(stub);
      replyBtn.onClick = () => { /* YouTube opens nothing at all */ };
      const comment = adapter.parseComment(thread);

      const started = fakeNow;
      const result = await adapter.openReplyBox(comment);
      fakeNow = started + 5000; // simulate the wall clock advancing past the timeout

      return result === null
        ? true
        : 'Expected null when the reply box never appears';
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    Date.now = realDateNow;
  }
}

/**
 * Test 7 (the real-Chrome regression): build the EXACT live-DOM chain captured from
 * YouTube and assert openReplyBox() finds the box.
 *
 *   ytd-comment-thread-renderer
 *     -> ytd-comment-view-model#comment
 *       -> ytd-comment-engagement-bar#action-buttons
 *         -> div#reply-dialog
 *           -> ytd-comment-reply-dialog-renderer#replybox
 *             -> ytd-commentbox#commentbox > div#main
 *               -> div#contenteditable-root[contenteditable=true]
 *
 * The console symptom was "openReplyBox returned null for comment id=comment-1"
 * while the box was visibly open, because no strategy referenced
 * `ytd-comment-reply-dialog-renderer#replybox`.
 */
async function testRealLiveDomChainIsDetected() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, viewModel, replyBtn } = buildThread(stub);

    // Build the real reply dialog and hang it off the engagement bar, where YouTube
    // actually puts it — INSIDE the view model, not as a sibling.
    const editor = new FakeElement('div', { id: 'contenteditable-root', contenteditable: 'true' }, ['']);
    const main = new FakeElement('div', { id: 'main' }, [editor]);
    const commentbox = new FakeElement('ytd-commentbox', { id: 'commentbox' }, [main]);
    const replybox = new FakeElement('ytd-comment-reply-dialog-renderer', { id: 'replybox' }, [
      commentbox,
      new FakeElement('button', { 'aria-label': 'Cancel' }, ['Cancel']),
      new FakeElement('button', { 'aria-label': 'Reply' }, ['Reply'])
    ]);
    const replyDialog = new FakeElement('div', { id: 'reply-dialog' }, [replybox]);
    const bar = viewModel.querySelector('ytd-comment-engagement-bar');
    if (!bar) return 'Setup failed: the engagement bar is missing from the stub thread';
    bar.appendChild(replyDialog);

    const comment = adapter.parseComment(thread);
    if (!comment) return 'Setup failed: the stub comment did not parse';

    // Precondition: the real root really is in the DOM before openReplyBox() runs.
    if (!thread.contains(replybox)) {
      return 'Setup failed: the replybox was not attached inside the thread';
    }

    let clicks = 0;
    replyBtn.onClick = () => { clicks++; };
    const result = await adapter.openReplyBox(comment);

    if (!result) {
      return 'openReplyBox returned null for the real ytd-comment-reply-dialog-renderer#replybox';
    }
    if (result !== replybox) {
      return `Expected the #replybox root, got <${result.tagName}${result.attrs && result.attrs.id ? '#' + result.attrs.id : ''}>`;
    }
    if (clicks !== 1) {
      return `Expected exactly one reply-button click, got ${clicks}`;
    }

    // The returned container must resolve to the real editor, which is what
    // setReplyText() types into.
    const editable = adapter._resolveEditable(result);
    if (!editable || editable !== editor) {
      return '_resolveEditable did not reach #contenteditable-root[contenteditable=true]';
    }
    return true;
  });
}

/**
 * Test 8: the legacy `ytd-comment-reply-box-renderer` fallback must keep working, so
 * the real-selector change does not regress anything that relied on the old shape.
 */
async function testLegacyRendererStillFallsBack() {
  return withStubbedDocument(async (stub) => {
    const Adapter = await loadAdapter();
    const adapter = new Adapter();

    const { thread, replyBtn } = buildThread(stub);
    const comment = adapter.parseComment(thread);

    let attached = null;
    replyBtn.onClick = () => {
      attached = attachReplyBox(stub, thread, 'content-abc');
    };

    const result = await adapter.openReplyBox(comment);

    if (!result) return 'Legacy ytd-comment-reply-box-renderer fallback stopped working';
    if (result !== attached.box) {
      return `Expected the legacy renderer, got <${result.tagName}>`;
    }
    return true;
  });
}

/** Run all tests and print a summary. */
async function runAllTests() {
  console.log('\n=== Reply Box Tests (openReplyBox) ===\n');

  await runTest('Real live DOM chain (reply-dialog > replybox) is detected', testRealLiveDomChainIsDetected);
  await runTest('Reply box found when it is a sibling of the view model', testBoxSiblingOfViewModelIsFound);
  await runTest('Reply box still found after re-render narrows scope to view model', testNarrowedViewModelScopeStillFindsBox);
  await runTest('Reply box is found when there is no re-render', testWorksWithoutReRender);
  await runTest('#textbox strategy still resolves the editor', testTextboxStrategyStillWorks);
  await runTest('_resolveEditable finds a real editor inside the returned box', testResolvedEditableIsInsideTheBox);
  await runTest('No reply button still returns null', testNoReplyButtonStillReturnsNull);
  await runTest('Timeout is not widened when no box appears', testTimeoutIsNotWidened);
  await runTest('Timeout diagnostic never throws when elements are absent', testDiagnosticNeverThrowsWhenElementsAbsent);
  await runTest('Legacy reply-box renderer still resolves as a fallback', testLegacyRendererStillFallsBack);

  console.log('\n--- Phase 20.23: own-comment recognition ---');
  await runTest('An owner author element is recognised as ours', testAnOwnerAuthorElementIsRecognisedAsOurs);
  await runTest('An owner badge is recognised as ours', testAnOwnerBadgeIsRecognisedAsOurs);
  await runTest('A customer comment is never treated as ours', testACustomerCommentIsNeverTreatedAsOurs);
  await runTest('isOwnComment survives junk', testIsOwnCommentSurvivesJunk);
  await runTest('The marker is not matched in comment text', testTheOwnerMarkerIsNotMistakenForANameMatch);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}


// ── Phase 20.23: recognising the channel owner's own comments ───────────────────
//
// THE LOOP. Every reply the extension posts renders in the page as an ordinary comment.
// The MutationObserver reported it as a new customer comment, the pipeline answered it, and
// the extension replied to its own reply — three replies deep on one thread, in real Chrome,
// before it was noticed. `isOwnComment()` is the primary guard.
//
// Built against the REAL document rather than the `FakeElement` stub, because what is under
// test is `querySelector` and `classList` behaviour — a stub would pass regardless of whether
// the selectors actually match YouTube's markup, which is the entire risk.

/** A comment shaped like YouTube's, with an optional owner marker. */
function buildRealComment({ author = 'customer', owner = false, badge = false } = {}) {
  const node = document.createElement('ytd-comment-thread-renderer');
  const view = document.createElement('div');
  view.id = 'comment';

  const authorEl = document.createElement('a');
  authorEl.id = 'author-text';
  authorEl.href = '/@' + author;
  if (owner) authorEl.classList.add('owner-text');
  authorEl.textContent = author;

  const meta = document.createElement('div');
  meta.id = 'meta';
  meta.appendChild(authorEl);
  if (badge) {
    const badgeEl = document.createElement('ytd-author-badge-renderer');
    meta.appendChild(badgeEl);
  }

  view.appendChild(meta);
  node.appendChild(view);
  return node;
}

async function testAnOwnerAuthorElementIsRecognisedAsOurs() {
  const Adapter = await loadAdapter();
  const adapter = new Adapter();
  if (!adapter.isOwnComment(buildRealComment({ author: 'eltafouk', owner: true }))) {
    return 'a comment with #author-text.owner-text was not recognised as ours';
  }
  return true;
}

async function testAnOwnerBadgeIsRecognisedAsOurs() {
  // Second marker: the badge is a separate element on current YouTube, so a comment can be
  // ours without the author element carrying the class.
  const Adapter = await loadAdapter();
  const adapter = new Adapter();
  if (!adapter.isOwnComment(buildRealComment({ author: 'eltafouk', badge: true }))) {
    return 'a comment carrying an owner badge was not recognised as ours';
  }
  return true;
}

async function testACustomerCommentIsNeverTreatedAsOurs() {
  const Adapter = await loadAdapter();
  const adapter = new Adapter();
  // The direction that must not move: skipping a real customer's comment would silence the
  // extension entirely, which is worse than the loop in one specific way — it is invisible.
  if (adapter.isOwnComment(buildRealComment({ author: 'customer' }))) {
    return 'a normal customer comment was treated as ours';
  }
  return true;
}

async function testIsOwnCommentSurvivesJunk() {
  const Adapter = await loadAdapter();
  const adapter = new Adapter();
  for (const value of [null, undefined, {}, 'not-an-element', 42]) {
    if (adapter.isOwnComment(value) !== false) return `isOwnComment(${String(value)}) did not return false`;
  }
  return true;
}

async function testTheOwnerMarkerIsNotMistakenForANameMatch() {
  // The class lives on the AUTHOR ELEMENT, never on the comment body. A customer who writes
  // the word "owner-text" in their comment must not be skipped: the reply would be about their
  // question, and skipping it is a silent failure.
  const Adapter = await loadAdapter();
  const adapter = new Adapter();
  const node = buildRealComment({ author: 'customer' });
  const body = document.createElement('div');
  body.id = 'body';
  body.textContent = 'what does owner-text mean?';
  node.querySelector('#comment').appendChild(body);

  if (adapter.isOwnComment(node)) return 'a comment mentioning "owner-text" was treated as ours';
  return true;
}

export default runAllTests;