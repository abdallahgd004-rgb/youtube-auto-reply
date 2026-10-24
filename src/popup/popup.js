// Control Panel Script - YouTube Auto Reply Extension
// Task 1.3: Popup UI + Task 2.4: Storage Binding
// Task 12.1: real ON/OFF state + 12.2 connection + 12.3 model + 12.4 queue + 12.5 replies
//
// This document is rendered as a Chrome SIDE PANEL (manifest `side_panel`), not as
// the transient action popup. Chrome closes an action popup the moment focus moves
// to the page, which made it impossible to watch a run while working on YouTube.
// The side panel stays open across page interaction, so the polling started below
// now runs for as long as the user keeps the panel open — which is exactly what
// the live counters need.
//
// Design pass: the record panel at the top surfaces the last reply the machine wrote
// (Phase 11 GET_LOGS, already exposed and previously unused by any UI). Read-only.

import { getSettings, saveSettings } from '../core/storage.js';
import { debugLog, logError, loadDebugSetting, YTAR_DEVLOG, DEV_LOG_COMPONENT as C, DEV_LOG_LEVEL as L } from '../core/debug.js';

// The panel's own initialisation is timed, because "the panel opened but is blank" and
// "the panel never loaded" are different problems and must be distinguishable in the
// service-worker log.
const panelInit = YTAR_DEVLOG.startTimer({
  component: C.SIDEPANEL,
  event: 'SIDEPANEL_INIT',
  endEvent: 'SIDEPANEL_INIT_SUCCESS',
  errorEvent: 'SIDEPANEL_INIT_ERROR',
  data: {
    hasSidePanelApi: !!(chrome.sidePanel && typeof chrome.sidePanel.getOptions === 'function'),
    panelDocumentUrl: location.pathname.split('/').pop()
  }
});

YTAR_DEVLOG.log({
  component: C.SIDEPANEL,
  event: 'SIDEPANEL_INIT_START',
  level: L.DEBUG,
  data: { context: 'side_panel', isSidePanel: !!chrome.sidePanel }
});

debugLog('Popup opened');

let currentEnabled = false;

/**
 * The heart-filter switch, mirrored from the stored setting.
 *
 * Holds the state the button shows, so a press knows what to flip TO without re-reading
 * storage for the current value. It is never treated as authoritative — every write reads the
 * stored value again and re-renders from what storage confirms.
 */
let heartFilterEnabled = true;
// Phase 23.1 — the heart-APPLYING switch. A SEPARATE module-level value, not a second field
// of the filter's, because the two are independent policies with opposite defaults: one skips
// comments you already hearted (on), the other adds a heart to comments it drafts (off).
// Sharing one variable would make them impossible to set independently.
let heartApplyEnabled = false;
let repliedFilterEnabled = true;

/**
 * Reflect the running state on the sheet as a data attribute.
 *
 * The stylesheet uses this for the state swatch and for inverting the switch, so the
 * markup stays declarative and there is exactly one source of truth for "is it on".
 *
 * @param {boolean} enabled
 */
function applyRunState(enabled) {
  const sheet = document.querySelector('.sheet');
  if (sheet) sheet.dataset.running = enabled ? 'true' : 'false';
}

/**
 * Write the running/stopped word and the matching switch label.
 *
 * The button names the action it performs — "Turn on" while stopped — rather than
 * showing the current state a second time, so the label and the press agree.
 *
 * @param {boolean} enabled
 */
function renderRunState(enabled) {
  setText('status-display', enabled ? 'Running' : 'Stopped');
  setButtonLabel(document.getElementById('toggle-btn'), enabled ? 'Turn off' : 'Turn on');
  applyRunState(enabled);
}

/**
 * Write a button label without destroying the icon inside it.
 *
 * Assigning `textContent` wipes every child, so the power glyph in the switch
 * would vanish the first time the state was re-rendered.
 *
 * @param {Element|null} btn
 * @param {string} text
 */
function setButtonLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (label) {
    label.textContent = text;
  } else {
    btn.textContent = text;
  }
}

/**
 * Send a message to the background and resolve with its response.
 *
 * Rejects on a channel error or a missing response so callers can fall back to a
 * neutral display instead of showing a stale or invented value.
 *
 * @param {string} action
 * @returns {Promise<Object>} the background response
 */
function sendMessage(action) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error('chrome.runtime not available'));
      return;
    }
    // One pair of entries per panel → worker call. This is the trace that proves the
    // two contexts are talking; without it a silent failure here looks identical to a
    // worker that is simply asleep.
    const messageTimer = YTAR_DEVLOG.startTimer({
      component: C.SIDEPANEL,
      event: 'SIDEPANEL_MESSAGE',
      endEvent: 'SIDEPANEL_MESSAGE_SENT',
      errorEvent: 'SIDEPANEL_MESSAGE_ERROR',
      data: { action }
    });
    chrome.runtime.sendMessage({ action: action }, (response) => {
      if (chrome.runtime.lastError) {
        const error = new Error(chrome.runtime.lastError.message);
        messageTimer.fail(error, { action, lastError: error.message });
        reject(error);
        return;
      }
      if (!response) {
        messageTimer.fail(null, { action, reason: 'no response from background' });
        reject(new Error('No response from background'));
        return;
      }
      messageTimer.done({ action, success: response.success === true });
      resolve(response);
    });
  });
}

/**
 * Write text into an element if it exists.
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * Task 12.2 connection status + Task 13.1 offline reason.
 *
 * Renders Connected / Disconnected, and falls back to Unknown whenever the status
 * cannot be determined (request still pending, or the channel failed).
 *
 * Task 13.1: when disconnected it also shows the clear reason supplied by the
 * background (e.g. "Cannot connect to LM Studio.") instead of leaving the user with a
 * bare red "Disconnected" and no explanation.
 */
