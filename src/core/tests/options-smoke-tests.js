/**
 * Options Page Smoke Tests (Phase 20.23 pre-flight)
 *
 * WHY THIS EXISTS. Phase 20.23 is real YouTube runtime testing, and its FIRST step is
 * "open the Options page". `options.js` is 1,268 lines and NO suite loaded it — not one test
 * opened `options.html`. Phase 20.20 added the Knowledge Base row (status + re-index) to it
 * and nothing ever rendered it, so a thrown reference, a wrong element id or a bad stylesheet
 * class would have broken the entire Options page and the only symptom would have been a user
 * reporting that the extension "does nothing" during the one test that has no code harness.
 *
 * The markup is FETCHED from the real `options.html` rather than mirrored. Mirroring is what
 * `popup-tests.html` does, and mirroring is exactly how a suite keeps passing after the real
 * page changes: the copy and the page drift, and the copy is what is asserted. Fetching means
 * an id that does not exist in the real markup fails here.
 *
 * `options.js` is imported for real and its own `DOMContentLoaded` handler is the thing under
 * test, so this exercises `init()` end to end rather than calling its internals.
 *
 * Runs in the browser from options-smoke-tests.html (there is no Node runner).
 */

const results = { total: 0, passed: 0, failed: 0, failures: [] };

/**
 * Verbatim from `src/options/options.html`. Kept as a literal so a reader can diff it
 * against the page by eye; `verify-extension.mjs` enforces the ids.
 */
const KNOWLEDGE_ROW_MARKUP = `
  <div class="row">
    <label class="row-label" for="kb-reload">
      <svg class="ic"><use href="#i-sparkle"/></svg>Knowledge Base
    </label>
    <div class="row-field">
      <div class="row-inline">
        <button type="button" class="btn" id="kb-reload">Re-index now</button>
        <span class="hint" id="kb-status" role="status">Checking the index&hellip;</span>
      </div>
      <p class="hint" id="kb-detail">Re-indexing re-reads every knowledge file.</p>
    </div>
  </div>
  <div class="row">
    <span class="row-label">Documents <span class="opt" id="kb-counts"></span></span>
    <div class="row-field">
      <div id="kb-list" class="kb-list"></div>
      <input class="control" id="kb-filename" type="text" />
      <textarea class="control" id="kb-content" rows="7"></textarea>
      <div class="row-inline">
        <button type="button" class="btn btn-primary" id="kb-save">Add file</button>
        <button type="button" class="btn btn-ghost" id="kb-cancel" hidden>Cancel edit</button>
        <span class="hint" id="kb-message" role="status"></span>
    </div>
  </div>`;

/**
 * The heart-filter switch, mirrored from `options.html` for the same reason the knowledge row
 * above is: the suite runs over `file://` and cannot fetch the real page. The behaviour is
 * tested against the real `options.js`, and `verify-extension.mjs` reads the shipped
 * `options.html` to assert this id really exists in it.
 */
const HEART_FILTER_MARKUP = `
  <div class="row">
    <label class="row-label" for="ignore-hearted-comments">
      Comments you hearted
    </label>
    <div class="row-field">
      <label class="check" for="ignore-hearted-comments">
        <input type="checkbox" id="ignore-hearted-comments" name="ignoreHeartedComments">
        <span>Do not reply to comments I have hearted</span>
      </label>
      <p class="hint hint-block">Turn this off and hearted comments are answered like any other.</p>
    </div>
  </div>`;

/**
 * Phase 23.1 — Target Replies & Hearting toggle markup mirrored from options.html.
 */
const TARGET_HEARTING_MARKUP = `
  <div class="row">
    <label class="row-label" for="target-reply-hearting">
      Target Replies &amp; Hearting
    </label>
    <div class="row-field">
      <label class="check" for="target-reply-hearting">
        <input type="checkbox" id="target-reply-hearting" name="targetReplyHeartingEnabled">
        <span>Match target comments, prepare reply drafts, and heart processed comments.</span>
      </label>
    </div>
  </div>`;

/**
 * The handful of settings controls `loadSettings()` touches BEFORE it reaches the heart
 * checkbox, mirrored so the load path actually runs to that point.
 *
 * This was needed because `loadSettings()` assigns `baseUrl.value` early and throws on the
 * first missing element — which it always did, and which nothing noticed, because every
 * existing case here asserts on the KNOWLEDGE block further down and a throw inside
 * `loadSettings()` is swallowed and logged rather than raised. So the knowledge tests passed
 * over a settings loader that had never once completed.
 *
 * It is the same shape of blind spot as the "declared but never called" helpers elsewhere in
 * this repo: the tests were green, and the code they claimed to cover had never run.
 */
