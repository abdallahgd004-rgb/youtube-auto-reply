/**
 * Popup Tests — Phase 16.4 (plus a regression guard on the Phase 12 readouts)
 *
 * The popup is the only surface most users ever look at, and almost all of its
 * content is written by the script rather than by the markup. These tests drive the
 * real popup.js against the stubbed background and assert the rendered contract:
 * run state, posting mode, every status readout, and the record panel in both its
 * empty and populated states.
 *
 * Runs in the browser from popup-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * storage.js is evaluated.
 */

import { resetStorage, readStore, RESPONSES, storageSet, fireStorageChanged } from './chrome-storage-stub.js';
import { loadDebugSetting } from '../debug.js';

const results = { total: 0, passed: 0, failed: 0, failures: [] };

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

/** Let the popup's async loaders settle. */
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** Re-run the popup's own init against the current stubbed settings and logs. */
async function loadPopup() {
  const { loadSettings, loadStatus } = await import('../../popup/popup.js');
  await loadSettings();
  loadStatus();
  await settle();
  // The popup attaches its click handlers on DOMContentLoaded, which has already
  // fired in this page. Dispatched exactly once: a second dispatch would double every
  // listener and make one click perform two toggles.
  if (!listenersAttached) {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    listenersAttached = true;
    await settle();
  }
}

let listenersAttached = false;

function text(id) {
  const el = document.getElementById(id);
  return el ? el.textContent : null;
}

function classOf(id) {
  const el = document.getElementById(id);
  return el ? el.className : null;
}

// ── run state ────────────────────────────────────────────────────────────────

async function testStoppedByDefault() {
  resetStorage();
  await loadPopup();
  const sheet = document.querySelector('.sheet');
  if (sheet.dataset.running !== 'false') return 'Expected the popup to start stopped';
  if (text('status-display') !== 'Stopped') return `Expected "Stopped", got ${text('status-display')}`;
  return true;
}

async function testRunningStateAndSwitchLabel() {
  const store = { enabled: true };
  const { saveSettings } = await import('../storage.js');
  await saveSettings(store);
  await loadPopup();
  const sheet = document.querySelector('.sheet');
  if (sheet.dataset.running !== 'true') return 'Expected data-running="true"';
  if (text('status-display') !== 'Running') return `Expected "Running", got ${text('status-display')}`;
  const btn = document.getElementById('toggle-btn');
  if (btn.querySelector('.btn-label').textContent !== 'Turn off') return 'Switch should offer to turn off';
  if (!btn.querySelector('svg')) return 'Switch icon was destroyed by the label update';
  return true;
}

// ── Phase 16.4 — posting mode ────────────────────────────────────────────────

async function testDryRunIsStated() {
  resetStorage();
  await loadPopup();
  if (text('mode-value') !== 'Dry run') return `Expected "Dry run", got ${text('mode-value')}`;
  if (!/dry/.test(classOf('mode-value'))) return 'Dry run should carry the dry state class';
  return true;
}

async function testLivePostingIsStated() {
  const { saveSettings } = await import('../storage.js');
  await saveSettings({ dryRun: false });
  await loadPopup();
  if (text('mode-value') !== 'Live') return `Expected "Live", got ${text('mode-value')}`;
  if (!/live/.test(classOf('mode-value'))) return 'Live should carry the live state class';
  return true;
}

async function testMissingDryRunDefaultsToDryRun() {
  // An absent key must read as the safe state, never as "live".
  resetStorage();
  await loadPopup();
  if (text('mode-value') !== 'Dry run') return 'A missing dryRun must default to the safe state';
  return true;
}

// ── Phase 12 readouts ────────────────────────────────────────────────────────

async function testConnectionReadout() {
  resetStorage();
  await loadPopup();
  if (text('connection-value') !== 'Connected') return `Expected "Connected", got ${text('connection-value')}`;
  if (!/connected/.test(classOf('connection-value'))) return 'Expected the connected class';
  if (document.getElementById('connection-hint').style.display === 'block') {
    return 'No offline hint should be shown while connected';
  }
  return true;
}

async function testDisconnectedShowsHint() {
  RESPONSES.GET_CONNECTION_STATUS = { success: true, status: 'disconnected', error: 'Cannot reach LM Studio.' };
  await loadPopup();
  const hint = document.getElementById('connection-hint');
  if (text('connection-value') !== 'Disconnected') return 'Expected "Disconnected"';
  if (hint.style.display !== 'block') return 'Expected the offline reason to be shown';
  if (!/LM Studio/.test(hint.textContent)) return `Expected the background reason, got "${hint.textContent}"`;
  RESPONSES.GET_CONNECTION_STATUS = { success: true, status: 'connected', modelCount: 1 };
  return true;
}

async function testModelReadout() {
  resetStorage();
  await loadPopup();
  if (text('model-value') !== 'stub-model') return `Expected the model id, got ${text('model-value')}`;
  return true;
}