async function loadConnectionStatus() {
  const el = document.getElementById('connection-value');
  const hint = document.getElementById('connection-hint');
  const apply = (label, state, reason) => {
    if (el) { el.textContent = label; el.className = 'detail-value ' + state; }
    if (hint) {
      if (reason) {
        hint.textContent = reason;
        hint.style.display = 'block';
      } else {
        hint.textContent = '';
        hint.style.display = 'none';
      }
    }
  };
  try {
    const res = await sendMessage('GET_CONNECTION_STATUS');
    const connected = res && res.status === 'connected';
    apply(connected ? 'Connected' : 'Disconnected', connected ? 'connected' : 'disconnected',
      connected ? '' : ((res && res.error) || ''));
  } catch (_) {
    apply('Unknown', 'unknown', '');
  }
}

/**
 * Task 12.3 — the currently configured model name.
 */
async function loadModel() {
  try {
    const res = await sendMessage('GET_CURRENT_MODEL');
    const model = (res && res.model) || '';
    setText('model-value', model || 'Not set');
  } catch (_) {
    setText('model-value', 'Unknown');
  }
}

/**
 * Task 12.4 — number of replies waiting in the queue.
 */
async function loadQueueCount() {
  try {
    const res = await sendMessage('GET_QUEUE_COUNT');
    const count = res && typeof res.count === 'number' ? res.count : 0;
    setText('queue-value', String(count));
    // Colour only when there is genuinely something waiting.
    const el = document.getElementById('queue-value');
    if (el) el.className = 'detail-value' + (count > 0 ? ' pending' : '');
  } catch (_) {
    setText('queue-value', '?');
    const el = document.getElementById('queue-value');
    if (el) el.className = 'detail-value unknown';
  }
}

/**
 * Task 12.5 — replies used against the enforced cap.
 *
 * The background reports the window it actually enforces (the rate limiter's rolling
 * hour), so the label is rewritten to match rather than claiming a daily figure.
 */
async function loadReplyStats() {
  try {
    const res = await sendMessage('GET_REPLY_STATS');
    const count = res && typeof res.count === 'number' ? res.count : 0;
    const limit = res && typeof res.limit === 'number' ? res.limit : 0;
    const windowMs = res && typeof res.windowMs === 'number' ? res.windowMs : 0;

    const labelEl = document.getElementById('replies-label');
    if (labelEl && windowMs > 0) {
      const hours = windowMs / (60 * 60 * 1000);
      labelEl.textContent = hours === 1 ? 'Replies this hour:' : `Replies per ${hours}h:`;
    }
    setText('replies-value', limit > 0 ? `${count} / ${limit}` : `${count}`);
  } catch (_) {
    setText('replies-value', '?');
  }
}

/**
 * The record panel — the last reply the machine wrote to a real person.
 *
 * Reads the Phase 11 activity log, which the background already exposes as GET_LOGS.
 * The newest entry that actually carries a generated reply wins; queued/matched/failed
 * rows are skipped because they have nothing to show yet.
 *
 * Dry run never writes a `published` row, so this panel is always "written", never
 * "posted" — the wording in the markup is deliberate and must not be changed to
 * imply a reply was published.
 *
 * Failures are swallowed and the panel keeps its empty state: a missing record must
 * never stop the status readouts from loading.
 */
async function loadRecord() {
  const body = document.getElementById('record-reply');
  const src = document.getElementById('record-comment');
  const quote = document.querySelector('.quote');

  const showEmpty = () => {
    if (quote) quote.dataset.empty = 'true';
    if (body) {
      body.textContent = 'Nothing written yet.';
      // English chrome in an RTL block renders with the full stop teleported to the
      // front, so the direction has to come off with the content.
      body.removeAttribute('dir');
      body.removeAttribute('lang');
    }
    if (src) src.textContent = '\u2014';
  };
  try {
    const res = await sendMessage('GET_LOGS');
    const logs = res && Array.isArray(res.logs) ? res.logs : [];
    // Logs are appended in chronological order, so scan from the end.
    let entry = null;
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i] && typeof logs[i].generatedReply === 'string' && logs[i].generatedReply.trim()) {
        entry = logs[i];
        break;
      }
    }
    if (!entry) {
      showEmpty();
      return;
    }
    if (quote) quote.dataset.empty = 'false';
    if (body) {
      body.textContent = entry.generatedReply.trim();
      body.setAttribute('dir', 'rtl');
      body.setAttribute('lang', 'ar');
    }
    if (src) {
      src.textContent = (entry.commentText && String(entry.commentText).trim()) || '\u2014';
    }
  } catch (_) {
    showEmpty();
  }
}

/**
 * Phase 20.18 — the Knowledge skip-reason breakdown.
 *
 * Built with `createElement`/`textContent`, never `innerHTML`: the labels arrive from
 * the worker over `chrome.runtime.sendMessage`, and a future label containing an angle
 * bracket must render as that character rather than as markup.
 *
 * The list is emptied by REPLACING its children rather than by deleting only the rows
 * this poll added. A panel that hides itself with `hidden` keeps its previous children,
 * so a run whose last reason disappeared would otherwise keep showing a stale reason
 * underneath a hidden list — and un-hiding it on the next poll would bring the old
 * reason straight back.
 *
 * @param {Object<string, {count:number, label:string, expected:boolean}>} reasons
 */