const SETTINGS_LOAD_MARKUP = `
  <form id="settings-form">
    <input type="text" id="baseUrl" />
    <select id="model"></select>
    <select id="reply-mode">
      <option value="trigger">Trigger</option>
      <option value="knowledge">Knowledge</option>
      <option value="hybrid">Hybrid</option>
    </select>
    <select id="response-style">
      <option value="friendly">Friendly</option>
      <option value="professional">Professional</option>
      <option value="short">Short</option>
    </select>
    <textarea id="static-context"></textarea>
    <input type="checkbox" id="followup-on-answered" />
    <textarea id="followup-instruction"></textarea>
    <textarea id="reply-blacklist"></textarea>
    <input type="checkbox" id="dry-run" />
    <input type="text" id="max-replies-per-hour" />
    <input type="text" id="reply-delay-min" />
    <input type="text" id="reply-delay-max" />
    <input type="checkbox" id="debug-mode" />
    <div id="message"></div>
  </form>`;

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
}

/** Answers the page records, so each case can describe one situation. */
function makeResponses(overrides) {
  return Object.assign(
    {
      GET_KNOWLEDGE_STATUS: {
        success: true,
        status: {
          state: 'fresh',
          retrievable: true,
          documentCount: 2,
          storedDocumentCount: 2,
          sectionCount: 7,
          builtAt: 1700000000000,
          error: '',
          code: '',
          cached: true
        }
      },
      RELOAD_KNOWLEDGE: {
        success: true,
        retrievable: true,
        state: 'fresh',
        documentCount: 2,
        sectionCount: 7,
        builtAt: 1700000000000,
        error: '',
        status: {
          state: 'fresh',
          retrievable: true,
          documentCount: 2,
          storedDocumentCount: 2,
          sectionCount: 7,
          builtAt: 1700000000000,
          error: '',
          cached: true
        }
      },
      GET_KNOWLEDGE_DOCUMENTS: {
        success: true,
        documents: [
          { id: 'kdoc-1', filename: 'books/chemistry.md', content: '# كيمياء\n\n## السعر\n\n350 جنيه.\n', enabled: true, version: 1, charCount: 24 },
          { id: 'kdoc-2', filename: 'shipping.md', content: '# الشحن\n', enabled: false, version: 3, charCount: 8 }
        ],
        stats: { total: 2, enabled: 1, disabled: 1, chars: 32, fingerprint: 'f', maxDocuments: 50, maxChars: 1000000 }
      },
      ADD_KNOWLEDGE_DOCUMENT: { success: true, document: { id: 'kdoc-3', filename: 'books/new.md', enabled: true, version: 1 } },
      UPDATE_KNOWLEDGE_DOCUMENT: { success: true, document: { id: 'kdoc-1', filename: 'books/chemistry.md', enabled: true, version: 2 } },
      REMOVE_KNOWLEDGE_DOCUMENT: { success: true, removed: { id: 'kdoc-1', filename: 'books/chemistry.md' } },
      GET_LM_STUDIO_MODELS: { success: true, models: [] },
      TEST_CONNECTION: { success: true, status: 'connected' },
      TEST_CHAT_COMPLETION: { success: true }
    },
    overrides || {}
  );
}

/**
 * Install a `chrome` stub and load the real Options page.
 *
 * The order matters and is the whole trick: `options.js` attaches its listener to
 * `DOMContentLoaded`, which has ALREADY fired by the time a test module runs, so the event
 * has to be dispatched by hand — and the listener only exists once the module has been
 * imported. Import first, then inject the markup, then dispatch.
 *
 * @returns {{sent: Array<Object>, restore: () => void, errors: string[]}}
 */