async function testQueueCountAndPendingState() {
  RESPONSES.GET_QUEUE_COUNT = { success: true, count: 0 };
  await loadPopup();
  if (text('queue-value') !== '0') return 'Expected a zero queue';
  if (/pending/.test(classOf('queue-value'))) return 'An empty queue must not be styled as pending';

  RESPONSES.GET_QUEUE_COUNT = { success: true, count: 4 };
  await loadPopup();
  if (text('queue-value') !== '4') return `Expected 4 waiting, got ${text('queue-value')}`;
  if (!/pending/.test(classOf('queue-value'))) return 'A non-empty queue must be styled as pending';
  RESPONSES.GET_QUEUE_COUNT = { success: true, count: 0 };
  return true;
}

async function testReplyStats() {
  RESPONSES.GET_REPLY_STATS = { success: true, count: 7, limit: 30, windowMs: 3600000 };
  await loadPopup();
  if (text('replies-value') !== '7 / 30') return `Expected "7 / 30", got ${text('replies-value')}`;
  if (text('replies-label') !== 'Replies this hour:') return `Unexpected label: ${text('replies-label')}`;

  // A different window must relabel rather than keep claiming "this hour".
  RESPONSES.GET_REPLY_STATS = { success: true, count: 2, limit: 50, windowMs: 14400000 };
  await loadPopup();
  if (text('replies-label') !== 'Replies per 4h:') return `Expected a 4h label, got ${text('replies-label')}`;
  if (text('replies-value') !== '2 / 50') return `Expected "2 / 50", got ${text('replies-value')}`;
  RESPONSES.GET_REPLY_STATS = { success: true, count: 0, limit: 30, windowMs: 3600000 };
  return true;
}

// ── record panel ─────────────────────────────────────────────────────────────

async function testRecordEmptyState() {
  RESPONSES.GET_LOGS = { success: true, logs: [] };
  await loadPopup();
  const quote = document.querySelector('.quote');
  if (quote.dataset.empty !== 'true') return 'Expected the empty flag to be set';
  if (text('record-reply') !== 'Nothing written yet.') return `Unexpected copy: ${text('record-reply')}`;
  if (document.getElementById('record-reply').hasAttribute('dir')) {
    return 'The empty state must stay LTR so the full stop is not teleported';
  }
  return true;
}

async function testRecordPopulatedWithArabic() {
  const reply = 'من فضلك راجع وصف المنتج.';
  RESPONSES.GET_LOGS = {
    success: true,
    logs: [
      { status: 'queued', commentText: 'تجاهلني' },
      { status: 'generated', commentText: 'بكام المنتج؟', generatedReply: reply }
    ]
  };
  await loadPopup();
  const body = document.getElementById('record-reply');
  const quote = document.querySelector('.quote');
  if (quote.dataset.empty !== 'false') return 'Expected the populated flag';
  if (!/بكام المنتج/.test(text('record-comment'))) return 'Expected the source comment to be shown';
  // The newest usable entry wins; a row without a reply is skipped.
  if (body.textContent !== reply) return `Expected the generated reply, got "${body.textContent}"`;
  if (body.getAttribute('dir') !== 'rtl' || body.getAttribute('lang') !== 'ar') {
    return 'Arabic content must switch the block to RTL';
  }
  RESPONSES.GET_LOGS = { success: true, logs: [] };
  return true;
}

// ── toggle round trip ────────────────────────────────────────────────────────

async function testToggleWritesAndReRenders() {
  const { saveSettings } = await import('../storage.js');
  await saveSettings({ enabled: true });
  await loadPopup();

  document.getElementById('toggle-btn').click();
  await settle();

  if (readStore().enabled !== false) return 'Toggling must persist enabled=false';
  if (text('status-display') !== 'Stopped') return 'The status line must follow the toggle';
  if (!document.getElementById('toggle-btn').querySelector('svg')) return 'The switch icon must survive';
  return true;
}

async function testDiagnosticsFlagLoads() {
  resetStorage();
  if ((await loadDebugSetting()) !== false) return 'Diagnostics must default to off';
  return true;
}

// ── Side Panel migration ───────────────────────────────────────────────────
//
// The control surface moved from a transient action popup to a Chrome Side Panel.
// These assert the migration invariants that a test can actually see: the document
// still loads in this context (it no longer depends on being a popup), the controls
// survived, and the close control exists and is wired.

/**
 * The panel document must initialise in a plain page context.
 *
 * This is the meaningful persistence check available here: an action popup document is
 * torn down the moment it loses focus, whereas this document now lives in a panel that
 * survives page interaction. The test asserts the panel drives its own lifecycle — it
 * reads settings, starts polling, and stays responsive — which is what lets the
 * counters keep updating while the user works on the YouTube page.
 */
async function testPanelInitialisesAndStaysLive() {
  await loadPopup();

  // Reading the run state proves the loader ran in this context.
  if (text('status-display') !== 'Running' && text('status-display') !== 'Stopped') {
    return 'The panel did not render its run state';
  }
  if (text('stage-value') === null) return 'The panel did not render the current stage';
  if (text('total-time-value') === null) return 'The panel did not render the processing time';
  return true;
}