function renderSkipReasons(reasons) {
  const list = document.getElementById('kb-skip-reasons');
  if (!list) return;

  // Local, not the closure in loadProcessingStatus: that one is not in scope here, and
  // reaching for it would make this function depend on a caller it does not have.
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) ? Math.floor(value) : 0;

  while (list.firstChild) list.removeChild(list.firstChild);

  const entries =
    reasons && typeof reasons === 'object' && !Array.isArray(reasons)
      ? Object.keys(reasons).map((code) => ({ code, value: reasons[code] }))
      : [];

  const shown = entries.filter(({ value }) =>
    value && typeof value === 'object' && typeof value.label === 'string' && num(value.count) > 0);

  // Nothing happened, so say nothing. A list of zeroes is noise, and the tally above
  // already reads 0.
  list.hidden = shown.length === 0;
  if (shown.length === 0) return;

  for (const { code, value } of shown) {
    const li = document.createElement('li');
    // Tinted only when the OWNER decided this was a fault. The Panel never re-derives
    // it: `expected` is §24's classification, and a second comparison here would be a
    // second answer to it that could disagree with the counter the worker is drawing.
    if (value.expected !== true) li.className = 'is-fault';

    const label = document.createElement('span');
    label.textContent = value.label;
    // The code is the stable handle a user can quote in a bug report, and it is what the
    // 20.24 diagnostics will key on. Kept as a title rather than visible text so the row
    // stays readable at 11px.
    li.title = code;

    const count = document.createElement('span');
    count.className = 'skip-reason-count';
    count.textContent = String(num(value.count));

    li.appendChild(label);
    li.appendChild(count);
    list.appendChild(li);
  }
}

/**
 * Processing status — counters plus the current stage, from GET_PROCESSING_STATE.
 *
 * Every value falls back to a safe default rather than being left blank or showing
 * `NaN`: after a service-worker restart the background has no counters yet and answers
 * with zeros and `idle`, and a failed request must look the same rather than implying
 * the extension is mid-run.
 */
/**
 * Phase 22.1 — the LAST decline, with the reason and the files that were offered.
 *
 * This exists because the counter above it answers a different question. "Declined by the
 * base: 1" is a run summary; the question behind it is always "why did THIS one not get an
 * answer", and the answer lives in two things the counter does not carry: the gate's own
 * words, and which files it was shown. Those are what tell a user whether their chemistry
 * file was never retrieved, or was retrieved and did not contain the price.
 *
 * Built with `createElement`/`textContent`, never `innerHTML`. The reason is model output
 * and the comment preview is a viewer's comment — a comment containing `<img onerror=…>`
 * must render as that character, not as an element.
 *
 * @param {Array<Object>|null} samples
 */
