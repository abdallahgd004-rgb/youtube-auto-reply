/**
 * Creator Heart Tests - isHeartedComment()
 *
 * A heart next to the avatar means the CHANNEL OWNER has already read that comment and
 * singled it out. The extension must not then answer it: the creator has spoken to that
 * viewer once already, on a thread they are actively watching.
 *
 * THE DOM UNDER TEST (this repo's own real-Chrome notes, youtube-adapter.js parseComment):
 *
 *   ytd-comment-thread-renderer
 *     └─ ytd-comment-view-model#comment        ← THIS comment
 *          ├─ #meta > #author-text
 *          ├─ #body > yt-attributed-string
 *          ├─ ytd-comment-engagement-bar#action-buttons
 *          │    └─ ytd-creator-heart-renderer  ← the heart, only when present
 *          └─ ytd-comment-replies-renderer
 *               └─ ytd-comment-thread-renderer
 *                    └─ ytd-comment-view-model  ← a REPLY, hearted or not
 *
 * WHY THESE RUN AGAINST THE REAL `document` AND NOT THE FakeElement STUB:
 * `dom-stub.js` has no `classList` and a hand-rolled selector engine, so a fixture built
 * with it would pass whether or not the selectors match YouTube's markup — which is the
 * entire risk being tested. Every fixture below is built with `document.createElement`.
 *
 * Runs in the browser from creator-heart-tests.html. There is no Node runner.
 */

import '../../core/dev-log.js';

const YTAR_DEVLOG = globalThis.YTAR_DEVLOG;

const results = { total: 0, passed: 0, failed: 0, failures: [] };

/**
 * Indirection object handed to the adapter as its `document`.
 *
 * The adapter is a CLASSIC script that references the bare identifier `document`, and in a
 * browser page `window.document` is a non-configurable accessor with only a getter — so it
 * cannot be reassigned. The adapter is evaluated with `document` injected as a parameter and
 * this proxy forwards to the page's real document. Every read is bound to the real target so
 * its methods run with the real document as `this`.
 */