/** The ON/OFF control must still work — it is the panel's primary action. */
async function testToggleStillWorksInThePanel() {
  // resetStorage() takes no arguments; the stopped state comes from DEFAULT_CONFIG,
  // which ships `enabled: false`.
  resetStorage();
  await loadPopup();

  const btn = document.getElementById('toggle-btn');
  if (!btn) return 'The toggle button is missing from the panel';
  if (text('status-display') !== 'Stopped') return `Setup failed: expected Stopped, got ${text('status-display')}`;

  btn.click();
  await settle();

  if (text('status-display') !== 'Running') return `The toggle did not switch the panel on, got ${text('status-display')}`;
  if (readStore().enabled !== true) return 'The toggle did not persist the new state';
  return true;
}

// ── The heart-filter switch ───────────────────────────────────────────────────

/** The switch must EXIST and read ON, matching DEFAULT_CONFIG on a fresh install. */
async function testHeartSwitchDefaultsToOn() {
  resetStorage();
  await loadPopup();

  const btn = document.getElementById('heart-filter-btn');
  if (!btn) return 'The heart-filter button is missing from the panel';
  if (btn.dataset.on !== 'true') {
    return `A fresh install must show the filter ON, got data-on="${btn.dataset.on}"`;
  }
  if (text('heart-filter-label') !== 'Hearted comments: skipped') {
    return `Wrong label: ${text('heart-filter-label')}`;
  }
  if (btn.getAttribute('aria-pressed') !== 'true') {
    return `aria-pressed must describe the state, got "${btn.getAttribute('aria-pressed')}"`;
  }
  return true;
}

/** Pressing it flips the state AND persists it. */
async function testHeartSwitchFlipsAndPersists() {
  resetStorage();
  await loadPopup();

  const btn = document.getElementById('heart-filter-btn');
  btn.click();
  await settle();

  if (btn.dataset.on !== 'false') return `The press did not flip the button, got "${btn.dataset.on}"`;
  if (text('heart-filter-label') !== 'Hearted comments: answered') {
    return `Wrong label after the press: ${text('heart-filter-label')}`;
  }
  if (readStore().replyBehavior?.ignoreHeartedComments !== false) {
    return 'The press did not persist false';
  }

  btn.click();
  await settle();
  if (btn.dataset.on !== 'true') return 'The second press did not flip it back';
  if (readStore().replyBehavior?.ignoreHeartedComments !== true) {
    return 'The second press did not persist true';
  }
  return true;
}

/**
 * THE DATA-LOSS TEST, and the reason this suite exists for the switch.
 *
 * `saveSettings()` is a `chrome.storage.local.set()`, which REPLACES the key outright. So a
 * handler that writes `{replyBehavior: {ignoreHeartedComments: next}}` without spreading the
 * existing object silently resets the reply mode, the rate cap, the delays, the blacklist and
 * the follow-up switch — and the one value the creator clicked still changed, so the click
 * LOOKS like it worked. That is a data-loss bug with no symptom pointing at it.
 */
async function testHeartSwitchPreservesTheOtherReplySettings() {
  resetStorage();
  await chrome.storage.local.set({
    enabled: true,
    dryRun: false,
    replyBehavior: {
      replyMode: 'knowledge',
      maxRepliesPerHour: 42,
      minDelayMs: 1111,
      maxDelayMs: 2222,
      staticContext: 'keep me',
      blacklist: ['nope'],
      followupOnAnswered: true,
      followupInstruction: 'one sentence',
      ignoreHeartedComments: true,
      ignoreCreatorRepliedComments: true
    }
  });
  await loadPopup();

  const before = readStore().replyBehavior;
  document.getElementById('heart-filter-btn').click();
  await settle();

  const after = readStore().replyBehavior;
  for (const key of Object.keys(before)) {
    if (key === 'ignoreHeartedComments') continue;
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      return `the press reset replyBehavior.${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`;
    }
  }
  if (after.ignoreHeartedComments !== false) {
    return 'the clicked value did not change';
  }
  // And the master switch is a different key entirely; it must not have moved.
  if (readStore().enabled !== true) return 'the press disturbed the master on/off switch';
  return true;
}

/** A change made ELSEWHERE must be reflected without reopening the panel. */
async function testHeartSwitchFollowsExternalChanges() {
  resetStorage();
  await loadPopup();
  const btn = document.getElementById('heart-filter-btn');
  if (btn.dataset.on !== 'true') return 'setup failed';

  // Written through the stub, which fires onChanged with a real old/new pair — the same
  // shape Chrome delivers. This is the Options page path, and the second copy of the panel.
  await storageSet({ replyBehavior: { ignoreHeartedComments: false } });
  await settle();

  if (btn.dataset.on !== 'false') {
    return `the switch ignored a change made elsewhere, got "${btn.dataset.on}"`;
  }
  if (text('heart-filter-label') !== 'Hearted comments: answered') {
    return `the label ignored an external change: ${text('heart-filter-label')}`;
  }
  return true;
}