async function loadOptionsPage(responses, options) {
  const sent = [];
  const errors = [];
  /**
   * Every `storage.local.set` the page performed, in order.
   *
   * Recorded rather than stubbed away, because a save that replaces `replyBehavior` wholesale
   * is indistinguishable from a working save by looking at the UI: the one value the creator
   * clicked does change. The damage only shows in what ELSE was written, which means the test
   * has to be able to see the write.
   */
  const writes = [];
  const answers = responses || makeResponses();

  const realChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.1.0' }),
      getURL: (path) => `chrome-extension://test/${path}`,
      // Record every request, and answer from the table. An action with no entry answers
      // `{success:true}` rather than nothing, so an unexpected call shows up as a missing
      // assertion rather than as a page that silently does nothing.
      sendMessage: (message, callback) => {
        sent.push(message && message.action);
        // A rejecting stub models a service worker that is asleep or was just reloaded —
        // the state the Options page is most often opened in.
        if (options && options.rejectMessages) {
          if (typeof callback === 'function') {
            setTimeout(() => callback({ success: false, error: 'no worker' }), 0);
            return;
          }
          return Promise.reject(new Error('no worker'));
        }
        const answer = answers[message && message.action] || { success: true };
        if (typeof callback === 'function') setTimeout(() => callback(answer), 0);
        return Promise.resolve(answer);
      },
      onMessage: { addListener: () => {} },
      lastError: undefined
    },
    storage: {
      local: {
        get: async () => (
          options && options.settings
            ? options.settings
            : {
                enabled: true,
                dryRun: true,
                debugMode: false,
                replyBehavior: { responseStyle: 'friendly', replyMode: 'knowledge', maxRepliesPerHour: 30 },
                contextTemplates: []
              }
        ),
        set: async (values) => { writes.push(values); },
        remove: async () => {}
      },
      onChanged: {
        addListener: (fn) => storageListeners.add(fn),
        removeListener: (fn) => storageListeners.delete(fn)
      }
    },
    tabs: { create: () => {} },
    sidePanel: { open: () => Promise.resolve() }
  };

  const storageListeners = new Set();

  // Any uncaught error on the page is a failure of the page, not of the test.
  const onError = (event) => { errors.push(String(event.message || event.error)); };
  const onRejection = (event) => { errors.push('unhandled rejection: ' + String(event.reason)); };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  // The knowledge row, mirrored. `fetch()` of the real options.html is NOT possible here:
  // the runner drives these suites over `file://`, where Chrome refuses cross-origin reads,
  // and the request hangs rather than failing. Mirroring splits the difference — the
  // BEHAVIOUR is tested here against the real options.js, and `verify-extension.mjs` reads
  // the shipped options.html directly to assert these three ids really exist in it. A mirror
  // that drifts is therefore caught, just not by this file.
  document.getElementById('harness-sandbox').innerHTML =
    SETTINGS_LOAD_MARKUP + KNOWLEDGE_ROW_MARKUP + HEART_FILTER_MARKUP + TARGET_HEARTING_MARKUP;

  // Import BEFORE dispatching: `options.js` attaches its whole init chain to a
  // `DOMContentLoaded` listener, so the event has to fire after the module has evaluated.
  await import('../../options/options.js');

  document.dispatchEvent(new Event('DOMContentLoaded'));
  // init() is async; give it its storage round trips.
  await new Promise((resolve) => setTimeout(resolve, 250));

  return {
    sent,
    writes,
    errors,
    fireStorageChanged: (changes, area = 'local') => {
      for (const fn of storageListeners) fn(changes, area);
    },
    restore: () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.getElementById('harness-sandbox').innerHTML = '';
      globalThis.chrome = realChrome;
    }
  };
}

const text = (id) => {
  const el = document.getElementById(id);
  return el ? el.textContent.trim() : null;
};

const list = () => document.getElementById('kb-list');

const klass = (id) => {
  const el = document.getElementById(id);
  return el ? el.className : null;
};

// ── the heart-filter switch ───────────────────────────────────────────────────

/** A fresh install must show the box TICKED, because that is what the extension does. */
async function testTheHeartSwitchLoadsTickedOnAFreshInstall() {
  // `ignoreHeartedComments` is deliberately ABSENT from the stored settings here, which is
  // exactly the state of a user who has never opened this page. DEFAULT_CONFIG says true, so
  // an unchecked box would be lying about the extension's behaviour on the very first visit.
  const page = await loadOptionsPage();
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const box = document.getElementById('ignore-hearted-comments');
    if (!box) return 'the checkbox is missing';
    if (box.checked !== true) return 'a fresh install must show the heart filter ON';
    return true;
  } finally {
    page.restore();
  }
}

/** A stored `false` must load unchecked. */
async function testTheHeartSwitchLoadsTheStoredValue() {
  const page = await loadOptionsPage(null, {
    settings: {
      enabled: true,
      dryRun: true,
      replyBehavior: { replyMode: 'trigger', ignoreHeartedComments: false }
    }
  });
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const box = document.getElementById('ignore-hearted-comments');
    if (!box) return 'the checkbox is missing';
    if (box.checked !== false) return 'a stored false must load unchecked';
    return true;
  } finally {
    page.restore();
  }
}

/**
 * THE DATA-LOSS TEST.
 *
 * `saveSettings()` is a `chrome.storage.local.set()`, which REPLACES `replyBehavior` outright.
 * So writing the switch without spreading the existing object silently resets the reply mode,
 * the rate cap, the delays, the context and the follow-up switch. The UI would show no error,
 * the one value the creator clicked WOULD have changed — so this is a data-loss bug that looks
 * like a successful click, which is the worst place for it to hide.
 */