function renderLastDecline(samples) {
  const box = document.getElementById('kb-last-decline');
  if (!box) return;

  while (box.firstChild) box.removeChild(box.firstChild);

  const list = Array.isArray(samples) ? samples : [];
  const last = list.length > 0 ? list[list.length - 1] : null;

  // Nothing declined in this run. Says nothing, for the same reason the reason list does:
  // a panel that explains nothing went wrong is as noisy as one that hides what did.
  if (!last) {
    box.hidden = true;
    return;
  }

  const heading = document.createElement('p');
  heading.className = 'tallies-caption';
  heading.textContent = 'Why the last one got no reply';
  box.appendChild(heading);

  if (last.intent) {
    const intent = document.createElement('p');
    intent.className = 'kb-decline-files';
    intent.textContent = `What the model understood the comment as: ${last.intent}`;
    box.appendChild(intent);
  }

  if (last.commentPreview) {
    const comment = document.createElement('p');
    comment.className = 'kb-decline-comment';
    comment.dir = 'rtl';
    comment.lang = 'ar';
    comment.textContent = last.commentPreview;
    box.appendChild(comment);
  }

  if (last.reason) {
    const reason = document.createElement('p');
    reason.className = 'kb-decline-reason';
    reason.textContent = last.reason;
    box.appendChild(reason);
  }

  if (Array.isArray(last.filenames) && last.filenames.length > 0) {
    const files = document.createElement('p');
    files.className = 'kb-decline-files';
    files.textContent = 'Files it was shown: ' + last.filenames.join(', ');
    box.appendChild(files);
  }

  // Retrieved vs offered vs dropped. This is the line that separates "your knowledge base
  // does not answer this" from "the answering section was cut before the model could see
  // it" — the gate can only ever report on what it was given, and a price buried in a long
  // chapter is dropped on the way to the prompt.
  // −1 means "this stage did not report a count", which is different from a real zero.
  // The two existing `num` helpers in this file both fold 0 into 0 and negatives into 0,
  // which would render a not-reported count as a confident "shown to the model: 0".
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : -1;

  const retrieved = count(last.retrievedCount);
  const offered = count(last.offeredCount);
  const dropped = count(last.droppedCount);

  if (offered >= 0 || dropped > 0) {
    const counts = document.createElement('p');
    counts.className = 'kb-decline-files';
    if (retrieved >= 0 && offered >= 0) {
      counts.textContent = `Sections retrieved: ${retrieved} · shown to the model: ${offered}`;
    } else if (offered >= 0) {
      counts.textContent = `Sections shown to the model: ${offered}`;
    }
    if (dropped > 0) {
      counts.textContent += ` · DROPPED before the model saw them: ${dropped}`;
    }
    box.appendChild(counts);

    if (dropped > 0) {
      const warn = document.createElement('p');
      warn.className = 'kb-decline-files kb-decline-dropped';
      warn.textContent =
        'A section is dropped when it is longer than 600 characters or when it is crowded out ' +
        'of the shortlist. If the answer is inside a long chapter, it never reaches the ' +
        'check — put the price in a short section of its own.';
      box.appendChild(warn);
    }
  }

  // What was offered to the reranker, before it discarded them.
  //
  // Shown whenever retrieval came back with nothing, and NOT conditioned on
  // `offered === 0`: `offeredCount` is the size of the SHORTLIST the reranker was given,
  // so it is 12 on exactly the run that needs explaining most — the one where twelve
  // candidates were handed over and the model discarded every one. The first version of
  // this block gated on `offered === 0`, which is true only for the "no section could be
  // shortlisted" exit, so the interesting case rendered nothing.
  const shortlist = Array.isArray(last.shortlist) ? last.shortlist : [];
  if (shortlist.length > 0 && retrieved === 0) {
    const heading = document.createElement('p');
    heading.className = 'kb-decline-files';
    heading.textContent = 'Sections it was offered before deciding:';
    box.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'kb-decline-list';
    for (const entry of shortlist) {
      if (!entry || typeof entry !== 'object') continue;
      const item = document.createElement('li');
      const chars = typeof entry.chars === 'number' && Number.isFinite(entry.chars) ? entry.chars : -1;
      const size = chars >= 0 ? ` (${chars} chars)` : '';
      item.textContent = `${entry.filename || '(unnamed)'} — ${entry.heading || '(no heading)'}${size}`;
      // Over the gate's 600-character ceiling is the number that explains a missing price,
      // so it is the one section that gets called out rather than left for the user to add.
      if (chars > 600) item.className = 'is-oversized';
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  box.hidden = false;
}

async function loadProcessingStatus() {
  const section = document.querySelector('.processing');
  const setTally = (id, value) => setText(id, String(value));

  try {
    const res = await sendMessage('GET_PROCESSING_STATE');
    const s = (res && res.state) || {};
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) ? Math.floor(value) : 0;

    const detected = num(s.commentsDetected);
    const matched = num(s.matched);
    const generated = num(s.repliesGenerated);
    const submitted = num(s.repliesSubmitted);
    const failed = num(s.failedSkipped);

    setTally('tally-detected', detected);
    setTally('tally-matched', matched);
    setTally('tally-generated', generated);
    setTally('tally-submitted', submitted);
    setTally('tally-failed', failed);

    // Only the failure tally is tinted, and only when something actually failed.
    const failedEl = document.getElementById('tally-failed');
    if (failedEl) failedEl.className = 'tally-value' + (failed > 0 ? ' is-failed' : '');

    // Phase 20.18 — the Knowledge block. Rendered unconditionally, at zero included:
    // "matched 0" in Knowledge Mode is not a report of success, it is the counter that
    // does not apply, and the row that explains why is the whole reason this block
    // exists.
    setTally('tally-kb-hits', num(s.knowledgeHits));
    setTally('tally-kb-answerable', num(s.knowledgeAnswerable));
    setTally('tally-kb-skipped', num(s.knowledgeSkipped));
    renderSkipReasons(s.knowledgeSkipReasons);
    renderLastDecline(s.knowledgeSkipSamples);

    // The stage label comes from the background so the wording lives in one place;
    // the local default is the same one the background uses when nothing is running.
    const stage = typeof s.stage === 'string' && s.stage ? s.stage : 'idle';
    const label = typeof s.stageLabel === 'string' && s.stageLabel ? s.stageLabel : 'Idle';
    setText('stage-value', label);
    if (section) section.dataset.stage = stage;

    // Re-anchor the run timer on every snapshot. A new run needs no special case here:
    // the background restarts its measurement from zero, so the next snapshot simply
    // carries a smaller elapsed time and replaces the anchor.
    timeAnchor = {
      elapsedMs: num(s.elapsedMs),
      receivedAt: performance.now(),
      running: s.timerRunning === true,
    };
    renderTotalTime();
  } catch (_) {
    setTally('tally-detected', 0);
    setTally('tally-matched', 0);
    setTally('tally-generated', 0);
    setTally('tally-submitted', 0);
    setTally('tally-failed', 0);
    setTally('tally-kb-hits', 0);
    setTally('tally-kb-answerable', 0);
    setTally('tally-kb-skipped', 0);
    renderSkipReasons(null);
    renderLastDecline(null);
    setText('stage-value', 'Idle');
    if (section) section.dataset.stage = 'idle';
    timeAnchor = { elapsedMs: 0, receivedAt: performance.now(), running: false };
    renderTotalTime();
  }
}

/**
 * Poll the processing status while the panel is open.
 *
 * A Side Panel persists across page interaction, so this interval now runs for as long
 * as the user keeps the panel open — that is the point of the migration, and it is
 * what lets the counters and the run timer stay live while the user works on YouTube.
 *
 * The teardown below is still correct and still needed: it stops the poll when the
 * panel is closed or its tab is hidden, so a discarded document cannot keep waking up
 * once a second forever. 1s is fast enough to feel live during the 8-20s reply delays
 * without being a busy loop.
 */
function startProcessingPolling() {
  const POLL_MS = 1000;
  // The state poll is 1s, but the clock should not tick once per second. This
  // re-paints only the total-time row between polls, from the local anchor, so it
  // costs no extra messages to the background.
  const TICK_MS = 100;

  let timer = null;
  let tick = null;
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };
  const start = () => {
    if (timer === null) {
      timer = setInterval(loadProcessingStatus, POLL_MS);
    }
    if (tick === null) {
      tick = setInterval(renderTotalTime, TICK_MS);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else {
      // Re-read immediately on show: the popup may have been hidden for minutes.
      loadProcessingStatus();
      start();
    }
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('unload', stop);

  start();
}

/**
 * Local mirror of the background's run timer.
 *
 * The background sends `elapsedMs` only when it is polled, but a 1s poll would make a
 * running timer jump in whole seconds. So the snapshot is treated as an anchor
 * (`elapsedMs` + the local moment it arrived) and the displayed value is interpolated
 * locally between polls. The background stays the single source of truth for whether
 * the run is still going; this only smooths what it already reported.
 */
let timeAnchor = { elapsedMs: 0, receivedAt: 0, running: false };

/**
 * Format a duration in milliseconds as seconds with one decimal.
 *
 * @param {number} ms
 * @returns {string} e.g. "42.7 seconds"
 */
function formatElapsed(ms) {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  return (value / 1000).toFixed(1) + ' seconds';
}

/**
 * Paint the total-time row.
 *
 * While the run is live the elapsed time is the anchored snapshot plus however long has
 * passed locally since it arrived. Once the run has ended the anchor is final, so the
 * last measured duration stays on screen until a new run reports a new one.
 */
function renderTotalTime() {
  const el = document.getElementById('total-time-value');
  if (!el) return;

  const drift = timeAnchor.running ? Math.max(0, performance.now() - timeAnchor.receivedAt) : 0;
  el.textContent = formatElapsed(timeAnchor.elapsedMs + drift);
}

/**
 * Load every Phase 12 status readout.
 *
 * Each loader is independent and swallows its own error, so one unavailable value can
 * never blank the rest of the popup.
 */
function loadStatus() {
  loadConnectionStatus();
  loadModel();
  loadQueueCount();
  loadReplyStats();
  loadRecord();
  loadProcessingStatus();
}

/**
 * Show whether replies are actually being published (Phase 16.4).
 *
 * The ON/OFF switch says the machine is running; it does not say whether the dry-run
 * gate is holding the replies back. Without this line a user can watch "Running" and
 * reasonably assume replies are going out when nothing is being posted at all.
 *
 * @param {Object} settings
 */
function renderPostingMode(settings) {
  const el = document.getElementById('mode-value');
  if (!el) return;
  const dryRun = settings?.dryRun !== false;
  el.textContent = dryRun ? 'Dry run' : 'Live';
  el.className = 'detail-value ' + (dryRun ? 'dry' : 'live');
}

/**
 * The channel owner's heart switch.
 *
 * Mirrors `getSettings()`'s default rather than hardcoding `true`: the panel and the extension
 * must agree on what "unset" means, and if DEFAULT_CONFIG ever flips, a second literal here is
 * the thing that silently disagrees. Read as `!== false` for the same reason the Options
 * checkbox is — a stored "false" STRING must not read as on.
 *
 * @param {boolean} on
 */
function renderHeartFilterState(on) {
  const btn = document.getElementById('heart-filter-btn');
  if (btn) {
    btn.dataset.on = on ? 'true' : 'false';
    // aria-pressed names what the button does, so it says the same thing the label does.
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  setText('heart-filter-label', on ? 'Hearted comments: skipped' : 'Hearted comments: answered');
}

/**
 * The "skip comments already replied to by creator" switch.
 *
 * @param {boolean} on
 */
function renderRepliedFilterState(on) {
  const btn = document.getElementById('replied-filter-btn');
  if (btn) {
    btn.dataset.on = on ? 'true' : 'false';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  setText('replied-filter-label', on ? 'Answered comments: skipped' : 'Answered comments: answered');
}

/**
 * The "heart comments after drafting" switch.
 *
 * `=== true` — the OPPOSITE of the filter above, and that is not an inconsistency. That
 * setting defaults ON, so "unset" must read as on; this one defaults OFF, so anything that
 * is not an explicit boolean `true` must read as off. Both derive from what `getSettings()`
 * reports, which is `DEFAULT_CONFIG` merged over storage — so neither hardcodes a default that
 * could drift from the one the worker enforces.
 *
 * @param {boolean} on
 */
function renderHeartApplyState(on) {
  const btn = document.getElementById('heart-apply-btn');
  if (btn) {
    btn.dataset.on = on ? 'true' : 'false';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  setText('heart-apply-label', on ? 'Target replies & hearting: on' : 'Target replies & hearting: off');
}

/**
 * Load settings and update the UI.
 */
async function loadSettings() {
  try {
    const settings = await getSettings();
    currentEnabled = settings.enabled ?? false;
    heartFilterEnabled = (settings.replyBehavior?.ignoreHeartedComments ?? true) !== false;
    repliedFilterEnabled = (settings.replyBehavior?.ignoreCreatorRepliedComments ?? true) !== false;
    heartApplyEnabled = settings.targetReplyHeartingEnabled === true;

    // Update status display
    renderRunState(currentEnabled);
    renderHeartFilterState(heartFilterEnabled);
    renderRepliedFilterState(repliedFilterEnabled);
    renderHeartApplyState(heartApplyEnabled);
    renderPostingMode(settings);

  } catch (error) {
    logError('Error loading settings:', error);
    // On error, default to stopped for safety
    currentEnabled = false;
    heartApplyEnabled = false;
    repliedFilterEnabled = true;
    renderRunState(currentEnabled);
    renderRepliedFilterState(repliedFilterEnabled);
    renderHeartApplyState(heartApplyEnabled);
  }
}

/**
 * Handle the heart-filter button click.
 *
 * The save SPREADS the existing replyBehavior rather than replacing it. `saveSettings()` does a
 * `chrome.storage.local.set()`, which replaces the key wholesale, so writing only
 * `{ignoreHeartedComments}` would silently reset the reply mode, the rate cap, the delays and
 * the follow-up switch. That is a data-loss bug that looks like a successful click, and it is
 * the same trap `...existingReply` already guards in options.js.
 */
async function handleHeartFilterToggle() {
  const timer = YTAR_DEVLOG.startTimer({
    component: C.POPUP,
    event: 'HEART_FILTER_TOGGLE',
    endEvent: 'HEART_FILTER_TOGGLE_SUCCESS',
    errorEvent: 'HEART_FILTER_TOGGLE_ERROR',
    data: { from: heartFilterEnabled }
  });
  try {
    const settings = await getSettings();
    const existingReply = settings.replyBehavior || {};
    const next = !heartFilterEnabled;

    await saveSettings({
      replyBehavior: { ...existingReply, ignoreHeartedComments: next }
    });
    heartFilterEnabled = next;

    // Rendered from the confirmed value only AFTER the write resolves. The button never
    // optimistically shows what was asked for — a failed write that still moved the label is
    // a control that lies about the extension's behaviour.
    renderHeartFilterState(heartFilterEnabled);
    timer.done({ to: next });
  } catch (error) {
    logError('Error saving the heart filter setting:', error);
    timer.fail(error, { from: heartFilterEnabled });
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) {
      errorMessageEl.textContent = 'Error: Could not save setting';
      errorMessageEl.style.display = 'block';
    }
  }
}

/**
 * Handle the replied-filter button click.
 */
async function handleRepliedFilterToggle() {
  const timer = YTAR_DEVLOG.startTimer({
    component: C.POPUP,
    event: 'REPLIED_FILTER_TOGGLE',
    endEvent: 'REPLIED_FILTER_TOGGLE_SUCCESS',
    errorEvent: 'REPLIED_FILTER_TOGGLE_ERROR',
    data: { from: repliedFilterEnabled }
  });
  try {
    const settings = await getSettings();
    const existingReply = settings.replyBehavior || {};
    const next = !repliedFilterEnabled;
    await saveSettings({
      replyBehavior: {
        ...existingReply,
        ignoreCreatorRepliedComments: next
      }
    });
    repliedFilterEnabled = next;

    renderRepliedFilterState(repliedFilterEnabled);
    timer.done({ to: next });
  } catch (error) {
    logError('Error saving the answered comment filter setting:', error);
    timer.fail(error, { from: repliedFilterEnabled });
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) {
      errorMessageEl.textContent = 'Error: Could not save setting';
      errorMessageEl.style.display = 'block';
    }
  }
}

/**
 * Handle the target-reply-hearting button click.
 */
async function handleHeartApplyToggle() {
  const timer = YTAR_DEVLOG.startTimer({
    component: C.POPUP,
    event: 'HEART_APPLY_TOGGLE',
    endEvent: 'HEART_APPLY_TOGGLE_SUCCESS',
    errorEvent: 'HEART_APPLY_TOGGLE_ERROR',
    data: { from: heartApplyEnabled }
  });
  try {
    const next = !heartApplyEnabled;
    await saveSettings({ targetReplyHeartingEnabled: next });
    heartApplyEnabled = next;

    // Rendered from the confirmed value only AFTER the write resolves. The button never
    // optimistically shows what was asked for — a failed write that still moved the label is
    // a control that lies about the extension's behaviour.
    renderHeartApplyState(heartApplyEnabled);
    timer.done({ to: next });
  } catch (error) {
    logError('Error saving the target reply hearting setting:', error);
    timer.fail(error, { from: heartApplyEnabled });
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) {
      errorMessageEl.textContent = 'Error: Could not save setting';
      errorMessageEl.style.display = 'block';
    }
  }
}

/**
 * Handle toggle button click.
 */
async function handleToggle() {
  const toggleTimer = YTAR_DEVLOG.startTimer({
    component: C.POPUP,
    event: 'POPUP_TOGGLE',
    endEvent: 'POPUP_TOGGLE_SUCCESS',
    errorEvent: 'POPUP_TOGGLE_ERROR',
    data: { from: currentEnabled }
  });
  try {
    const newEnabled = !currentEnabled;
    await saveSettings({ enabled: newEnabled });
    currentEnabled = newEnabled;
    
    // Update the running state immediately after the write resolves
    renderRunState(currentEnabled);
    toggleTimer.done({ to: newEnabled });

    // Queue/reply counters move as a result of switching, so refresh them.
    loadQueueCount();
    loadReplyStats();
    loadProcessingStatus();
  } catch (error) {
    logError('Error saving settings:', error);
    toggleTimer.fail(error, { from: currentEnabled });
    // Show error state but don't block the UI
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) {
      errorMessageEl.textContent = 'Error: Could not save setting';
      errorMessageEl.style.display = 'block';
    }
  }
}

/**
 * Handle settings button click - open options page.
 */
function handleSettings() {
  chrome.runtime.sendMessage({ action: 'openOptions' });
}

/**
 * Close this Side Panel.
 *
 * There is no scripting API to close a panel on the user's behalf —
 * `chrome.sidePanel` can open and configure panels but cannot dismiss one, so this
 * button hides the panel window for this tab via the same mechanism Chrome's own
 * close control uses. If that is unavailable the panel is simply left open, which
 * is the safe outcome: the user can always close it with Chrome's native control.
 */
function handleClosePanel() {
  try {
    if (typeof window.close === 'function') {
      window.close();
      return;
    }
  } catch (_) {
    // Fall through: window.close() is a no-op in some panel contexts.
  }
  debugWarn('close requested; leaving the panel to Chrome\'s own close control');
}

// Initialize on DOM ready
/**
 * Phase 22 — the follow-up board: comments the creator has already answered.
 *
 * NOTHING HERE POSTS. Every control either asks the model for a draft or copies one. The
 * creator's reply stays theirs, which is the entire premise of the feature; a panel button
 * that published would be a different feature and a much more dangerous one.
 *
 * `textContent` throughout, never `innerHTML`: these strings are the viewer's comment and
 * the model's draft, and a comment containing `<img onerror=…>` must render as that
 * character rather than becoming an element.
 */

let followupEnabled = false;
let followupBusy = false;

/**
 * Say something about the follow-up board.
 *
 * Its OWN line, not `#error-message`. That line belongs to the extension's settings and
 * toggle, and a message about a draft would sit there looking like the extension had failed
 * to save — a warning about the thing the creator just chose to do, filed under the thing
 * that might be broken.
 *
 * @param {string} message - '' clears it
 */
function setFollowupNote(message) {
  const hint = document.getElementById('followup-hint');
  if (!hint) return;
  const text = String(message || '').trim();
  if (!text) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }
  hint.hidden = false;
  hint.textContent = text;
}