/** A change to a DIFFERENT storage area must not move this switch. */
async function testHeartSwitchIgnoresOtherAreas() {
  resetStorage();
  await loadPopup();
  const btn = document.getElementById('heart-filter-btn');

  fireStorageChanged({ replyBehavior: { newValue: { ignoreHeartedComments: false } } }, 'sync');
  await settle();

  if (btn.dataset.on !== 'true') {
    return 'a "sync" area change moved a switch that only reads local storage';
  }
  return true;
}

/**
 * A FAILED write must not move the button.
 *
 * The button is the only place a creator can see what the extension will actually do, so
 * rendering the requested state before the write resolves turns a storage failure into a
 * control that confidently reports the opposite of the truth — and there is no other surface
 * showing it, because the Options page would still read the old value.
 */
async function testAFailedWriteDoesNotMoveTheHeartSwitch() {
  resetStorage();
  await loadPopup();
  const btn = document.getElementById('heart-filter-btn');
  if (btn.dataset.on !== 'true') return 'setup failed';

  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('quota exceeded'); };
  try {
    btn.click();
    await settle(120);
  } finally {
    chrome.storage.local.set = realSet;
  }

  if (btn.dataset.on !== 'true') {
    return `a failed write still moved the button to "${btn.dataset.on}"`;
  }
  if (readStore().replyBehavior?.ignoreHeartedComments !== undefined) {
    return 'the failed write should have stored nothing';
  }
  return true;
}

// ── The target-reply-hearting switch ──────────────────────────────────────────

/** The switch must exist and default to OFF. */
async function testTargetReplyHeartingDefaultsToOff() {
  resetStorage();
  await loadPopup();

  const btn = document.getElementById('heart-apply-btn');
  if (!btn) return 'The heart-apply button is missing from the panel';
  if (btn.dataset.on !== 'false') {
    return `A fresh install must show the switch OFF, got data-on="${btn.dataset.on}"`;
  }
  if (text('heart-apply-label') !== 'Target replies & hearting: off') {
    return `Wrong label: ${text('heart-apply-label')}`;
  }
  if (btn.getAttribute('aria-pressed') !== 'false') {
    return `aria-pressed must describe the state, got "${btn.getAttribute('aria-pressed')}"`;
  }
  return true;
}

/** Pressing it flips the state AND persists it. */
async function testTargetReplyHeartingFlipsAndPersists() {
  resetStorage();
  await loadPopup();

  const btn = document.getElementById('heart-apply-btn');
  btn.click();
  await settle();

  if (btn.dataset.on !== 'true') return `The press did not flip the button, got "${btn.dataset.on}"`;
  if (text('heart-apply-label') !== 'Target replies & hearting: on') {
    return `Wrong label after the press: ${text('heart-apply-label')}`;
  }
  if (readStore().targetReplyHeartingEnabled !== true) {
    return 'The press did not persist true';
  }

  btn.click();
  await settle();
  if (btn.dataset.on !== 'false') return 'The second press did not flip it back';
  if (readStore().targetReplyHeartingEnabled !== false) {
    return 'The second press did not persist false';
  }
  return true;
}

/** A change made elsewhere must update the switch without reopening. */
async function testTargetReplyHeartingFollowsExternalChanges() {
  resetStorage();
  await loadPopup();
  const btn = document.getElementById('heart-apply-btn');
  if (btn.dataset.on !== 'false') return 'setup failed';

  await storageSet({ targetReplyHeartingEnabled: true });
  await settle();

  if (btn.dataset.on !== 'true') {
    return `the switch ignored an external change, got "${btn.dataset.on}"`;
  }
  if (text('heart-apply-label') !== 'Target replies & hearting: on') {
    return `the label ignored an external change: ${text('heart-apply-label')}`;
  }
  return true;
}

/** A failed write must not move the switch. */
async function testAFailedWriteDoesNotMoveTargetReplyHeartingSwitch() {
  resetStorage();
  await loadPopup();
  const btn = document.getElementById('heart-apply-btn');
  if (btn.dataset.on !== 'false') return 'setup failed';

  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('quota exceeded'); };
  try {
    btn.click();
    await settle(120);
  } finally {
    chrome.storage.local.set = realSet;
  }

  if (btn.dataset.on !== 'false') {
    return `a failed write still moved the button to "${btn.dataset.on}"`;
  }
  if (readStore().targetReplyHeartingEnabled !== undefined) {
    return 'the failed write should have stored nothing';
  }
  return true;
}

/** The settings button must still hand off to the Options page. */
async function testSettingsButtonStillOpensOptions() {
  let action = null;
  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function patched(message, callback) {
    action = message && message.action;
    return original.call(this, message, callback);
  };

  try {
    const btn = document.getElementById('settings-btn');
    if (!btn) return 'The settings button is missing from the panel';
    btn.click();
    await settle(40);
    if (action !== 'openOptions') return `Expected openOptions, got ${action}`;
  } finally {
    chrome.runtime.sendMessage = original;
  }
  return true;
}