async function testTheHeartSwitchSavesWithoutResettingTheOtherReplySettings() {
  const before = {
    responseStyle: 'professional',
    replyMode: 'knowledge',
    staticContext: 'keep me',
    blacklist: ['nope'],
    // Whole seconds, because that is the unit the field is EDITED in: loadSettings shows
    // `Math.round(ms / 1000)` and the save multiplies back. Storing 1111ms here would make
    // the round-trip lose 111ms and this test would fail over correct, intended precision.
    minDelayMs: 8000,
    maxDelayMs: 20000,
    maxRepliesPerHour: 42,
    followupOnAnswered: true,
    followupInstruction: 'one sentence',
    ignoreHeartedComments: true,
    ignoreCreatorRepliedComments: true
  };
  const page = await loadOptionsPage(null, {
    settings: { enabled: true, dryRun: true, replyBehavior: { ...before } }
  });
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;

    const box = document.getElementById('ignore-hearted-comments');
    if (!box) return 'the checkbox is missing';
    if (box.checked !== true) return `setup failed: expected ticked, got ${box.checked}`;
    box.checked = false;

    // The page's own submit path, so the real handler runs — not an internal call.
    const form = document.getElementById('settings-form') || document.createElement('form');
    if (!form.parentNode) document.getElementById('harness-sandbox').appendChild(form);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    // NOT the last write: the page also writes `debugMode` as a separate top-level key, so
    // indexing the tail picks the wrong object and reports "nothing was saved" for a save that
    // plainly happened.
    const write = page.writes.find((w) => w && w.replyBehavior);
    if (!write) return `no write carried replyBehavior (writes: ${page.writes.length})`;

    const after = write.replyBehavior;
    for (const key of Object.keys(before)) {
      if (key === 'ignoreHeartedComments') continue;
      if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
        return `saving the switch reset replyBehavior.${key}: ` +
          `${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`;
      }
    }
    if (after.ignoreHeartedComments !== false) {
      return `the unticked box was not saved: got ${JSON.stringify(after.ignoreHeartedComments)}`;
    }
    return true;
  } finally {
    page.restore();
  }
}

// ── the target-reply-hearting switch ─────────────────────────────────────────

async function testTargetReplyHeartingLoadsUntickedOnFreshInstall() {
  const page = await loadOptionsPage();
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const box = document.getElementById('target-reply-hearting');
    if (!box) return 'the target-reply-hearting checkbox is missing';
    if (box.checked !== false) return 'a fresh install must show targetReplyHeartingEnabled unchecked';
    return true;
  } finally {
    page.restore();
  }
}

async function testTargetReplyHeartingLoadsStoredValue() {
  const page = await loadOptionsPage(null, {
    settings: {
      enabled: true,
      dryRun: true,
      targetReplyHeartingEnabled: true,
      replyBehavior: { replyMode: 'trigger' }
    }
  });
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const box = document.getElementById('target-reply-hearting');
    if (!box) return 'the checkbox is missing';
    if (box.checked !== true) return 'a stored true must load checked';
    return true;
  } finally {
    page.restore();
  }
}

async function testTargetReplyHeartingTogglingSavesImmediately() {
  const page = await loadOptionsPage();
  try {
    const box = document.getElementById('target-reply-hearting');
    if (!box) return 'the checkbox is missing';
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lastWrite = page.writes[page.writes.length - 1];
    if (!lastWrite || lastWrite.targetReplyHeartingEnabled !== true) {
      return `clicking checkbox did not persist targetReplyHeartingEnabled: true, got ${JSON.stringify(lastWrite)}`;
    }
    return true;
  } finally {
    page.restore();
  }
}

async function testTargetReplyHeartingSyncsFromExternalChange() {
  const page = await loadOptionsPage();
  try {
    const box = document.getElementById('target-reply-hearting');
    if (!box) return 'the checkbox is missing';
    page.fireStorageChanged({ targetReplyHeartingEnabled: { newValue: true } }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (box.checked !== true) return 'external storage change to true was not reflected in the checkbox';
    return true;
  } finally {
    page.restore();
  }
}

async function testThePageLoadsWithoutErrors() {
  const page = await loadOptionsPage();
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    // Every id options.js reaches for at init must exist, or its DOMContentLoaded handler
    // throws partway and the rest of the page never initialises. `refreshKnowledge()` is the
    // LAST thing init() awaits, so reaching it proves the whole chain ran.
    if (!page.sent.includes('GET_KNOWLEDGE_DOCUMENTS') || !page.sent.includes('GET_KNOWLEDGE_STATUS')) {
      return `the knowledge block never initialised (asked for: ${page.sent.join(', ')})`;
    }
    return true;
  } finally {
    page.restore();
  }
}