/** Poll the board on the same cadence as the processing counters. */
const FOLLOWUP_POLL_MS = 4000;
let followupTimer = null;

/**
 * Ask the worker for the board and repaint it.
 * @returns {Promise<void>}
 */
async function loadFollowups(options = {}) {
  const list = document.getElementById('followup-list');
  const section = document.getElementById('followup-section');
  if (!list || !section) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({ action: 'GET_ANSWERED_COMMENTS' });
  } catch (error) {
    logError('Could not load the follow-up list:', error);
    return;
  }

  followupEnabled = Boolean(response && response.enabled);

  // Hidden whenever the feature is off, INCLUDING when the worker reports an error and
  // `enabled` is therefore false. A stale list outliving the decision to stop is the one
  // state this feature must never be in.
  section.hidden = !followupEnabled;
  if (!followupEnabled) {
    while (list.firstChild) list.removeChild(list.firstChild);
    document.getElementById('followup-actions').hidden = true;
    return;
  }

  const comments = Array.isArray(response.comments) ? response.comments : [];
  const count = document.getElementById('followup-count');
  if (count) count.textContent = String(comments.length);

  // A note written by an action the creator just took survives this repaint; the poll does
  // not clear it, because polling every few seconds would otherwise wipe it immediately.
  const hint = document.getElementById('followup-hint');
  if (hint && !options.keepNote) {
    if (comments.length === 0) {
      hint.hidden = false;
      hint.textContent =
        'Nothing yet. Open a video and scroll its comments — threads where you have already ' +
        'replied show up here. Collapsed threads are opened automatically, so scroll a little ' +
        'and wait a second.';
    } else {
      hint.hidden = true;
    }
  }

  document.getElementById('followup-actions').hidden = comments.length === 0;

  // Replaced, not appended-to: a list that only ever grows shows the same thread twice the
  // moment the page re-renders, and the creator has no way to tell which copy is current.
  while (list.firstChild) list.removeChild(list.firstChild);

  for (const entry of comments) {
    list.appendChild(buildFollowupRow(entry));
  }
}