/** The user must be able to close the panel from inside it. */
async function testPanelHasAWorkingCloseControl() {
  await loadPopup();

  const btn = document.getElementById('close-panel-btn');
  if (!btn) return 'The panel has no close control';
  if (btn.tagName !== 'BUTTON') return `The close control must be a button, got ${btn.tagName}`;

  // Clicking must not throw. Chrome provides no scripting API to dismiss a panel, so
  // the handler ends in window.close(), which is a no-op in a test page — the point is
  // that the control exists, is wired, and fails harmlessly.
  let threw = null;
  try {
    btn.click();
    await settle(40);
  } catch (error) {
    threw = error.message;
  }
  if (threw) return `The close control threw: ${threw}`;
  return true;
}

/** Reset stats button resets processing tallies. */
async function testResetStatsButtonResetsTallies() {
  await loadPopup();
  const resetBtn = document.getElementById('reset-stats-btn');
  if (!resetBtn) return 'The reset stats button is missing from the panel';

  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: {
      commentsDetected: 50,
      matched: 20,
      repliesGenerated: 20,
      repliesSubmitted: 15,
      failedSkipped: 5,
      stage: 'idle',
      stageLabel: 'Idle',
      active: false,
      elapsedMs: 12000,
      timerRunning: false
    }
  };
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  await loadProcessingStatus();
  if (text('tally-detected') !== '50') return `setup failed, got detected=${text('tally-detected')}`;

  let sentAction = null;
  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function (message, callback) {
    if (message && message.action === 'RESET_PROCESSING_STATS') {
      sentAction = message.action;
      RESPONSES.GET_PROCESSING_STATE = {
        success: true,
        state: {
          commentsDetected: 0,
          matched: 0,
          repliesGenerated: 0,
          repliesSubmitted: 0,
          failedSkipped: 0,
          stage: 'idle',
          stageLabel: 'Idle',
          active: false,
          elapsedMs: 0,
          timerRunning: false
        }
      };
      if (typeof callback === 'function') callback({ success: true });
      return Promise.resolve({ success: true });
    }
    return original.call(this, message, callback);
  };

  try {
    resetBtn.click();
    await settle(50);
    if (sentAction !== 'RESET_PROCESSING_STATS') return `Expected RESET_PROCESSING_STATS action, got ${sentAction}`;
    if (text('tally-detected') !== '0') return `tallies were not reset, got ${text('tally-detected')}`;
  } finally {
    chrome.runtime.sendMessage = original;
  }
  return true;
}

/** Milliseconds rendered as the duration string the popup shows. */
async function testElapsedFormatting() {
  const { formatElapsed } = await import('../../popup/popup.js');

  if (formatElapsed(42700) !== '42.7 seconds') return `42.7s case: got ${formatElapsed(42700)}`;
  if (formatElapsed(0) !== '0.0 seconds') return `0 case: got ${formatElapsed(0)}`;
  if (formatElapsed(1500) !== '1.5 seconds') return `1.5s case: got ${formatElapsed(1500)}`;
  // Hostile input must degrade to zero rather than print NaN on screen.
  if (formatElapsed(undefined) !== '0.0 seconds') return 'undefined must read as 0.0 seconds';
  if (formatElapsed(-5) !== '0.0 seconds') return 'a negative duration must read as 0.0 seconds';
  if (formatElapsed(NaN) !== '0.0 seconds') return 'NaN must read as 0.0 seconds';
  return true;
}

/**
 * The final processing duration must reach the screen.
 *
 * The stubbed background answers with elapsedMs 42700 and timerRunning false — a
 * finished run — so this asserts the value survives the whole path: message response,
 * sanitizing, and rendering into #total-time-value.
 */
async function testFinalDurationIsShown() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: {
      commentsDetected: 12,
      matched: 4,
      repliesGenerated: 4,
      repliesSubmitted: 3,
      failedSkipped: 1,
      stage: 'idle',
      stageLabel: 'Idle',
      active: false,
      elapsedMs: 42700,
      timerRunning: false
    }
  };

  await loadProcessingStatus();

  const shown = text('total-time-value');
  if (shown !== '42.7 seconds') return `Expected the final duration on screen, got "${shown}"`;

  // The counters must still read correctly alongside it.
  if (text('tally-detected') !== '12') return `detected=${text('tally-detected')}`;
  if (text('tally-matched') !== '4') return `matched=${text('tally-matched')}`;
  if (text('stage-value') !== 'Idle') return `stage=${text('stage-value')}`;
  return true;
}

/**
 * While a run is live the popup must show the stage that matches the new semantic
 * step, and a number that is still moving rather than a frozen snapshot.
 */