async function testAReadyIndexReadsAsUpToDate() {
  const page = await loadOptionsPage();
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    if (text('kb-status') !== 'Up to date') return `status="${text('kb-status')}"`;
    if (!/is-ready/.test(klass('kb-status') || '')) return `class="${klass('kb-status')}"`;
    if (!/2 files, 7 sections indexed/.test(text('kb-detail') || '')) {
      return `detail="${text('kb-detail')}"`;
    }
    return true;
  } finally {
    page.restore();
  }
}

async function testAnEmptyBaseIsNotAnError() {
  // The distinction that matters to a user: a base with nothing in it is a fresh install,
  // not something broken. A red "Index failed" here would be a lie.
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_STATUS: {
      success: true,
      status: {
        state: 'empty', retrievable: false, documentCount: 0, storedDocumentCount: 0,
        sectionCount: 0, builtAt: 0, error: '', code: '', cached: false
      }
    }
  }));
  try {
    const status = text('kb-status');
    if (status !== 'No knowledge files yet') return `status="${status}"`;
    if (/is-error/.test(klass('kb-status') || '')) return 'an empty base must not be tinted as an error';
    if (!/Trigger mode needs none/.test(text('kb-detail') || '')) return `detail="${text('kb-detail')}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testAFailedBuildShowsTheReasonAndIsTinted() {
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_STATUS: {
      success: true,
      status: {
        state: 'failed', retrievable: false, documentCount: 1, storedDocumentCount: 2,
        sectionCount: 0, builtAt: 1700000000000,
        error: 'books/broken.md produced no sections', code: 'KNOWLEDGE_INDEX_FAILED', cached: false
      }
    }
  }));
  try {
    if (text('kb-status') !== 'Index failed') return `status="${text('kb-status')}"`;
    if (!/is-error/.test(klass('kb-status') || '')) return `class="${klass('kb-status')}"`;
    // The reason has to name the file, or the user has nowhere to go.
    if (!/broken\.md/.test(text('kb-detail') || '')) return `detail="${text('kb-detail')}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testFilesSavedButNotIndexedAreNotReportedAsNoFiles() {
  // `documentCount` is what is INDEXED and is 0 before the first build; `storedDocumentCount`
  // is what is in the base. Reading only the first would tell a user who has just saved their
  // first file that they have none — and then answer from it on the very next comment.
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_STATUS: {
      success: true,
      status: {
        state: 'stale', retrievable: false, documentCount: 0, storedDocumentCount: 3,
        sectionCount: 0, builtAt: 0, error: '', code: '', cached: false
      }
    }
  }));
  try {
    if (text('kb-status') === 'No knowledge files yet') {
      return 'a base with three saved files was reported as empty';
    }
    if (!/3 files saved/.test(text('kb-detail') || '')) return `detail="${text('kb-detail')}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testAFailureReasonIsNeverMarkup() {
  // The failure text embeds a FILENAME, and filenames are user input. Every other string in
  // this row is one of our own constants, which is why this is the only place worth an
  // injection test — and it is a place: `innerHTML` here would turn "my file is called
  // <img onerror=…>.md" into script execution on the Options page.
  delete window.__pwned;
  const payload = '<img src=x onerror="window.__pwned=1">';
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_STATUS: {
      success: true,
      status: {
        state: 'failed', retrievable: false, documentCount: 0, storedDocumentCount: 1,
        sectionCount: 0, builtAt: 1,
        error: `books/${payload}.md produced no sections`,
        code: 'KNOWLEDGE_INDEX_FAILED', cached: false
      }
    }
  }));
  try {
    if (window.__pwned === true) return 'the failure reason EXECUTED — it is rendered as markup';
    if (document.querySelector('#kb-detail img')) return 'an <img> element was created from the filename';
    // textContent round-trips the characters, so the reason stays READABLE as text.
    if ((text('kb-detail') || '').indexOf(payload) === -1) {
      return `the reason was mangled rather than shown: "${text('kb-detail')}"`;
    }
    return true;
  } finally {
    delete window.__pwned;
    page.restore();
  }
}

async function testTheReloadButtonAsksTheWorkerToReIndex() {
  const page = await loadOptionsPage();
  try {
    const btn = document.getElementById('kb-reload');
    if (!btn) return 'the re-index button is missing';
    const before = page.sent.filter((a) => a === 'RELOAD_KNOWLEDGE').length;

    btn.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = page.sent.filter((a) => a === 'RELOAD_KNOWLEDGE').length;
    if (after !== before + 1) return `RELOAD_KNOWLEDGE was sent ${after - before} time(s), expected once`;
    if (text('kb-status') !== 'Up to date') return `status after reload="${text('kb-status')}"`;
    // The button must be re-enabled, or the second press does nothing and the user cannot
    // retry without reloading the page.
    if (btn.disabled) return 'the button stayed disabled after a successful reload';
    return true;
  } finally {
    page.restore();
  }
}

async function testAFailedReloadSaysSoAndKeepsTheButtonUsable() {
  const page = await loadOptionsPage(makeResponses({
    RELOAD_KNOWLEDGE: {
      success: false, retrievable: false, code: 'KNOWLEDGE_INDEX_FAILED',
      error: 'books/broken.md produced no sections'
    }
  }));
  try {
    const btn = document.getElementById('kb-reload');
    btn.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (text('kb-status') !== 'Re-index failed') return `status="${text('kb-status')}"`;
    if (!/is-error/.test(klass('kb-status') || '')) return `class="${klass('kb-status')}"`;
    if (!/broken\.md/.test(text('kb-detail') || '')) return `the reason was lost: "${text('kb-detail')}"`;
    if (btn.disabled) return 'the button stayed disabled after a failed reload';
    return true;
  } finally {
    page.restore();
  }
}

async function testADeadWorkerDoesNotBreakThePage() {
  // The row must degrade, not throw. A restarted worker is the state the Options page is
  // most often opened in, and an uncaught rejection here would leave the whole page half
  // initialised.
  const page = await loadOptionsPage(makeResponses(), { rejectMessages: true });
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const status = text('kb-status');
    if (!status) return 'the knowledge row rendered nothing at all';
    if (status === 'Checking the index…') {
      return 'the row is stuck on its loading text — the status read never settled';
    }
    if (status !== 'Status unavailable') return `status="${status}"`;
    if (!/is-error/.test(klass('kb-status') || '')) return `class="${klass('kb-status')}"`;
    // `init()` finishes by asking for the knowledge status, so reaching that request IS the
    // proof the whole chain ran with a rejecting worker. Not `GET_LM_STUDIO_MODELS`: that
    // sits inside `loadSettings()`'s try/catch, and a rejecting stub legitimately aborts it
    // — asserting it would demand the page do work that its own error handling declines to do.
    if (!page.sent.includes('GET_KNOWLEDGE_STATUS')) {
      return `init() never reached its last step (asked for: ${page.sent.join(', ')})`;
    }
    return true;
  } finally {
    page.restore();
  }
}


async function testTheDocumentListRenders() {
  const page = await loadOptionsPage();
  try {
    if (page.errors.length) return `the page raised: ${page.errors.join(' | ')}`;
    const list = document.getElementById('kb-list');
    const rows = list.querySelectorAll('.kb-row');
    if (rows.length !== 2) return `expected 2 rows, got ${rows.length}`;
    if (rows[0].textContent.indexOf('books/chemistry.md') === -1) return 'the filename is missing';
    if (!/24 chars/.test(rows[0].textContent)) return `size is missing: "${rows[0].textContent}"`;
    // A disabled document stays VISIBLE and dimmed. Hiding it would make "disabled"
    // indistinguishable from "deleted", which is not what the user did.
    if (rows[1].className.indexOf('is-off') === -1) return `a disabled row is not marked: ${rows[1].className}`;
    if (!/Enable/.test(rows[1].textContent)) return 'a disabled row must offer Enable';
    if (text('kb-counts') !== '2 files, 1 enabled') return `counts="${text('kb-counts')}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testADocumentNameIsNeverMarkup() {
  // A filename is user input and the row is built with DOM APIs. If this ever goes through
  // `innerHTML`, a file called `<img onerror=…>` becomes script on the Options page.
  delete window.__pwned;
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_DOCUMENTS: {
      success: true,
      documents: [{ id: 'k1', filename: '<img src=x onerror="window.__pwned=1">.md', content: 'x', enabled: true, version: 1 }],
      stats: { total: 1, enabled: 1, disabled: 0, chars: 1, fingerprint: 'f', maxDocuments: 50, maxChars: 1000000 }
    }
  }));
  try {
    if (window.__pwned === true) return 'the filename EXECUTED';
    if (document.querySelector('#kb-list img')) return 'an <img> was created from the filename';
    if (list().textContent.indexOf('<img') === -1) return `the filename was mangled: "${list().textContent}"`;
    return true;
  } finally {
    delete window.__pwned;
    page.restore();
  }
}