const documentProxy = new Proxy({}, {
  get(_target, prop) {
    const real = globalThis.document;
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has(_target, prop) {
    return prop in globalThis.document;
  }
});

/** Load the adapter class under test (it is a global script, not an ES module). */
async function loadAdapter() {
  if (typeof globalThis.YouTubeSiteAdapter === 'function') {
    return globalThis.YouTubeSiteAdapter;
  }
  const source = await (await fetch('../youtube-adapter.js')).text();
  const windowStub = { location: { hostname: 'www.youtube.com' }, document: documentProxy };
  const debugShim = {
    isEnabled: () => true,
    debugLog: () => {},
    debugWarn: (...args) => console.warn('[test]', ...args),
    logError: (...args) => console.error('[test]', ...args),
    devLog: (options) => YTAR_DEVLOG.log(options),
    startTimer: (spec) => YTAR_DEVLOG.startTimer(spec),
    newRunId: () => YTAR_DEVLOG.newRunId(),
    newRequestId: () => YTAR_DEVLOG.newRequestId(),
    getEntries: () => YTAR_DEVLOG.getEntries()
  };
  YTAR_DEVLOG.configure({ enabled: true, verbosity: 'NORMAL' });
  new Function('document', 'window', '__YTAR_DEBUG', source)
    .call(windowStub, documentProxy, windowStub, debugShim);
  return windowStub.YouTubeSiteAdapter || globalThis.YouTubeSiteAdapter;
}

/** Build one comment's view model, optionally carrying a creator heart control. */
function buildViewModel(opts = {}) {
  const { text = 'السعر كام؟', author = 'Ahmed', toolbar = 'engagement' } = opts;
  // `hearted: true` means hearted. `heartState` is the three real renderings, and keeping them
  // SEPARATE is the whole point of this file: the container is stamped into every comment the
  // owner can heart, so a fixture that equates "container present" with "hearted" makes a
  // total mute look like a passing suite. That is exactly what happened.
  const heartState = opts.hearted ? (opts.heartState || 'on') : 'absent';

  const view = document.createElement('ytd-comment-view-model');
  view.id = 'comment';

  const authorEl = document.createElement('a');
  authorEl.id = 'author-text';
  authorEl.href = '/@' + author;
  authorEl.textContent = author;

  const meta = document.createElement('div');
  meta.id = 'meta';
  meta.appendChild(authorEl);

  const bodyText = document.createElement('yt-attributed-string');
  bodyText.textContent = text;
  const body = document.createElement('div');
  body.id = 'body';
  body.appendChild(bodyText);

  // The two toolbars YouTube is serving: `ytd-comment-engagement-bar` is the current one and
  // is what this repo's own notes record; `ytd-comment-action-buttons-renderer` is the legacy
  // bar it is replacing. Both must work, because YouTube A/B-splits between them.
  const bar = document.createElement(
    toolbar === 'engagement' ? 'ytd-comment-engagement-bar' : 'ytd-comment-action-buttons-renderer'
  );
  bar.id = 'action-buttons';
  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'toolbar';
  // The Like button is always present, hearted or not — its presence must never be read as a
  // heart, which is why it is here in EVERY fixture rather than only in the negative case.
  const like = document.createElement('ytd-toggle-button-renderer');
  like.id = 'like-button';
  like.setAttribute('aria-pressed', 'false');
  toolbarEl.appendChild(like);
  if (heartState !== 'absent') {
    const heart = document.createElement('ytd-creator-heart-renderer');
    // The button wrapper, which is present in BOTH states. Included deliberately so a fixture
    // cannot accidentally pass by omitting it.
    const button = document.createElement('yt-icon-button');
    button.id = 'creator-heart-button';
    heart.appendChild(button);

    if (heartState === 'on') {
      // #hearted-thumbnail is the creator's avatar; #hearted is the red heart drawn over it.
      // A `dom-if` in YouTube's template renders both together.
      const thumbnail = document.createElement('yt-img-shadow');
      thumbnail.id = 'hearted-thumbnail';
      const fill = document.createElement('yt-icon');
      fill.id = 'hearted';
      heart.appendChild(thumbnail);
      heart.appendChild(fill);
    } else if (heartState === 'off') {
      // The plain grey outline — the positive proof that the comment is NOT hearted.
      const outline = document.createElement('yt-icon');
      outline.id = 'unhearted';
      heart.appendChild(outline);
    } else if (heartState === 'both') {
      // A transitional frame: Polymer's `dom-if` stamps and un-stamps asynchronously, so
      // clicking the heart briefly leaves BOTH branches in the DOM. This is the only state in
      // which the `#unhearted` check earns its place — with it checked first, the ambiguous
      // frame resolves to NOT hearted, which is the direction that cannot mute a comment.
      const outline = document.createElement('yt-icon');
      outline.id = 'unhearted';
      const fill = document.createElement('yt-icon');
      fill.id = 'hearted';
      heart.appendChild(outline);
      heart.appendChild(fill);
    }
    // 'absent' inside a container: an unreadable state, which must fail OPEN.

    // Legacy markup mounts the heart inside an empty `<div id="creator-heart">`. It is a
    // sibling of the heart element, never an attribute on the comment.
    if (toolbar === 'action-buttons') {
      const mount = document.createElement('div');
      mount.id = 'creator-heart';
      mount.appendChild(heart);
      toolbarEl.appendChild(mount);
    } else {
      toolbarEl.appendChild(heart);
    }
  }
  bar.appendChild(toolbarEl);

  view.appendChild(meta);
  view.appendChild(body);
  view.appendChild(bar);
  return view;
}

/** Build a thread: the comment under test, plus optional nested replies. */
function buildThread(opts = {}) {
  const { replies = [] } = opts;
  const thread = document.createElement('ytd-comment-thread-renderer');
  thread.setAttribute('data-id', 'thread-' + Math.random().toString(36).slice(2));

  const view = buildViewModel(opts);
  thread.appendChild(view);

  if (replies.length > 0) {
    // INSIDE the view model, not beside it — which is the real shape, and the whole reason
    // the scoping has two layers. The replies renderer is a child of the comment, so a heart
    // on a reply is a DESCENDANT of the parent view model and a thread-level or
    // view-model-level query alone cannot tell the two apart. An earlier version of this
    // fixture put the replies beside the comment instead, which quietly made the scoping look
    // correct while testing nothing: both mutations below passed against it.
    const repliesEl = document.createElement('ytd-comment-replies-renderer');
    for (const reply of replies) {
      // A reply is itself a full thread — that nesting is what makes this the trap.
      const replyThread = document.createElement('ytd-comment-thread-renderer');
      const replyView = buildViewModel(reply);
      if (reply.isCreatorReply) replyView.setAttribute('is-creator-reply', '');
      if (reply.isReply) replyView.setAttribute('is-reply', '');
      if (reply.creatorBadge) {
        const badge = document.createElement('ytd-author-comment-badge-renderer');
        badge.setAttribute('creator', '');
        replyView.querySelector('#meta').appendChild(badge);
      }
      replyThread.appendChild(replyView);
      repliesEl.appendChild(replyThread);
    }
    view.appendChild(repliesEl);
  }
  return thread;
}

/** Run one test, recording the outcome. Returns whatever `fn` returns. */
async function runTest(name, fn) {
  results.total++;
  try {
    const ok = await fn();
    if (ok === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      results.failures.push(`${name}: ${ok}`);
      console.log(`✗ ${name}: ${ok}`);
    }
  } catch (error) {
    results.failed++;
    results.failures.push(`${name}: ${error.message}`);
    console.log(`✗ ${name}: ${error.message}`);
  }
  return true;
}

export default async function runAllTests() {
  const Adapter = await loadAdapter();
  const adapter = new Adapter();

  // ── THE REGRESSION THAT MUTED THE WHOLE CHANNEL ──────────────────────────────────
//
// Observed live on a community post in the channel owner's own session: 4 comments, 3 hearted
// (avatar + red heart), 1 not (a bare outlined ♡). All 4 contained `ytd-creator-heart-renderer`,
// so a presence check reported hearted on all of them and the extension excluded every comment
// on the page — no error, no log line, and a side panel reading 0/0/0 with the stage stuck on
// "Reading comments". The suite passed throughout, because every fixture it built made
// "container present" and "hearted" the same thing.

await runTest('a heart control showing the OUTLINE is not a heart', async () => {
  // This is your comment 4. The container is present, the button is present, and the comment
  // is NOT hearted. If this test fails, the extension is silently skipping every comment in the
  // owner's session — which is a total mute, and completely invisible from the side panel.
  const thread = buildThread({ hearted: true, heartState: 'off' });
  if (!thread.querySelector('ytd-creator-heart-renderer')) {
    return 'the fixture lost its heart control — this test is proving nothing';
  }
  if (!thread.querySelector('ytd-creator-heart-renderer #unhearted')) {
    return 'the fixture is missing the outline — this test is proving nothing';
  }
  if (!thread.querySelector('yt-icon-button#creator-heart-button')) {
    return 'the fixture is missing the button wrapper — this test is proving nothing';
  }
  if (adapter.isHeartedComment(thread)) {
    return 'an UNHEARTED comment was excluded — the control is present in both states';
  }
  return true;
});

await runTest('the button wrapper alone is not a heart', async () => {
  // `#creator-heart-button` is the wrapper INSIDE the renderer and is present on every
  // heartable comment. A visibility test on it measures "the owner is logged in".
  const thread = buildThread({ hearted: true, heartState: 'off' });
  const button = thread.querySelector('yt-icon-button#creator-heart-button');
  if (!button) return 'the fixture lost its button — this test is proving nothing';
  if (adapter.isHeartedComment(button)) {
    return 'the button wrapper alone was accepted as a heart';
  }
  return true;
});

await runTest('an UNREADABLE heart state fails open', async () => {
  // A container with neither `#hearted` nor `#unhearted` is unknown, not hearted. Unknown must
  // be processed normally: the whole fail-open rule exists so a YouTube markup change costs a
  // reply to a comment the creator liked rather than muting the channel.
  const thread = buildThread({ hearted: true, heartState: 'empty' });
  if (!thread.querySelector('ytd-creator-heart-renderer')) {
    return 'the fixture lost its heart control — this test is proving nothing';
  }
  if (adapter.isHeartedComment(thread)) {
    return 'an unreadable heart state was treated as a heart';
  }
  return true;
});

await runTest('a hearted comment with the avatar is recognised', async () => {
  const thread = buildThread({ hearted: true, heartState: 'on' });
  if (!thread.querySelector('#hearted')) return 'the fixture lost its heart — proving nothing';
  if (!thread.querySelector('#hearted-thumbnail')) {
    return 'the fixture lost the creator avatar — proving nothing';
  }
  if (!adapter.isHeartedComment(thread)) {
    return 'a hearted comment was not recognised';
  }
  return true;
});

await runTest('a transitional frame with BOTH icons reads as NOT hearted', async () => {
  // The one state in which the `#unhearted` check is load-bearing — mutating its removal
  // changes nothing else. Polymer's `dom-if` stamps and un-stamps asynchronously, so clicking
  // the heart briefly leaves both branches in the DOM. Reading `#hearted` first would report
  // hearted during an un-heart click; reading `#unhearted` first resolves the ambiguity toward
  // NOT hearted, which is the direction that cannot silence a comment.
  const thread = buildThread({ hearted: true, heartState: 'both' });
  if (!thread.querySelector('#hearted') || !thread.querySelector('#unhearted')) {
    return 'the fixture is missing one of the two icons — this test is proving nothing';
  }
  if (adapter.isHeartedComment(thread)) {
    return 'an ambiguous transitional frame was read as hearted';
  }
  return true;
});

// ── The direction that must hold ─────────────────────────────────────────────

  await runTest('a hearted comment is recognised as hearted', async () => {
    if (!adapter.isHeartedComment(buildThread({ hearted: true }))) {
      return 'a comment carrying ytd-creator-heart-renderer was not recognised';
    }
    return true;
  });

  await runTest('a plain comment is not hearted', async () => {
    if (adapter.isHeartedComment(buildThread())) {
      return 'an ordinary comment was reported as hearted';
    }
    return true;
  });

  await runTest('the Like button alone is never a heart', async () => {
    // Every fixture carries #like-button, so this asserts the negative explicitly rather than
    // by absence. A Like button is a sibling of the heart and a different element entirely.
    const thread = buildThread();
    const like = thread.querySelector('ytd-toggle-button-renderer#like-button');
    if (!like) return 'the fixture lost its Like button — this test is proving nothing';
    like.setAttribute('aria-pressed', 'true');
    if (adapter.isHeartedComment(thread)) {
      return 'a liked comment was excluded as if the creator had hearted it';
    }
    return true;
  });

  // ── Scoping: the failures that would be invisible ────────────────────────────
  //
  // A thread-level querySelector answers "is ANYTHING in this thread hearted". A creator
  // routinely hearts their own reply under someone else's comment, which would silence the
  // parent — for a mark the parent never received, and permanently.

  await runTest('a heart on a REPLY does not exclude the parent comment', async () => {
    const thread = buildThread({ replies: [{ hearted: true, isReply: true }] });
    const reply = thread.querySelector('ytd-creator-heart-renderer');
    if (!reply) return 'the fixture lost its reply heart — this test is proving nothing';
    // The heart must genuinely live INSIDE the comment being tested, or the scoping has
    // nothing to scope. Asserted because an earlier fixture placed the replies beside the
    // comment instead, which made every mutation of the scoping code pass.
    const parentView = thread.querySelector('ytd-comment-view-model');
    if (!parentView.contains(reply)) {
      return 'the fixture put the reply heart outside the parent comment — this test proves nothing';
    }
    if (!parentView.querySelector('ytd-comment-replies-renderer')) {
      return 'the fixture lost its replies renderer — this test is proving nothing';
    }
    if (adapter.isHeartedComment(thread)) {
      return "a reply's heart was read as the parent comment's heart";
    }
    return true;
  });

  await runTest("a hearted creator reply under an unhearted comment does not exclude it", async () => {
    const thread = buildThread({
      replies: [{ hearted: true, isReply: true, isCreatorReply: true, creatorBadge: true }]
    });
    if (adapter.isHeartedComment(thread)) {
      return 'the parent was excluded because the creator hearted their own reply';
    }
    return true;
  });

  await runTest('scoping survives the replies wrapper being renamed or absent', async () => {
    // The second scoping layer, and the reason there are two. If YouTube renames
    // `ytd-comment-replies-renderer` — which would equally break Phase 22's reply reading —
    // the `closest()` exclusion stops firing while the replies are still nested under the
    // comment. Resolving the comment's OWN view model first still excludes them, because the
    // parent comes first in document order. Without this layer, a hearted reply under a
    // renamed wrapper would silently mute its parent comment.
    const thread = document.createElement('ytd-comment-thread-renderer');
    const view = buildViewModel();
    thread.appendChild(view);

    // Replies nested directly under the comment, with NO recognised wrapper around them.
    const replyThread = document.createElement('ytd-comment-thread-renderer');
    replyThread.appendChild(buildViewModel({ hearted: true, text: 'رد من صاحب القناة' }));
    view.appendChild(replyThread);

    if (view.querySelector('ytd-comment-replies-renderer')) {
      return 'the fixture still has a recognised replies wrapper — this test is proving nothing';
    }
    if (!view.querySelector('ytd-creator-heart-renderer')) {
      return 'the fixture lost its reply heart — this test is proving nothing';
    }
    if (adapter.isHeartedComment(thread)) {
      return 'an unrecognised replies wrapper let a reply heart exclude its parent';
    }
    return true;
  });

  await runTest("a hearted creator reply with NO heart does not exclude the parent", async () => {
    // The look-alike the requirement calls out: a channel-owner REPLY is not a heart. If
    // either `is-creator-reply` or the creator badge were being read as one, this fires.
    const thread = buildThread({ replies: [{ isReply: true, isCreatorReply: true, creatorBadge: true }] });
    if (adapter.isHeartedComment(thread)) {
      return 'a channel-owner reply was mistaken for a creator heart';
    }
    return true;
  });

  await runTest('a heart on a SIBLING comment does not exclude the one being processed', async () => {
    const container = document.createElement('div');
    const mine = buildThread();
    const theirs = buildThread({ hearted: true });
    container.appendChild(mine);
    container.appendChild(theirs);
    document.body.appendChild(container);
    try {
      if (adapter.isHeartedComment(mine)) {
        return "another comment's heart excluded this one";
      }
      if (!adapter.isHeartedComment(theirs)) {
        return 'the hearted sibling was not detected, so the fixture is not proving anything';
      }
      return true;
    } finally {
      container.remove();
    }
  });

  await runTest('the words "creator-heart" in a comment body are not a heart', async () => {
    const thread = buildThread({ text: 'ما هو creator-heart ولا ytd-creator-heart-renderer؟' });
    if (adapter.isHeartedComment(thread)) {
      return 'body text was read as a heart element';
    }
    return true;
  });

  // ── Both toolbars, and the fail-open direction ───────────────────────────────

  await runTest('both toolbar generations give the same answer', async () => {
    // YouTube is migrating ytd-comment-action-buttons-renderer → ytd-comment-engagement-bar
    // and A/B-splits between them. Detection deliberately does NOT depend on either: it
    // matches the heart element and asks whose comment it belongs to, so a rename of the
    // toolbar cannot silently disable the feature. This is the regression guard for that.
    const current = buildThread({ hearted: true, toolbar: 'engagement' });
    const legacy = buildThread({ hearted: true, toolbar: 'action-buttons' });
    if (!adapter.isHeartedComment(current)) {
      return 'a hearted comment under the current engagement bar was missed';
    }
    if (!adapter.isHeartedComment(legacy)) {
      return 'a hearted comment under the legacy action-buttons bar was missed';
    }
    if (adapter.isHeartedComment(buildThread({ toolbar: 'action-buttons' }))) {
      return 'an unhearted comment under the legacy bar was reported as hearted';
    }
    return true;
  });

  await runTest('no heart element at all fails OPEN', async () => {
    // The dangerous direction is called out deliberately: an unreadable markup means the
    // comment is processed normally. A false positive would silently mute the channel, which
    // is invisible; a false negative costs one reply to a comment the creator liked.
    if (adapter.isHeartedComment(buildThread()) !== false) {
      return 'an absent heart did not read as false';
    }
    return true;
  });

  await runTest('a detached comment does not throw', async () => {
    const thread = buildThread({ hearted: true });
    thread.remove();
    try {
      const value = adapter.isHeartedComment(thread);
      if (value !== true) return 'a detached but intact hearted comment did not read as hearted';
    } catch (error) {
      return `isHeartedComment() threw on a detached node: ${error.message}`;
    }
    return true;
  });

  await runTest('isHeartedComment survives junk without throwing', async () => {
    for (const value of [null, undefined, {}, 'not-an-element', 42, document.createTextNode('x')]) {
      let result;
      try {
        result = adapter.isHeartedComment(value);
      } catch (error) {
        return `isHeartedComment(${String(value)}) threw: ${error.message}`;
      }
      if (result !== false) return `isHeartedComment(${String(value)}) did not return false`;
    }
    return true;
  });

  // ── The flag the wire carries ────────────────────────────────────────────────
  //
  // content.js drops hearted comments before sending, so `hearted` on the payload is
  // `false` on everything the worker ever sees in practice. It exists so a page that got
  // past the gate cannot make the worker spend a model call — and that only works if
  // parseComment stamps the SAME predicate the gate consults.

  await runTest('parseComment stamps the heart state for both directions', async () => {
    const hearted = adapter.parseComment(buildThread({ hearted: true }));
    if (!hearted) return 'a hearted comment did not parse at all';
    if (hearted.hearted !== true) {
      return `parseComment() stamped hearted=${String(hearted.hearted)} on a hearted comment`;
    }
    const plain = adapter.parseComment(buildThread());
    if (plain && plain.hearted !== false) {
      return `parseComment() stamped hearted=${String(plain.hearted)} on an ordinary comment`;
    }
    return true;
  });

  // ── The selector is the thing that can go stale ──────────────────────────────

  await runTest('the heart is matched by ELEMENT, not by the attribute that does not exist', async () => {
    // `ytd-comment-renderer[creator-heart]` is what most implementations reach for and it is
    // NOT in YouTube's DOM, so an attribute-presence test would read false on every comment.
    // Asserting the element keeps a future "simplification" into that attribute from passing.
    const S = Adapter.SELECTORS;
    if (S.CREATOR_HEART !== 'ytd-creator-heart-renderer') {
      return `CREATOR_HEART is "${S.CREATOR_HEART}", not the confirmed element name`;
    }
    // Prove the negative on a REAL hearted comment: the heart IS there, the attribute is not,
    // and detection still works. If YouTube ever ships `creator-heart`, this fails loudly and
    // says so, rather than the attribute quietly becoming the only signal.
    const thread = buildThread({ hearted: true });
    const view = thread.querySelector('ytd-comment-view-model');
    if (!view.querySelector(S.CREATOR_HEART)) {
      return 'the fixture lost its heart element — this test is proving nothing';
    }
    if (view.hasAttribute('creator-heart') || view.hasAttribute('hearted')) {
      return 'the fixture set an attribute this suite asserts does not exist';
    }
    if (!adapter.isHeartedComment(thread)) {
      return 'the hearted comment was not detected, so the negative above proves nothing';
    }
    return true;
  });

  // ── heartComment tests ───────────────────────────────────────────────────────

  await runTest('heartComment clicks unhearted comment control and returns true', async () => {
    const thread = buildThread({ hearted: true, heartState: 'off' });
    const heartBtn = thread.querySelector('#creator-heart-button');
    let clicked = false;
    heartBtn.addEventListener('click', () => { clicked = true; });

    const result = adapter.heartComment(thread);
    if (result !== true) return `expected true, got ${result}`;
    if (!clicked) return 'the heart button click listener was not triggered';
    return true;
  });

  await runTest('heartComment refuses to click already-hearted comment (never un-hearts)', async () => {
    const thread = buildThread({ hearted: true, heartState: 'on' });
    const heartBtn = thread.querySelector('#creator-heart-button');
    let clicked = false;
    heartBtn.addEventListener('click', () => { clicked = true; });

    const result = adapter.heartComment(thread);
    if (result !== false) return `expected false for already hearted comment, got ${result}`;
    if (clicked) return 'heartComment must never click an already hearted comment';
    return true;
  });

  await runTest('heartComment and isHeartedComment accept parsed comment object with .element', async () => {
    const thread = buildThread({ hearted: true, heartState: 'off' });
    const commentObj = { id: 'test-c1', element: thread, author: 'User' };
    const heartBtn = thread.querySelector('#creator-heart-button');
    let clicked = false;
    heartBtn.addEventListener('click', () => { clicked = true; });

    if (adapter.isHeartedComment(commentObj) !== false) {
      return 'isHeartedComment should return false for unhearted comment object';
    }

    const result = adapter.heartComment(commentObj);
    if (result !== true) return `expected heartComment(commentObj) to return true, got ${result}`;
    if (!clicked) return 'the heart button was not clicked when passing commentObj';
    return true;
  });

  await runTest('heartComment clicks native inner button if wrapped in yt-icon-button', async () => {
    const thread = buildThread({ hearted: true, heartState: 'off' });
    const heartBtn = thread.querySelector('#creator-heart-button');
    const nativeBtn = document.createElement('button');
    nativeBtn.id = 'button';
    heartBtn.appendChild(nativeBtn);

    let innerClicked = false;
    nativeBtn.addEventListener('click', (e) => {
      innerClicked = true;
      e.stopPropagation();
    });

    const result = adapter.heartComment(thread);
    if (result !== true) return `expected true, got ${result}`;
    if (!innerClicked) return 'expected the inner native button to receive click';
    return true;
  });

  await runTest('hasCreatorReply returns false when thread has no replies', async () => {
    const thread = buildThread({ text: 'تم' });
    const result = adapter.hasCreatorReply(thread);
    if (result !== false) return `expected false, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns false when replies contain no creator reply', async () => {
    const thread = buildThread({
      text: 'تم',
      replies: [
        { text: 'أنا أيضاً', author: 'Viewer2' }
      ]
    });
    const result = adapter.hasCreatorReply(thread);
    if (result !== false) return `expected false, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns true when a reply has creator badge or owner class', async () => {
    const thread = buildThread({
      text: 'تم',
      replies: [
        { text: 'شكراً لك', author: 'ChannelOwner', creatorBadge: true }
      ]
    });
    const result = adapter.hasCreatorReply(thread);
    if (result !== true) return `expected true, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply accepts parsed comment object with .element', async () => {
    const thread = buildThread({
      text: 'تم',
      replies: [
        { text: 'تم التواصل خاص', author: 'ChannelOwner', creatorBadge: true }
      ]
    });
    const commentObj = { id: 'c-1', element: thread, text: 'تم' };
    const result = adapter.hasCreatorReply(commentObj);
    if (result !== true) return `expected true, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns true when collapsed replies have #creator-thumbnail', async () => {
    const thread = document.createElement('ytd-comment-thread-renderer');
    const view = buildViewModel({ text: 'تم' });
    thread.appendChild(view);

    const repliesEl = document.createElement('ytd-comment-replies-renderer');
    const expander = document.createElement('div');
    expander.id = 'expander';

    const creatorThumb = document.createElement('yt-img-shadow');
    creatorThumb.id = 'creator-thumbnail';
    expander.appendChild(creatorThumb);

    repliesEl.appendChild(expander);
    view.appendChild(repliesEl);

    const result = adapter.hasCreatorReply(thread);
    if (result !== true) return `expected true for collapsed thread with #creator-thumbnail, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns true when expander button contains an avatar image', async () => {
    const thread = document.createElement('ytd-comment-thread-renderer');
    const view = buildViewModel({ text: 'تم' });
    thread.appendChild(view);

    const repliesEl = document.createElement('ytd-comment-replies-renderer');
    const button = document.createElement('button');
    button.id = 'more-replies';

    const avatar = document.createElement('yt-img-shadow');
    const img = document.createElement('img');
    img.src = 'https://yt3.ggpht.com/creator-avatar.jpg';
    avatar.appendChild(img);
    button.appendChild(avatar);

    repliesEl.appendChild(button);
    view.appendChild(repliesEl);

    const result = adapter.hasCreatorReply(thread);
    if (result !== true) return `expected true for expander with avatar image, got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns true when expander button aria-label indicates reply from creator', async () => {
    const thread = document.createElement('ytd-comment-thread-renderer');
    const view = buildViewModel({ text: 'تم' });
    thread.appendChild(view);

    const repliesEl = document.createElement('ytd-comment-replies-renderer');
    const button = document.createElement('button');
    button.id = 'expander';
    button.setAttribute('aria-label', 'رد من صاحب القناة');

    repliesEl.appendChild(button);
    view.appendChild(repliesEl);

    const result = adapter.hasCreatorReply(thread);
    if (result !== true) return `expected true for aria-label with "رد من", got ${result}`;
    return true;
  });

  await runTest('hasCreatorReply returns true for community post replies using ytd-comment-renderer', async () => {
    const thread = document.createElement('div');
    const mainComment = document.createElement('ytd-comment-renderer');
    thread.appendChild(mainComment);

    const repliesEl = document.createElement('ytd-comment-replies-renderer');
    const replyRenderer = document.createElement('ytd-comment-renderer');
    const badge = document.createElement('ytd-author-comment-badge-renderer');
    badge.setAttribute('creator', '');
    replyRenderer.appendChild(badge);

    repliesEl.appendChild(replyRenderer);
    thread.appendChild(repliesEl);

    const result = adapter.hasCreatorReply(mainComment);
    if (result !== true) return `expected true for community post reply with badge, got ${result}`;
    return true;
  });

  return results;
}