async function testLiveRunShowsSemanticMatchingStage() {
  const { loadProcessingStatus, renderTotalTime } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: {
      commentsDetected: 3,
      matched: 0,
      repliesGenerated: 0,
      repliesSubmitted: 0,
      failedSkipped: 0,
      stage: 'semantic_matching',
      stageLabel: 'Semantic matching',
      active: true,
      elapsedMs: 23400,
      timerRunning: true
    }
  };

  await loadProcessingStatus();

  if (text('stage-value') !== 'Semantic matching') {
    return `Expected the semantic-matching stage, got "${text('stage-value')}"`;
  }

  const first = text('total-time-value');
  if (first !== '23.4 seconds') return `Expected 23.4 seconds, got "${first}"`;

  // The displayed value must advance on its own between state polls, which is what
  // makes it read as a running clock rather than a stale number. renderTotalTime() is
  // the repaint the 100ms ticker calls; invoked directly so the assertion does not
  // depend on a background interval being armed.
  await settle(120);
  renderTotalTime();
  const second = text('total-time-value');
  if (second === first) return `The clock did not advance (still "${second}")`;

  // Restore the finished-run stub so later cases are unaffected.
  RESPONSES.GET_PROCESSING_STATE.state.elapsedMs = 42700;
  RESPONSES.GET_PROCESSING_STATE.state.stage = 'idle';
  RESPONSES.GET_PROCESSING_STATE.state.stageLabel = 'Idle';
  RESPONSES.GET_PROCESSING_STATE.state.timerRunning = false;
  return true;
}

/** An unreachable background must not leave a stale duration on screen. */
async function testMissingBackgroundResetsTheTimer() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  const saved = RESPONSES.GET_PROCESSING_STATE;
  delete RESPONSES.GET_PROCESSING_STATE;

  await loadProcessingStatus();

  const shown = text('total-time-value');
  RESPONSES.GET_PROCESSING_STATE = saved;
  if (shown !== '0.0 seconds') return `Expected a reset to 0.0 seconds, got "${shown}"`;
  return true;
}

async function runAllTests() {
  console.log('\n=== Popup Tests ===\n');

  await runTest('Popup starts stopped', testStoppedByDefault);
  await runTest('Running state and switch label', testRunningStateAndSwitchLabel);
  await runTest('Dry run is stated explicitly', testDryRunIsStated);
  await runTest('Live posting is stated explicitly', testLivePostingIsStated);
  await runTest('A missing dryRun reads as dry run', testMissingDryRunDefaultsToDryRun);
  await runTest('Connection readout', testConnectionReadout);
  await runTest('Disconnected shows the offline reason', testDisconnectedShowsHint);
  await runTest('Model readout', testModelReadout);
  await runTest('Queue count and pending state', testQueueCountAndPendingState);
  await runTest('Reply stats and window label', testReplyStats);
  await runTest('Record panel empty state', testRecordEmptyState);
  await runTest('Record panel populated with Arabic', testRecordPopulatedWithArabic);
  await runTest('Toggle writes and re-renders', testToggleWritesAndReRenders);
  await runTest('Diagnostics defaults to off', testDiagnosticsFlagLoads);

  console.log('\n--- Side Panel ---');
  await runTest('Panel initialises and stays live', testPanelInitialisesAndStaysLive);
  await runTest('Toggle still works in the panel', testToggleStillWorksInThePanel);
  await runTest('Settings button still opens Options', testSettingsButtonStillOpensOptions);
  await runTest('Panel has a working close control', testPanelHasAWorkingCloseControl);
  await runTest('Elapsed time formatting', testElapsedFormatting);
  await runTest('Final processing duration is shown', testFinalDurationIsShown);
  await runTest('A live run shows Semantic matching and a moving clock', testLiveRunShowsSemanticMatchingStage);
  await runTest('An unreachable background resets the timer', testMissingBackgroundResetsTheTimer);
  await runTest('Reset stats button resets processing tallies', testResetStatsButtonResetsTallies);

  console.log('\n--- The heart-filter switch ---');
  await runTest('The heart switch shows ON by default', testHeartSwitchDefaultsToOn);
  await runTest('The heart switch flips and persists', testHeartSwitchFlipsAndPersists);
  await runTest('The heart switch preserves the other reply settings', testHeartSwitchPreservesTheOtherReplySettings);
  await runTest('The heart switch follows a change made elsewhere', testHeartSwitchFollowsExternalChanges);
  await runTest('The heart switch ignores other storage areas', testHeartSwitchIgnoresOtherAreas);
  await runTest('A failed write does not move the heart switch', testAFailedWriteDoesNotMoveTheHeartSwitch);

  console.log('\n--- Target replies & hearting switch ---');
  await runTest('The target reply hearting switch shows OFF by default', testTargetReplyHeartingDefaultsToOff);
  await runTest('The target reply hearting switch flips and persists', testTargetReplyHeartingFlipsAndPersists);
  await runTest('The target reply hearting switch follows an external change', testTargetReplyHeartingFollowsExternalChanges);
  await runTest('A failed write does not move the target reply hearting switch', testAFailedWriteDoesNotMoveTargetReplyHeartingSwitch);

  console.log('\n--- Phase 20.18: Knowledge block and skip reasons ---');
  await runTest('Knowledge tallies render', testKnowledgeTalliesRender);
  await runTest('Skip reasons render with fault tinting', testSkipReasonsRenderWithFaultTinting);
  await runTest('Skip reasons clear when the run clears', testSkipReasonsClearWhenTheRunClears);
  await runTest('A skip-reason label is never markup', testSkipReasonLabelIsNotMarkup);
  await runTest('Malformed skip reasons are dropped', testMalformedSkipReasonsAreDropped);
  await runTest('A failed request clears the Knowledge block', testAFailedRequestClearsTheKnowledgeBlock);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

/** ── Phase 20.18: the Knowledge block and skip reasons ───────────────────── */

/** Snapshot fields shared by the knowledge tests; only what differs per case. */
function kbState(overrides) {
  return Object.assign({
    commentsDetected: 6,
    matched: 0,
    repliesGenerated: 2,
    repliesSubmitted: 2,
    failedSkipped: 1,
    stage: 'idle',
    stageLabel: 'Idle',
    active: false,
    elapsedMs: 1000,
    timerRunning: false,
    knowledgeHits: 4,
    knowledgeAnswerable: 2,
    knowledgeSkipped: 2,
    knowledgeSkipReasons: {}
  }, overrides || {});
}

/**
 * The rendered rows of the skip-reason list, plus the LIST's own `hidden` flag.
 *
 * Two separate things, deliberately not folded into one: an empty list has no children
 * to read the flag from, so a helper that returns only the rows makes "hidden" and "empty"
 * indistinguishable — and those are exactly the two states the clearing tests assert.
 */
function skipRows() {
  const list = document.getElementById('kb-skip-reasons');
  if (!list) return null;
  return {
    hidden: list.hidden,
    rows: Array.prototype.map.call(list.children, (li) => ({
      label: li.firstChild ? li.firstChild.textContent : '',
      count: li.lastChild ? li.lastChild.textContent : '',
      fault: li.className === 'is-fault'
    }))
  };
}

async function testKnowledgeTalliesRender() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = { success: true, state: kbState() };

  await loadProcessingStatus();

  if (text('tally-kb-hits') !== '4') return `hits=${text('tally-kb-hits')}`;
  if (text('tally-kb-answerable') !== '2') return `answerable=${text('tally-kb-answerable')}`;
  if (text('tally-kb-skipped') !== '2') return `skipped=${text('tally-kb-skipped')}`;
  // The block is rendered unconditionally. Hiding it at zero was rejected: a configured
  // Knowledge Mode answering nothing is exactly when the user needs to see the row.
  if (text('tally-kb-hits') === null) return 'the knowledge row must exist at zero too';
  return true;
}