/**
 * One row: the viewer's comment, the creator's existing reply, and the controls.
 * @param {Object} entry
 * @returns {HTMLLIElement}
 */
function buildFollowupRow(entry) {
  const li = document.createElement('li');
  li.className = 'followup-item';

  const body = document.createElement('div');
  body.className = 'followup-body';
  body.dir = 'rtl';
  body.lang = 'ar';

  const who = document.createElement('div');
  who.className = 'quote-src';
  who.textContent = entry.author || 'مشاهد';

  const said = document.createElement('div');
  said.className = 'quote-body';
  said.textContent = entry.text || '';

  body.appendChild(who);
  body.appendChild(said);

  const ownerReplies = (Array.isArray(entry.replies) ? entry.replies : []).filter((r) => r && r.isOwner);
  if (ownerReplies.length > 0) {
    const mine = document.createElement('div');
    mine.className = 'followup-mine';
    mine.textContent = 'رديت أنت: ' + ownerReplies[0].text;
    body.appendChild(mine);
  }

  li.appendChild(body);

  const controls = document.createElement('div');
  controls.className = 'followup-controls';

  const draftBtn = document.createElement('button');
  draftBtn.className = 'btn btn-quiet';
  draftBtn.type = 'button';
  draftBtn.textContent = entry.draft ? 'Show draft' : 'اقترح رد';
  draftBtn.disabled = followupBusy;
  draftBtn.addEventListener('click', () => handleFollowupDraft(entry, draftBtn));
  controls.appendChild(draftBtn);

  if (entry.draft) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-quiet';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => handleFollowupCopy(entry, copyBtn));
    controls.appendChild(copyBtn);

    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn btn-quiet';
    doneBtn.type = 'button';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => handleFollowupDismiss(entry));
    controls.appendChild(doneBtn);
  }

  li.appendChild(controls);

  if (entry.reason) {
    const reason = document.createElement('div');
    reason.className = 'hint';
    reason.textContent = entry.reason;
    li.appendChild(reason);
  }

  return li;
}