async function testAnEmptyBaseShowsAnInvitationNotAnError() {
  const page = await loadOptionsPage(makeResponses({
    GET_KNOWLEDGE_DOCUMENTS: {
      success: true, documents: [],
      stats: { total: 0, enabled: 0, disabled: 0, chars: 0, fingerprint: '', maxDocuments: 50, maxChars: 1000000 }
    }
  }));
  try {
    if (list().querySelectorAll('.kb-row').length !== 0) return 'rows rendered for an empty base';
    if (!/Add one below/.test(list().textContent)) return `text="${list().textContent}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testTheHiddenCancelButtonIsActuallyInvisible() {
  // `element.hidden === true` is NOT the same as invisible: any author rule with a `display`
  // beats the browser's `[hidden] { display: none }`. `.btn` sets `display: inline-flex`, so
  // the attribute was set and the button was still on screen — caught in a real browser
  // screenshot, not by a property assertion. This therefore reads the COMPUTED STYLE, and
  // needs the real stylesheet loaded, which the test page now links.
  const page = await loadOptionsPage();
  try {
    const cancel = document.getElementById('kb-cancel');
    const display = getComputedStyle(cancel).display;
    if (display !== 'none') {
      return `the cancel button is VISIBLE (display: ${display}) — the [hidden] attribute is being ` +
        'beaten by an author display rule';
    }

    // And it must come back when editing starts.
    const { startKnowledgeEdit, knowledgeDocById } = await import('../../options/options.js');
    startKnowledgeEdit(knowledgeDocById('kdoc-1'));
    const shown = getComputedStyle(document.getElementById('kb-cancel')).display;
    if (shown === 'none') return 'the cancel button did not become visible while editing';

    // Put the editor back to "add" mode. `editingKnowledgeId` is module-level and outlives the
    // case that set it, so leaving an edit open made the NEXT test save an update instead of
    // an add — which surfaced as "the document was never sent", pointing at the wrong thing
    // entirely.
    startKnowledgeEdit(null);
    return true;
  } finally {
    page.restore();
  }
}

async function testAddingAFileSendsTheDocumentAndRefreshes() {
  const page = await loadOptionsPage();
  try {
    document.getElementById('kb-filename').value = 'books/new.md';
    document.getElementById('kb-content').value = '# New\n\n## Fact\n\nSomething.\n';
    document.getElementById('kb-save').click();
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (!page.sent.includes('ADD_KNOWLEDGE_DOCUMENT')) {
      return `the document was never sent (asked for: ${page.sent.join(', ')})`;
    }
    // The list is re-read after a mutation, so the user sees their own edit land.
    const adds = page.sent.filter((a) => a === 'ADD_KNOWLEDGE_DOCUMENT').length;
    if (page.sent.filter((a) => a === 'GET_KNOWLEDGE_DOCUMENTS').length < 2) {
      return `the list was not refreshed after the save (adds=${adds})`;
    }
    if (!/Saved/.test(text('kb-message') || '')) return `message="${text('kb-message')}"`;
    // The editor is cleared for the next file.
    if (document.getElementById('kb-filename').value !== '') return 'the filename field was not cleared';
    if (document.getElementById('kb-save').textContent !== 'Add file') {
      return `the button still says "${document.getElementById('kb-save').textContent}"`;
    }
    // Re-enabled, or a second file cannot be added without reloading the whole page.
    if (document.getElementById('kb-save').disabled) {
      return 'the save button stayed disabled after a successful save';
    }
    return true;
  } finally {
    page.restore();
  }
}

async function testARefusedAddExplainsWhy() {
  const page = await loadOptionsPage(makeResponses({
    ADD_KNOWLEDGE_DOCUMENT: {
      success: false, reason: 'DUPLICATE_FILENAME', error: 'A knowledge file with that filename already exists.'
    }
  }));
  try {
    document.getElementById('kb-filename').value = 'books/chemistry.md';
    document.getElementById('kb-content').value = '# Dup\n';
    document.getElementById('kb-save').click();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const message = text('kb-message') || '';
    // Keyed on the CODE, so the wording belongs to this page and can be improved without
    // touching the store.
    if (!/already exists/.test(message)) return `message="${message}"`;
    if (!/is-error/.test(klass('kb-message') || '')) return `class="${klass('kb-message')}"`;
    // The editor keeps what was typed: losing it means re-pasting a long file after a typo.
    if (document.getElementById('kb-content').value !== '# Dup\n') return 'the editor was cleared on failure';
    return true;
  } finally {
    page.restore();
  }
}

async function testTogglingEnableSendsAnUpdateWithNoContent() {
  const page = await loadOptionsPage();
  try {
    const { knowledgeDocById, toggleKnowledgeDocument } = await import('../../options/options.js');
    const doc = knowledgeDocById('kdoc-2');
    if (!doc) return 'the cache did not pick up the loaded list';
    await toggleKnowledgeDocument(doc.id, doc.enabled === false);
    await new Promise((resolve) => setTimeout(resolve, 150));

    if (!page.sent.includes('UPDATE_KNOWLEDGE_DOCUMENT')) return 'no update was sent';
    if (!/enabled/.test(text('kb-message') || '')) return `message="${text('kb-message')}"`;
    return true;
  } finally {
    page.restore();
  }
}

async function testEditingPrefillsAndSwitchesTheButton() {
  const page = await loadOptionsPage();
  try {
    const { startKnowledgeEdit, knowledgeDocById } = await import('../../options/options.js');
    const doc = knowledgeDocById('kdoc-1');
    if (!doc) return 'the cache did not pick up the loaded list';

    startKnowledgeEdit(doc);
    if (document.getElementById('kb-filename').value !== 'books/chemistry.md') return 'the filename was not prefilled';
    if (document.getElementById('kb-content').value !== doc.content) return 'the content was not prefilled';
    if (document.getElementById('kb-save').textContent !== 'Save changes') {
      return `the button still says "${document.getElementById('kb-save').textContent}"`;
    }
    if (document.getElementById('kb-cancel').hidden !== false) return 'the cancel button stayed hidden';

    startKnowledgeEdit(null);
    if (document.getElementById('kb-content').value !== '') return 'cancel did not clear the editor';
    if (document.getElementById('kb-cancel').hidden !== true) return 'cancel did not hide itself';
    return true;
  } finally {
    page.restore();
  }
}

export default async function runAllTests() {
  console.log('\n--- The real Options page ---');
  await runTest('The page loads without errors', testThePageLoadsWithoutErrors);
  await runTest('A ready index reads as up to date', testAReadyIndexReadsAsUpToDate);
  await runTest('An empty base is not an error', testAnEmptyBaseIsNotAnError);
  await runTest('A failed build shows the reason', testAFailedBuildShowsTheReasonAndIsTinted);
  await runTest('Saved-but-unindexed is not "no files"', testFilesSavedButNotIndexedAreNotReportedAsNoFiles);

  console.log('\n--- Document management (§4) ---');
  await runTest('The document list renders', testTheDocumentListRenders);
  await runTest('A filename is never markup', testADocumentNameIsNeverMarkup);
  await runTest('An empty base invites rather than apologises', testAnEmptyBaseShowsAnInvitationNotAnError);
  await runTest('The hidden cancel button is invisible', testTheHiddenCancelButtonIsActuallyInvisible);
  await runTest('Adding a file sends it and refreshes', testAddingAFileSendsTheDocumentAndRefreshes);
  await runTest('A refused add explains why', testARefusedAddExplainsWhy);
  await runTest('Toggling enable sends an update', testTogglingEnableSendsAnUpdateWithNoContent);
  await runTest('Editing prefills and switches the button', testEditingPrefillsAndSwitchesTheButton);

  console.log('\n--- Manual re-index ---');
  await runTest('A failure reason is never markup', testAFailureReasonIsNeverMarkup);
  await runTest('The reload button re-indexes', testTheReloadButtonAsksTheWorkerToReIndex);
  await runTest('A failed reload says so', testAFailedReloadSaysSoAndKeepsTheButtonUsable);
  await runTest('A dead worker degrades', testADeadWorkerDoesNotBreakThePage);

  console.log('\n--- The heart-filter switch ---');
  await runTest('The heart switch loads ticked on a fresh install', testTheHeartSwitchLoadsTickedOnAFreshInstall);
  await runTest('The heart switch loads the stored value', testTheHeartSwitchLoadsTheStoredValue);
  await runTest('Saving the heart switch resets nothing else', testTheHeartSwitchSavesWithoutResettingTheOtherReplySettings);

  console.log('\n--- The target-reply-hearting switch ---');
  await runTest('The target-reply-hearting switch loads unticked on fresh install', testTargetReplyHeartingLoadsUntickedOnFreshInstall);
  await runTest('The target-reply-hearting switch loads stored value', testTargetReplyHeartingLoadsStoredValue);
  await runTest('Toggling target-reply-hearting saves immediately', testTargetReplyHeartingTogglingSavesImmediately);
  await runTest('The target-reply-hearting switch syncs from external changes', testTargetReplyHeartingSyncsFromExternalChange);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}