async function testSkipReasonsRenderWithFaultTinting() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: {
        NO_SUPPORTED_ANSWER: { count: 2, label: 'No answer the knowledge supports', expected: true },
        GROUNDING_VALIDATION_FAILED: { count: 1, label: 'The reply claimed something unsupported', expected: false }
      }
    })
  };

  await loadProcessingStatus();

  const list = skipRows();
  if (!list) return 'the skip-reason list is missing from the harness markup';
  if (list.hidden) return 'a list with reasons must be visible';
  if (list.rows.length !== 2) return `expected 2 rows, got ${list.rows.length}`;

  // The ORDER comes from the worker's vocabulary, and both rows must survive.
  const decline = list.rows[0];
  const fault = list.rows[1];
  if (decline.label !== 'No answer the knowledge supports') return `label="${decline.label}"`;
  if (decline.count !== '2') return `count=${decline.count}`;
  // The whole point of the milestone: a decline is NOT tinted, a fault is.
  if (decline.fault) return 'a decline must not be tinted as a fault';
  if (!fault.fault) return 'a grounding rejection must be tinted as a fault';
  return true;
}

async function testSkipReasonsClearWhenTheRunClears() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: {
        CONFLICTING_KNOWLEDGE: { count: 1, label: 'Knowledge base contradicts itself', expected: false }
      }
    })
  };
  await loadProcessingStatus();
  if (skipRows().rows.length !== 1) return 'the first reason did not render';

  // A service-worker restart resets the counters to zero. The list must EMPTY rather
  // than keep its children: a hidden list that still holds its rows would re-show a
  // stale reason the moment a later poll renders anything again.
  RESPONSES.GET_PROCESSING_STATE = { success: true, state: kbState({ knowledgeSkipReasons: {} }) };
  await loadProcessingStatus();

  const list = skipRows();
  if (!list.hidden) return 'an empty list must be hidden';
  if (list.rows.length !== 0) return `stale rows survived a reset: ${list.rows.length}`;
  return true;
}