/**
 * Ask the model for a follow-up draft on one thread.
 *
 * The button is disabled for the duration rather than guarded with a flag at the top: two
 * clicks reaching the worker cost two model calls and the second result would overwrite the
 * first, which is the shape of the duplicate-reply problem this feature exists to avoid.
 *
 * @param {Object} entry
 * @param {HTMLElement} button
 */
async function handleFollowupDraft(entry, button) {
  if (followupBusy) return;
  followupBusy = true;
  const original = button.textContent;
  button.textContent = 'Working…';
  button.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'DRAFT_FOLLOWUP',
      data: { fingerprint: entry.fingerprint }
    });

    if (!response || !response.success) {
      setFollowupNote(response && response.error ? response.error : 'could not write a draft');
      return;
    }
    if (!response.needsFollowup) {
      // The model decided the existing reply was complete and the worker dropped the entry.
      // Say so, rather than leaving a vanished row looking like a silent failure.
      setFollowupNote('الرد الموجود كافٍ — اتشال من القائمة');
      await loadFollowups({ keepNote: true });
      return;
    }
    setFollowupNote(
      response.similarToDraft
        ? 'فيه مسودة شبه دي بالتعليق التاني — راجع الاتنين قبل ما ترد'
        : ''
    );
    await loadFollowups({ keepNote: true });
  } catch (error) {
    logError('Follow-up draft failed:', error);
    setFollowupNote('could not reach LM Studio');
  } finally {
    followupBusy = false;
    if (button.isConnected) {
      button.textContent = original;
      button.disabled = false;
    }
  }
}