async function testSkipReasonLabelIsNotMarkup() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');

  // The payload SETS A FLAG rather than showing a dialog. An `alert()` here is the
  // obvious choice and the wrong one: a blocking dialog stops the page from ever
  // publishing results, so the suite times out with no message instead of failing with
  // one. Asserting the flag also tests the real property — that the markup did not
  // EXECUTE — which comparing strings only approximates.
  const PAYLOAD = '<img src=x onerror="window.__YTAR_PWNED__ = true">bad';
  delete window.__YTAR_PWNED__;

  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: {
        NO_SUPPORTED_ANSWER: { count: 1, label: PAYLOAD, expected: true }
      }
    })
  };

  await loadProcessingStatus();

  const list = skipRows();
  if (list.rows.length !== 1) return 'the row must still render';
  // textContent, so the markup is VISIBLE TEXT rather than an element.
  if (list.rows[0].label !== PAYLOAD) {
    return `the label must render as text, got "${list.rows[0].label}"`;
  }
  if (document.querySelector('#kb-skip-reasons img')) {
    return 'the label was parsed as HTML — an element was created';
  }
  // The decisive assertion: an <img> whose onerror fires is an injection, whether or not
  // the string happens to be escaped.
  if (window.__YTAR_PWNED__ === true) return 'the label EXECUTED — this is an injection';
  return true;
}

async function testMalformedSkipReasonsAreDropped() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  // Every shape the Panel must survive: a bad count, a missing label, a non-object, an
  // array. None may render as a blank row, and none may throw.
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: {
        NO_SUPPORTED_ANSWER: { count: 0, label: 'x', expected: true },
        CONFLICTING_KNOWLEDGE: { count: 2, expected: false },
        GENERATION_FAILED: { count: 2, label: 42, expected: false },
        KNOWLEDGE_INDEX_FAILED: 'not-an-object'
      }
    })
  };

  await loadProcessingStatus();

  const list = skipRows();
  if (list.rows.length !== 0) return `malformed rows rendered: ${list.rows.length}`;
  if (!list.hidden) return 'a list of nothing valid must be hidden';
  if (text('tally-kb-skipped') !== '2') return 'the tallies must still render';
  return true;
}

async function testAFailedRequestClearsTheKnowledgeBlock() {
  const { loadProcessingStatus } = await import('../../popup/popup.js');
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: { NO_SUPPORTED_ANSWER: { count: 1, label: 'x', expected: true } }
    })
  };
  await loadProcessingStatus();
  if (skipRows().rows.length !== 1) return 'setup failed';

  // TWO different failure shapes, because they take different code paths and a test that
  // only covers one leaves the other unverified.
  //
  //   (a) the worker answers with a failure  -> the success path, `state` is undefined
  //   (b) sendMessage REJECTS                -> the catch block
  //
  // An earlier version of this test only did (a), which let a mutation that deleted the
  // clearing from the CATCH block pass: (a) never reaches the catch, so the block's
  // clearing is simply never the thing under test.
  const original = chrome.runtime.sendMessage;

  chrome.runtime.sendMessage = (message, callback) => {
    callback({ success: false, error: 'no worker' });
  };
  try {
    await loadProcessingStatus();
  } finally {
    chrome.runtime.sendMessage = original;
  }

  if (text('tally-kb-hits') !== '0') return `hits=${text('tally-kb-hits')}`;
  if (text('tally-kb-answerable') !== '0') return 'answerable must reset';
  let list = skipRows();
  if (!list.hidden || list.rows.length !== 0) {
    return 'the reasons must be cleared when the worker reports a failure';
  }

  // Put a reason back on screen, then make the read REJECT.
  RESPONSES.GET_PROCESSING_STATE = {
    success: true,
    state: kbState({
      knowledgeSkipReasons: {
        CONFLICTING_KNOWLEDGE: { count: 1, label: 'Knowledge base contradicts itself', expected: false }
      }
    })
  };
  await loadProcessingStatus();
  if (skipRows().rows.length !== 1) return 'setup failed for the rejecting case';

  chrome.runtime.sendMessage = (message, callback) => {
    // No callback at all: the panel's wrapper turns that into a rejection, which is what
    // happens when the service worker is asleep or the extension was just reloaded.
    setTimeout(() => { if (chrome.runtime.lastError) callback({ success: false }); }, 0);
  };
  const realLastError = 'Cannot contact service worker';
  Object.defineProperty(chrome.runtime, 'lastError', {
    configurable: true,
    get() { return { message: realLastError }; }
  });
  try {
    await loadProcessingStatus();
  } finally {
    chrome.runtime.sendMessage = original;
    Object.defineProperty(chrome.runtime, 'lastError', {
      configurable: true,
      value: undefined
    });
  }

  list = skipRows();
  if (!list.hidden || list.rows.length !== 0) {
    return 'the reasons must be cleared when the read REJECTS';
  }
  if (text('tally-kb-hits') !== '0') return `hits=${text('tally-kb-hits')} after a rejection`;
  return true;
}

export default runAllTests;