/**
 * Copy a draft to the clipboard, so the creator can paste it wherever they reply.
 *
 * A clipboard write is offered rather than a DOM click on purpose: opening YouTube's own
 * reply box from the panel means reaching across into a tab, re-finding a comment node that
 * may have scrolled away, and driving an editor — for a feature whose whole point is that
 * the reply is the creator's.
 *
 * @param {Object} entry
 * @param {HTMLElement} button
 */
async function handleFollowupCopy(entry, button) {
  try {
    await navigator.clipboard.writeText(entry.draft || '');
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 1500);
  } catch (error) {
    logError('Follow-up copy failed:', error);
    setFollowupNote('the browser refused clipboard access — copy the text by hand');
  }
}

/**
 * Remove a thread from the board — the creator has replied to it.
 * @param {Object} entry
 */
async function handleFollowupDismiss(entry) {
  try {
    await chrome.runtime.sendMessage({
      action: 'DISMISS_FOLLOWUP',
      data: { fingerprint: entry.fingerprint }
    });
    await loadFollowups();
  } catch (error) {
    logError('Follow-up dismiss failed:', error);
  }
}

function startFollowupPolling() {
  if (followupTimer !== null) return;
  followupTimer = setInterval(() => {
    // Stop polling entirely while the panel is hidden; an open board nobody is looking at
    // is a worker message per interval for no reason.
    if (!document.hidden) loadFollowups();
  }, FOLLOWUP_POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadFollowups();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  debugLog('Popup ready');
  
  // Phase 18.3 — gate this context's diagnostics behind the user's flag.
  loadDebugSetting();

  // Load current settings (this also updates the button label)
  loadSettings();

  // Task 12.2-12.5 status readouts
  loadStatus();

  // Processing counters and stage change while the panel is open, so they are polled.
  startProcessingPolling();
  
  // Attach toggle button handler
  const toggleBtn = document.getElementById('toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', handleToggle);
  }

  // The heart-filter switch.
  const heartBtn = document.getElementById('heart-filter-btn');
  if (heartBtn) {
    heartBtn.addEventListener('click', handleHeartFilterToggle);
  }

  // The replied-filter switch.
  const repliedBtn = document.getElementById('replied-filter-btn');
  if (repliedBtn) {
    repliedBtn.addEventListener('click', handleRepliedFilterToggle);
  }

  // Phase 23.1 — the target-reply-hearting switch.
  const heartApplyBtn = document.getElementById('heart-apply-btn');
  if (heartApplyBtn) {
    heartApplyBtn.addEventListener('click', handleHeartApplyToggle);
  }

  // Processing tallies reset button
  const resetStatsBtn = document.getElementById('reset-stats-btn');
  if (resetStatsBtn) {
    resetStatsBtn.addEventListener('click', async () => {
      try {
        await sendMessage('RESET_PROCESSING_STATS');
        await loadProcessingStatus();
      } catch (err) {
        logError('Could not reset processing stats:', err);
      }
    });
  }

  // Keep the switch honest when it is changed from ELSEWHERE — the Options page, or a second
  // copy of this panel. Event-driven rather than folded into the one-second processing poll,
  // which would mean a `chrome.storage.local.get` every second for a boolean that changes
  // perhaps once a month.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.replyBehavior) {
      const nextHeart = (changes.replyBehavior.newValue || {}).ignoreHeartedComments ?? true;
      heartFilterEnabled = nextHeart !== false;
      renderHeartFilterState(heartFilterEnabled);

      const nextReplied = (changes.replyBehavior.newValue || {}).ignoreCreatorRepliedComments ?? true;
      repliedFilterEnabled = nextReplied !== false;
      renderRepliedFilterState(repliedFilterEnabled);
    }
    if (changes.targetReplyHeartingEnabled) {
      const nextApply = changes.targetReplyHeartingEnabled.newValue === true;
      heartApplyEnabled = nextApply;
      renderHeartApplyState(heartApplyEnabled);
    }
  });
  
  // Attach settings button handler
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', handleSettings);
  }

  // Attach the Side Panel's own close control
  const closeBtn = document.getElementById('close-panel-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', handleClosePanel);
  }

  // Phase 22: the follow-up board. Polling starts unconditionally and each tick asks the
  // worker whether the feature is on — a panel that cannot know the toggle's state must not
  // assume it, and polling a hidden section costs one message per interval.
  const followupRefresh = document.getElementById('followup-refresh-btn');
  if (followupRefresh) {
    followupRefresh.addEventListener('click', () => { loadFollowups(); });
  }
  const followupClear = document.getElementById('followup-clear-btn');
  if (followupClear) {
    followupClear.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ action: 'CLEAR_ANSWERED_COMMENTS' });
        await loadFollowups();
      } catch (error) {
        logError('Could not clear the follow-up list:', error);
      }
    });
  }
  loadFollowups();
  startFollowupPolling();

  // The panel is wired up. Recorded after the handlers are attached, so its presence
  // means "interactive", not merely "document parsed".
  panelInit.done({
    toggleAttached: !!toggleBtn,
    settingsAttached: !!settingsBtn,
    closeAttached: !!closeBtn,
    pollingStarted: true
  });
});

// Exported for the browser test harness (src/core/tests/popup-tests.js), which drives
// the same loaders the popup runs on open. Nothing else imports this file, so the
// export costs nothing at runtime.
export {
  loadSettings,
  loadStatus,
  renderRunState,
  renderPostingMode,
  setButtonLabel,
  loadProcessingStatus,
  renderSkipReasons,
  renderLastDecline,
  renderTotalTime,
  formatElapsed,
  loadFollowups,
  buildFollowupRow,
  renderHeartApplyState,
  handleHeartApplyToggle
};
