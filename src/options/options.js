// Options Page Script - YouTube Auto Reply Extension
// Phase 3: Model dropdown with LM Studio integration + Phase 3.5: Connection Test

import { getSettings, saveSettings } from '../core/storage.js';
import { getTriggers, addTrigger, deleteTrigger } from '../core/trigger-crud.js';
// Phase 19.6 — the reply-mode constants and the fixed-reply emptiness check. The text
// itself is never transformed: `validateFixedReply` only reports whether a box is empty.
import { REPLY_MODES, validateFixedReply } from '../core/fixed-reply.js';
// Phase 14.2 — one source of truth for the allowed response styles.
import { normalizeResponseStyle } from '../core/prompt-builder.js';
import { normalizeReplyMode, isValidReplyMode } from '../core/reply-modes.js';
// Phase 19.4 — the built-in list an empty box falls back to.
import { DEFAULT_BLACKLIST } from '../core/reply-validator.js';
// Phase 19.5 — named, swappable context blocks.
import {
  getTemplates,
  addTemplate,
  deleteTemplate,
  activateTemplate,
  deactivateTemplates,
} from '../core/context-templates.js';
// Phase 18.3 — diagnostics logging switch.
import { debugLog, logError, loadDebugSetting, setDebugEnabled, isDebugEnabled } from '../core/debug.js';
import {
  isFolderSyncSupported,
  saveFolderHandle,
  loadFolderHandle,
  requestFolderPermission,
  FOLDER_PERMISSION
} from '../core/folder-handle-store.js';

debugLog('Options page loaded');

// Phase 16.3 — bounds for the settings that control posting rate and timing.
const MAX_HOURLY_CAP = 600;
const MAX_DELAY_SECONDS = 600;

/**
 * Phase 16.3 — the hourly cap above which a save needs an explicit confirmation.
 *
 * 60 replies in one hour from a single account is the point where a channel starts
 * looking automated to viewers, so the value is allowed but never silently accepted.
 */
const SAFE_HOURLY_CAP = 60;

/**
 * Phase 19.4 — turn the banned-phrases box into a list.
 *
 * Comma-separated, like the triggers field. An empty box yields the built-in default
 * rather than an empty list, because an empty list is how the validator is switched
 * OFF, and that should take a deliberate extra step rather than clearing a text box.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseBlacklist(raw) {
  const parsed = String(raw || '')
    .split(',')
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_BLACKLIST];
}

/**
 * Read a whole number out of a numeric input.
 *
 * Returns `null` for anything that is not a finite whole number in range, so the
 * caller can refuse the save instead of persisting `NaN` into settings.
 *
 * @param {string} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function readWholeNumber(raw, min, max) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/**
 * Normalize a Base URL for LM Studio.
 *
 * Strips trailing slashes and appends `/v1` when the user omitted it, since
 * api-client builds `${baseUrl}/models`, so the OpenAI-compatible prefix must be
 * part of the saved value. Returns '' for empty input so callers can detect it.
 */
function normalizeBaseUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const withoutSlash = trimmed.replace(/\/+$/, '');
  if (/\/v\d+$/.test(withoutSlash)) return withoutSlash;
  return withoutSlash + '/v1';
}

let currentSettings = null;
let savedModelValue = ''; // Preserve the saved model value even if unavailable

/**
 * Load existing settings into the form fields.
 */
async function loadSettings() {
  try {
    currentSettings = await getSettings();
    
    const baseUrlInput = document.getElementById('baseUrl');
    const modelSelect = document.getElementById('model');
    
    // Set Base URL value
    baseUrlInput.value = currentSettings.lmStudio.baseUrl || '';

    // Phase 14.2 / 14.3 — populate the Reply Behavior controls.
    const replyModeSelect = document.getElementById('reply-mode');
    const styleSelect = document.getElementById('response-style');
    if (styleSelect) {
      // normalizeResponseStyle is imported so an unknown stored value shows the same
      // default the prompt builder would actually use.
      styleSelect.value = normalizeResponseStyle(currentSettings.replyBehavior?.responseStyle);
      // Phase 20.14 — an unrecognised stored value falls back to the default rather than
      // leaving the select blank, which would save as "" and read as "no mode".
      if (replyModeSelect) {
        replyModeSelect.value = normalizeReplyMode(currentSettings.replyBehavior?.replyMode);
      }
    }
    const contextInput = document.getElementById('static-context');
    if (contextInput) {
      contextInput.value = currentSettings.replyBehavior?.staticContext || '';
    }

    // Phase 22 — the follow-up switch and the creator's instruction.
    //
    // Read with `=== true` rather than truthiness, so a stored "true" STRING cannot turn
    // this on. The feature reads comments off the page and spends a model call per
    // qualifying thread; it must be off unless someone actually turned it on. The worker
    // re-checks the same way, so a bad value cannot get past the page either.
    const followupToggle = document.getElementById('followup-on-answered');
    if (followupToggle) {
      followupToggle.checked = currentSettings.replyBehavior?.followupOnAnswered === true;
    }
    const followupInstruction = document.getElementById('followup-instruction');
    if (followupInstruction) {
      followupInstruction.value = currentSettings.replyBehavior?.followupInstruction || '';
    }

    // The channel owner's heart. ON by default, so this is checked for `!== false` rather than
    // `=== true`: a user with nothing stored should see the box ticked, matching what the
    // extension actually does, and a stored "false" STRING must not read as ticked either.
    const heartFilterToggle = document.getElementById('ignore-hearted-comments');
    if (heartFilterToggle) {
      heartFilterToggle.checked = currentSettings.replyBehavior?.ignoreHeartedComments !== false;
    }

    const creatorRepliedToggle = document.getElementById('ignore-creator-replied-comments');
    if (creatorRepliedToggle) {
      creatorRepliedToggle.checked = currentSettings.replyBehavior?.ignoreCreatorRepliedComments !== false;
    }

    // Phase 23.1 — `=== true`, and that is the OPPOSITE of the filter above on purpose.
    // This one defaults OFF, so anything that is not an explicit boolean `true` — absent,
    // null, or a corrupted string — must read as OFF. Loosening this to `!== false` would
    // silently INVERT the default and start clicking hearts on a fresh install.
    const heartingToggle = document.getElementById('target-reply-hearting');
    if (heartingToggle) {
      heartingToggle.checked = currentSettings.targetReplyHeartingEnabled === true;
    }

    // Phase 19.4 — the configured blacklist. Empty in the box means "use the built-in
    // list", which is what an untouched setting looks like, so the field starts blank
    // rather than pre-filled with the defaults the validator already applies.
    const blacklistInput = document.getElementById('reply-blacklist');
    if (blacklistInput) {
      const configured = currentSettings.replyBehavior?.blacklist;
      blacklistInput.value = Array.isArray(configured) ? configured.join(', ') : '';
    }

    // Phase 16.3 — safety and limits. Values are only pre-filled when they are
    // usable, so a corrupt stored value shows as an empty field for the user to
    // correct rather than as a plausible-looking wrong number.
    const dryRunBox = document.getElementById('dry-run');
    if (dryRunBox) dryRunBox.checked = currentSettings.dryRun !== false;

    const behavior = currentSettings.replyBehavior || {};
    const capInput = document.getElementById('max-replies-per-hour');
    if (capInput) capInput.value = String(behavior.maxRepliesPerHour ?? '');

    const minDelayInput = document.getElementById('reply-delay-min');
    if (minDelayInput) minDelayInput.value = String(Math.round((behavior.minDelayMs ?? 0) / 1000));

    const maxDelayInput = document.getElementById('reply-delay-max');
    if (maxDelayInput) maxDelayInput.value = String(Math.round((behavior.maxDelayMs ?? 0) / 1000));

    // Phase 18.3 — diagnostics is a top-level storage key, not a setting, so it is
    // read through its own module rather than through getSettings().
    const debugBox = document.getElementById('debug-mode');
    if (debugBox) debugBox.checked = await loadDebugSetting();
    
    // Preserve the saved model value for later selection if needed
    savedModelValue = currentSettings.lmStudio.model || '';
    
    // Request models from background via service worker
    await loadModels();
  } catch (error) {
    logError('Error loading settings:', error);
  }
}

/**
 * Load available models from LM Studio and populate the dropdown.
 */
async function loadModels() {
  const modelSelect = document.getElementById('model');
  const messageEl = document.getElementById('message');
  
  // Show loading state
  modelSelect.innerHTML = '<option value="">Loading models...</option>';
  hideMessage();
  clearModelError();
  
  try {
    // Send request to background service worker
    const response = await chrome.runtime.sendMessage({ action: 'GET_LM_STUDIO_MODELS' });
    
    if (response.success) {
      const models = response.models;
      
      if (!models || models.length === 0) {
        // Empty model list
        modelSelect.innerHTML = '<option value="">No models available</option>';
        showMessage('No models available', 'warning');
        return;
      }
      
      // Populate dropdown with model IDs
      const optionsHtml = models.map(model => 
        `<option value="${escapeHtml(model.id)}">${model.id}</option>`
      ).join('');
      
      modelSelect.innerHTML = '<option value="">Select a model</option>' + optionsHtml;
      
      // Select the saved model if it exists in the list
      if (savedModelValue && models.some(m => m.id === savedModelValue)) {
        modelSelect.value = savedModelValue;
      } else if (savedModelValue) {
        // Saved model is not available - show as temporary selection with indicator
        const savedOption = document.querySelector(`option[value="${escapeHtml(savedModelValue)}"]`);
        if (savedOption) {
          savedOption.textContent = `Saved model unavailable\n${savedModelValue}`;
          savedOption.style.fontStyle = 'italic';
          savedOption.value = savedModelValue; // Keep the original value for storage
        }
      }
    } else {
      // Error loading models
      throw new Error(response.error || 'Failed to load models');
    }
  } catch (error) {
    logError('Error loading models:', error.message);
    
    // Show error state but keep the form usable
    modelSelect.innerHTML = '<option value="">Unable to load models</option>';
    showModelError(
      `${error.message} — check that LM Studio is running, and that the Base URL is reachable ` +
      `and permitted in the extension's host permissions.`
    );
  }
}

/**
 * Show the risky-change confirmation and resolve with the user's answer.
 *
 * The panel is a plain in-page dialog rather than window.confirm() so it can be
 * styled, worded per risk, and kept inside the card the change belongs to.
 *
 * Resolves `false` on Cancel, on Escape, and if the panel is missing — a save must
 * never hang because a dialog failed to render.
 *
 * @param {Object} request
 * @param {string} request.title
 * @param {string} request.body
 * @param {string} request.confirmLabel
 * @returns {Promise<boolean>} true when the user explicitly confirmed
 */
function confirmRiskyChange({ title, body, confirmLabel }) {
  const panel = document.getElementById('confirm-panel');
  const titleEl = document.getElementById('confirm-title');
  const bodyEl = document.getElementById('confirm-body');
  const acceptBtn = document.getElementById('confirm-accept');
  const cancelBtn = document.getElementById('confirm-cancel');

  if (!panel || !titleEl || !bodyEl || !acceptBtn || !cancelBtn) {
    logError('confirmation panel missing; refusing the risky change');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const close = (result) => {
      panel.hidden = true;
      acceptBtn.removeEventListener('click', onAccept);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onAccept = () => close(true);
    const onCancel = () => close(false);
    const onKeydown = (event) => {
      if (event.key === 'Escape') close(false);
    };

    titleEl.textContent = title;
    bodyEl.textContent = body;
    acceptBtn.textContent = confirmLabel;
    panel.hidden = false;

    acceptBtn.addEventListener('click', onAccept);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);
    acceptBtn.focus();
  });
}

/**
 * Handle form submission to save settings.
 */
async function handleSave(event) {
  event.preventDefault();

  const baseUrlInput = document.getElementById('baseUrl');
  const modelSelect = document.getElementById('model');

  const baseUrl = normalizeBaseUrl(baseUrlInput.value);

  // Get selected model value (preserves saved model even if unavailable)
  const model = modelSelect.value;

  // ── Phase 16.3 — validate and confirm before anything is written ──────────────
  clearSafetyError();

  const blacklistInput = document.getElementById('reply-blacklist');
  const capInput = document.getElementById('max-replies-per-hour');
  const minDelayInput = document.getElementById('reply-delay-min');
  const maxDelayInput = document.getElementById('reply-delay-max');
  const dryRunBox = document.getElementById('dry-run');

  const cap = readWholeNumber(capInput ? capInput.value : '', 1, MAX_HOURLY_CAP);
  const minDelaySeconds = readWholeNumber(minDelayInput ? minDelayInput.value : '', 0, MAX_DELAY_SECONDS);
  const maxDelaySeconds = readWholeNumber(maxDelayInput ? maxDelayInput.value : '', 0, MAX_DELAY_SECONDS);

  if (cap === null) {
    showSafetyError(`Max replies per hour must be a whole number between 1 and ${MAX_HOURLY_CAP}.`);
    return;
  }
  if (minDelaySeconds === null || maxDelaySeconds === null) {
    showSafetyError(`Delay must be a whole number of seconds between 0 and ${MAX_DELAY_SECONDS}.`);
    return;
  }
  if (maxDelaySeconds < minDelaySeconds) {
    showSafetyError('The maximum delay cannot be smaller than the minimum delay.');
    return;
  }

  const dryRun = dryRunBox ? dryRunBox.checked : true;

  // Turning dry run off is the single riskiest action in the product: from that
  // moment replies go to real viewers under a real account. It is confirmed first.
  if (!dryRun) {
    const confirmed = await confirmRiskyChange({
      title: 'Replies will be posted for real',
      body: 'Dry run is the safety gate that stops the extension from pressing Submit. '
          + 'Turning it off means generated replies are published to real viewers on your channel, '
          + 'and a mistake here cannot be undone.',
      confirmLabel: 'Post replies'
    });
    if (!confirmed) {
      showSafetyError('Save cancelled. Dry run stays on.');
      dryRunBox.checked = true;
      return;
    }
  }

  if (cap > SAFE_HOURLY_CAP) {
    const confirmed = await confirmRiskyChange({
      title: `${cap} replies per hour is a lot`,
      body: `Anything above ${SAFE_HOURLY_CAP} replies an hour reads as automated to viewers and can get a `
          + 'channel restricted. The limit will still be saved if you confirm.',
      confirmLabel: `Allow ${cap}/hour`
    });
    if (!confirmed) {
      showSafetyError(`Save cancelled. The limit is still ${SAFE_HOURLY_CAP} or lower.`);
      capInput.value = String(currentSettings?.replyBehavior?.maxRepliesPerHour ?? SAFE_HOURLY_CAP);
      return;
    }
  }

  try {
    // Merge into the existing lmStudio object rather than replacing it.
    //
    // chrome.storage.local.set() replaces a top-level key outright, so saving
    // `{ lmStudio: { baseUrl, model } }` used to DISCARD systemPrompt, apiKey,
    // temperature and maxTokens. The deep-merge in getSettings() then silently
    // restored the defaults, which hid the data loss — but it destroyed any
    // customised system prompt, including the Phase 14.1 default.
    const existingLm = (currentSettings && currentSettings.lmStudio) || {};
    const existingReply = (currentSettings && currentSettings.replyBehavior) || {};

    const styleSelect = document.getElementById('response-style');
    const replyModeSelect = document.getElementById('reply-mode');
    const contextInput = document.getElementById('static-context');
    // Phase 22 — read at save time so the value written is the one on screen, not the one
    // this function happened to load when the page opened.
    const followupToggle = document.getElementById('followup-on-answered');
    const followupInstruction = document.getElementById('followup-instruction');
    // Read at save time, like the ones above, so the value written is the one on screen.
    // The channel owner's heart.
    //
    // The default when the box is missing from an older cached page is `true`, which matches
    // DEFAULT_CONFIG: a save that silently flipped the heart filter off because the markup had
    // not been reloaded would look like the switch "not saving".
    const heartFilterToggle = document.getElementById('ignore-hearted-comments');
    const creatorRepliedToggle = document.getElementById('ignore-creator-replied-comments');

    // Phase 23.1. Top-level, so it sits beside `dryRun` in the save rather than inside
    // `replyBehavior` — it is a separate capability, not a reply-behaviour tuning knob.
    //
    // The missing-element fallback is `false`, matching DEFAULT_CONFIG. That is the whole
    // point of this one being safe: an older cached Options page that has not been reloaded
    // writes `false`, which IS the default, so saving from a stale page cannot turn the
    // feature ON behind the user's back. The heart filter above has the opposite fallback
    // (`true`) precisely because its default is ON.
    const heartingToggle = document.getElementById('target-reply-hearting');

    await saveSettings({
      // Phase 16.3 — the dry-run gate is a top-level key, written here so the
      // confirmation above is the only path that can turn it off.
      dryRun,
      // Phase 23.1 — written as a strict boolean, never `undefined`. An `undefined` would
      // be stored as an absent key and read back through the DEFAULT_CONFIG merge as
      // `false`, which is right by luck rather than by decision.
      targetReplyHeartingEnabled: heartingToggle ? heartingToggle.checked === true : false,
      lmStudio: {
        ...existingLm,
        baseUrl,
        model
      },
      // Phase 14.2 / 14.3 — merge so unrelated reply settings (delays, rate limit)
      // survive a save from this page.
      replyBehavior: {
        ...existingReply,
        responseStyle: styleSelect
          ? normalizeResponseStyle(styleSelect.value)
          : existingReply.responseStyle,
        // Phase 20.14 — validated rather than passed through: an unknown mode must not be
        // written to storage, because every reader would then have to handle a value nothing
        // implements. `normalizeReplyMode()` also covers the case where the element is absent
        // (an older cached page), so this can never write `undefined`.
        replyMode: replyModeSelect && isValidReplyMode(replyModeSelect.value)
          ? normalizeReplyMode(replyModeSelect.value)
          : normalizeReplyMode(existingReply.replyMode),
        staticContext: contextInput ? contextInput.value.trim() : (existingReply.staticContext || ''),
        // Phase 19.4 — an empty box keeps the built-in list by writing the same default,
        // so "leave it alone" and "reset it" are the same outcome.
        blacklist: parseBlacklist(blacklistInput ? blacklistInput.value : ''),
        // Phase 16.3 — validated above, converted to the millisecond form the
        // service worker already reads.
        minDelayMs: minDelaySeconds * 1000,
        maxDelayMs: maxDelaySeconds * 1000,
        maxRepliesPerHour: cap,
        // Phase 22. Written from the checkbox rather than derived from any other setting:
        // it is a separate switch, and folding it into a mode would make turning it off
        // impossible without changing how ordinary replies work.
        followupOnAnswered: followupToggle ? followupToggle.checked === true : (existingReply.followupOnAnswered === true),
        followupInstruction: followupInstruction
          ? followupInstruction.value.trim()
          : (existingReply.followupInstruction || ''),
        ignoreHeartedComments: heartFilterToggle
          ? heartFilterToggle.checked === true
          : (existingReply.ignoreHeartedComments !== false),
        ignoreCreatorRepliedComments: creatorRepliedToggle
          ? creatorRepliedToggle.checked === true
          : (existingReply.ignoreCreatorRepliedComments !== false)
      }
    });

    // Phase 18.3 — diagnostics flag lives outside settings, so it is written here.
    const debugBox = document.getElementById('debug-mode');
    if (debugBox) await setDebugEnabled(debugBox.checked);
    debugLog('diagnostics logging now', isDebugEnabled() ? 'ON' : 'OFF');

    // Show success message
    showMessage('Settings saved', 'success');
    
    // Clear message after 2 seconds
    setTimeout(() => {
      hideMessage();
    }, 2000);
    
  } catch (error) {
    logError('Error saving settings:', error);
    showMessage('Error saving settings', 'error');
  }
}

/**
 * Write a button label without destroying the icon inside it.
 *
 * Assigning `textContent` wipes every child, so the play/chat glyphs in the test
 * buttons would disappear the first time a test ran and the button was restored
 * to its resting label.
 */
function setButtonLabel(btn, text) {
  const label = btn.querySelector('.btn-label');
  if (label) {
    label.textContent = text;
  } else {
    btn.textContent = text;
  }
}

/**
 * Test connection to LM Studio.
 */
async function testConnection() {
  const testBtn = document.getElementById('test-connection-btn');
  // The page header carries a shortcut for the same test, so both entry points
  // have to show the same progress and restore their own resting label.
  const headerBtn = document.getElementById('header-test-btn');
  const messageEl = document.getElementById('message');
  const resultEl = document.getElementById('connection-result');
  
  // Disable button during test
  testBtn.disabled = true;
  setButtonLabel(testBtn, 'Testing...');
  if (headerBtn) {
    headerBtn.disabled = true;
    setButtonLabel(headerBtn, 'Testing...');
  }
  hideMessage();
  clearResult();
  
  try {
    // Send request to background service worker for connection test
    const response = await chrome.runtime.sendMessage({ action: 'TEST_CONNECTION' });
    
    if (response.success) {
      // Success - show result in dedicated element
      resultEl.textContent = `✓ Connection successful! Model: ${escapeHtml(response.model || 'unknown')}`;
      resultEl.className = 'success visible'
      
      // Also show a brief success message
      showMessage('Connection test passed', 'success');
    } else {
      throw new Error(response.error || 'Connection test failed');
    }
  } catch (error) {
    logError('Connection test error:', error.message);
    
    // Show error in dedicated element
    resultEl.textContent = `✗ ${escapeHtml(error.message)}`;
    resultEl.className = 'error visible'
    
    showMessage('Connection test failed', 'error');
  } finally {
    // Re-enable button
    testBtn.disabled = false;
    setButtonLabel(testBtn, 'Test LM Studio Connection');
    if (headerBtn) {
      headerBtn.disabled = false;
      setButtonLabel(headerBtn, 'Test Connection');
    }
  }
}

/**
 * Test chat completion with a simple prompt.
 */
async function testChatCompletion() {
  const chatBtn = document.getElementById('test-chat-completion-btn');
  const chatResultEl = document.getElementById('chat-result');
  
  // Disable button during test
  chatBtn.disabled = true;
  setButtonLabel(chatBtn, 'Testing...');
  hideChatMessage();
  clearChatError();
  
  try {
    // Send request to background service worker for chat completion test
    const response = await chrome.runtime.sendMessage({ action: 'TEST_CHAT_COMPLETION' });
    
    if (response.success) {
      // Success - show full response text
      let displayText = response.text;
      if (displayText.length > 300) {
        displayText = displayText.substring(0, 300).trim() + '...';
      }
      chatResultEl.textContent = `✓ Response:\n${escapeHtml(displayText)}`;
      chatResultEl.className = 'message visible success';
    } else {
      throw new Error(response.error || 'Chat completion test failed');
    }
  } catch (error) {
    logError('Chat completion test error:', error.message);
    
    // Show error
    chatResultEl.textContent = `✗ ${escapeHtml(error.message)}`;
    chatResultEl.className = 'message visible error';
  } finally {
    // Re-enable button
    chatBtn.disabled = false;
    setButtonLabel(chatBtn, 'Test Chat Completion');
  }
}

/**
 * Show a message to the user.
 */
function showMessage(text, type = '') {
  const messageEl = document.getElementById('message');
  messageEl.textContent = text;
  messageEl.className = 'message visible ' + type;
}

/**
 * Hide any displayed message.
 */
function hideMessage() {
  const messageEl = document.getElementById('message');
  messageEl.classList.remove('visible', 'success', 'error', 'warning');
  messageEl.textContent = '';
}

/**
 * Show error message near Model field.
 */
function showModelError(message) {
  const errorEl = document.getElementById('model-error');
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

/**
 * Clear any displayed error message.
 */
function clearModelError() {
  const errorEl = document.getElementById('model-error');
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

/**
 * Clear connection result display.
 */
function clearResult() {
  const resultEl = document.getElementById('connection-result');
  resultEl.className = 'hidden'
}

/**
 * Show an error next to the Create Trigger form.
 */
function showTriggerError(message) {
  const errorEl = document.getElementById('trigger-error');
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}


/**
 * Clear any Create Trigger error.
 */
function clearTriggerError() {
  const errorEl = document.getElementById('trigger-error');
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}


// ── Phase 19.6 — reply type in the Create Trigger form ────────────────────────
//
// Two small helpers rather than inline listeners, because the same three steps (read the
// radios, show the box, clear it on reset) are needed both by the change handler below and
// by handleAddTrigger()'s form reset. Kept here so the two cannot drift apart.

/**
 * Which reply type is currently selected in the form.
 *
 * Defaults to AI when neither radio is present or checked, which is also what an older
 * saved page state would give.
 *
 * @returns {string} REPLY_MODES.AI or REPLY_MODES.FIXED
 */
function readTriggerReplyMode() {
  const fixed = document.getElementById('trigger-reply-mode-fixed');
  if (fixed && fixed.checked) return REPLY_MODES.FIXED;
  return REPLY_MODES.AI;
}

/**
 * Show the fixed-reply box only while fixed mode is selected, and keep the radio and the
 * box in step when the mode is set programmatically (the form reset).
 *
 * @param {string} mode
 */
function setTriggerReplyMode(mode) {
  const isFixed = mode === REPLY_MODES.FIXED;
  const aiRadio = document.getElementById('trigger-reply-mode-ai');
  const fixedRadio = document.getElementById('trigger-reply-mode-fixed');
  const row = document.getElementById('trigger-fixed-reply-row');

  if (aiRadio) aiRadio.checked = !isFixed;
  if (fixedRadio) fixedRadio.checked = isFixed;
  if (row) row.style.display = isFixed ? '' : 'none';
}

/**
 * One delegated change listener for both reply-type radios.
 */
function handleReplyModeChange() {
  setTriggerReplyMode(readTriggerReplyMode());
}


/**
 * Show a problem with the Safety & limits values (Phase 16.3).
 */
function showSafetyError(message) {
  const errorEl = document.getElementById('safety-error');
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

/**
 * Clear the Safety & limits error box.
 */
function clearSafetyError() {
  const errorEl = document.getElementById('safety-error');
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

/**
 * Create a trigger from the Create Trigger form.
 *
 * All creation logic (id generation, defaults, validation, persistence) already lives in
 * addTrigger(). This only reads the form, hands the values over, and refreshes the list.
 */
async function handleAddTrigger() {
  const phraseInput = document.getElementById('trigger-phrase');
  const modeSelect = document.getElementById('trigger-match-mode');
  const enabledBox = document.getElementById('trigger-enabled');
  const caseSensitiveBox = document.getElementById('trigger-case-sensitive');
  const replyMode = readTriggerReplyMode();
  const fixedReplyInput = document.getElementById('trigger-fixed-reply');

  clearTriggerError();

  // Split on commas so a single input can produce the phrases array the schema expects,
  // then drop empty entries from stray or trailing commas.
  const phrases = phraseInput.value
    .split(',')
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);

  if (phrases.length === 0) {
    showTriggerError('Please enter at least one phrase.');
    return;
  }

  // Phase 19.6 — a fixed reply must have text. Checked here so the user gets the message
  // next to the box they left empty; addTrigger() enforces the same rule independently,
  // because that layer is what everything else goes through.
  const fixedReply = fixedReplyInput ? fixedReplyInput.value : '';
  if (replyMode === REPLY_MODES.FIXED && !validateFixedReply(fixedReply).valid) {
    showTriggerError('Enter the fixed reply text, or switch back to AI generated.');
    return;
  }

  try {
    const created = await addTrigger({
      phrases,
      matchMode: modeSelect.value,
      enabled: enabledBox.checked,
      caseSensitive: caseSensitiveBox.checked,
      replyMode,
      // Passed verbatim, not trimmed: the reply must be published exactly as typed.
      fixedReply
    });

    debugLog('Trigger created:', created.id);

    // Reset the form to its defaults.
    phraseInput.value = '';
    modeSelect.value = 'contains';
    enabledBox.checked = true;
    caseSensitiveBox.checked = false;
    setTriggerReplyMode(REPLY_MODES.AI);
    if (fixedReplyInput) fixedReplyInput.value = '';

    // Refresh the existing list so the new trigger appears.
    await loadTriggers();
  } catch (error) {
    logError('Error creating trigger:', error.message);
    showTriggerError(`Could not create trigger: ${error.message}`);
  }
}


/**
 * Load and display trigger rules in the triggers list.
 */
async function loadTriggers() {
  try {
    const triggers = await getTriggers();
    renderTriggersList(triggers);
  } catch (error) {
    logError('Error loading triggers:', error);
  }
}

/**
 * Render the triggers list in the UI.
 */
function renderTriggersList(triggers) {
  const container = document.getElementById('triggers-list');
  
  if (!triggers || triggers.length === 0) {
    // Empty state — an invitation to act, not an apology
    container.innerHTML = '<p>No triggers yet. Add one above to start answering comments.</p>';
    return;
  }

  // Render each trigger.
  //
  // A rounded row, not a card. The phrases are the point of the product, so they
  // are set at reading size while the state sits alongside in a small pill that
  // stays scannable without competing for attention.
  const triggersHtml = triggers.map(trigger => {
    const isDisabled = !trigger.enabled;
    const words = trigger.phrases
      .map((phrase) => `<span class="trigger-word">${escapeHtml(phrase)}</span>`)
      .join('<span class="trigger-word-sep">،</span>');

    const state = isDisabled
      ? 'Paused'
      : (trigger.matchMode === 'exact' ? 'Exact match' : 'Contains');

    // State first in the DOM, words last. The Arabic then occupies the right edge where
    // an RTL run belongs, and the row reads as two poles — status at one end, the words
    // a viewer will type at the other — instead of both crowding the same corner.
    //
    // dir="auto" rather than a hard "rtl": a trigger list may legitimately mix Arabic
    // and English, and the browser picks the right direction for each row.
    //
    // The delete control carries data-trigger-id, not the phrase, so the click handler
    // can target exactly one row — two triggers may legitimately share a phrase, and
    // deleting by phrase would take both.
    return `
      <div class="trigger-item ${isDisabled ? 'disabled' : ''}">
        <span class="trigger-meta">${state}</span>
        <span class="trigger-words" dir="auto">${words}</span>
        <button class="trigger-delete" type="button" data-trigger-id="${escapeAttr(trigger.id)}"
                aria-label="Delete trigger" title="Delete trigger">
          <svg class="ic"><use href="#i-trash"/></svg>
        </button>
      </div>`;
  }).join('');

  container.innerHTML = triggersHtml;
}

/**
 * Delete a single trigger rule from the list.
 *
 * All deletion logic (id lookup, removal, persistence) already lives in
 * deleteTrigger(). This resolves the clicked row to its id, calls it, and refreshes
 * the list so the row disappears immediately.
 */
async function handleDeleteTrigger(triggerId) {
  clearTriggerError();

  if (!triggerId) {
    return;
  }

  try {
    await deleteTrigger(triggerId);
    await loadTriggers();
  } catch (error) {
    logError('Error deleting trigger:', error.message);
    showTriggerError(`Could not delete trigger: ${error.message}`);
  }
}

/**
 * Show a problem with the template form (Phase 19.5).
 */
function showTemplateError(message) {
  const el = document.getElementById('template-error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

/**
 * Clear the template error box.
 */
function clearTemplateError() {
  const el = document.getElementById('template-error');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

/**
 * Render the saved templates (Phase 19.5).
 *
 * The active one is marked so it is obvious which template currently reaches every
 * prompt. Each row also carries its own id on the buttons, because two templates may
 * legitimately share a name.
 */
function renderTemplatesList(templates) {
  const container = document.getElementById('templates-list');
  if (!container) return;

  if (!templates || templates.length === 0) {
    container.innerHTML = '<p>No templates yet. Add one above to swap context without retyping it.</p>';
    return;
  }

  container.innerHTML = templates.map((t) => {
    const isActive = Boolean(t && t.enabled);
    const state = isActive
      ? '<span class="trigger-meta">In use</span>'
      : `<button class="btn btn-quiet btn-tiny" type="button" data-template-use="${escapeAttr(t.id)}">Use</button>`;
    const preview = String(t.body || '').replace(/\s+/g, ' ').trim();
    const shown = preview.length > 90 ? preview.slice(0, 90) + '…' : preview;
    return `
      <div class="trigger-item${isActive ? ' is-active' : ''}">
        ${state}
        <span class="template-text">
          <span class="template-name">${escapeHtml(t.name)}</span>
          <span class="template-preview">${escapeHtml(shown)}</span>
        </span>
        <button class="trigger-delete" type="button" data-template-delete="${escapeAttr(t.id)}"
                aria-label="Delete template" title="Delete template">
          <svg class="ic"><use href="#i-trash"/></svg>
        </button>
      </div>`;
  }).join('');
}

/**
 * Refresh the template list from storage.
 */
async function loadTemplates() {
  try {
    renderTemplatesList(await getTemplates());
  } catch (error) {
    logError('Error loading templates:', error.message);
  }
}

/**
 * Add a template from the form, then reset the form (Phase 19.5).
 */
async function handleAddTemplate() {
  clearTemplateError();
  const nameInput = document.getElementById('template-name');
  const bodyInput = document.getElementById('template-body');
  if (!nameInput || !bodyInput) return;

  const name = nameInput.value.trim();
  const body = bodyInput.value.trim();

  if (!name || !body) {
    showTemplateError('Give the template a name and some context.');
    return;
  }

  try {
    await addTemplate({ name, body });
    nameInput.value = '';
    bodyInput.value = '';
    await loadTemplates();
  } catch (error) {
    logError('Error creating template:', error.message);
    showTemplateError(`Could not create template: ${error.message}`);
  }
}

/**
 * Make one template the active one (Phase 19.5).
 */
async function handleActivateTemplate(templateId) {
  clearTemplateError();
  try {
    await activateTemplate(templateId);
    await loadTemplates();
  } catch (error) {
    logError('Error activating template:', error.message);
    showTemplateError(`Could not switch template: ${error.message}`);
  }
}

/**
 * Turn the active template off without deleting it (Phase 19.5).
 */
async function handleDeactivateTemplate() {
  clearTemplateError();
  try {
    await deactivateTemplates();
    await loadTemplates();
  } catch (error) {
    logError('Error deactivating template:', error.message);
    showTemplateError(`Could not switch template off: ${error.message}`);
  }
}

/**
 * Delete one template (Phase 19.5).
 */
async function handleDeleteTemplate(templateId) {
  clearTemplateError();
  try {
    await deleteTemplate(templateId);
    await loadTemplates();
  } catch (error) {
    logError('Error deleting template:', error.message);
    showTemplateError(`Could not delete template: ${error.message}`);
  }
}

/**
 * Load settings and initialize the page.
 */
/**
 * Phase 20.20 — one index state, rendered as one sentence.
 *
 * The three states are deliberately different colours AND different words, because the
 * distinction is the whole value: an empty base is not an error (the user has not added
 * files yet), a stale index is not a failure either (the next comment rebuilds it), and
 * only a real error is red. A single "unavailable" style would train a user to ignore it.
 */
const INDEX_STATE_WORDS = {
  fresh: { text: 'Up to date', cls: 'is-ready' },
  building: { text: 'Re-indexing…', cls: 'is-pending' },
  stale: { text: 'Needs re-indexing', cls: 'is-pending' },
  failed: { text: 'Index failed', cls: 'is-error' },
  empty: { text: 'No knowledge files yet', cls: 'is-pending' }
};

/**
 * Render an index status from `getKnowledgeIndexStatus()`.
 *
 * `retrievable` is preferred over `state` for the verdict, and the difference is 20.4's:
 * the stored metadata can say FRESH while this worker holds no index at all, and telling
 * a user "up to date" when the first comment will trigger a rebuild is a small lie. So a
 * FRESH-but-not-cached base reads "ready on first use" instead of "up to date".
 */
function renderKnowledgeStatus(status) {
  const el = document.getElementById('kb-status');
  const detailEl = document.getElementById('kb-detail');
  if (!el) return;

  const s = status || {};
  const state = typeof s.state === 'string' ? s.state : '';
  const error = typeof s.error === 'string' ? s.error : '';

  // Computed up front because the verdict needs them, and the "no files" branch must be
  // decided from what is IN THE BASE rather than what has been indexed.
  const documents = Number.isFinite(s.storedDocumentCount)
    ? s.storedDocumentCount
    : (Number.isFinite(s.documentCount) ? s.documentCount : 0);
  const sections = Number.isFinite(s.sectionCount) ? s.sectionCount : 0;

  let verdict;
  if (state === 'failed') {
    verdict = INDEX_STATE_WORDS.failed;
  } else if (s.retrievable === true) {
    verdict = INDEX_STATE_WORDS.fresh;
  } else if (state === 'building') {
    verdict = INDEX_STATE_WORDS.building;
  } else if (documents === 0 && sections === 0) {
    // No files, which is a fresh install rather than something wrong.
    //
    // `documents`/`sections` come from the counts computed below, i.e. from
    // `storedDocumentCount` — NOT `documentCount`, which is what is INDEXED and is therefore
    // zero until the first build. Checking `documentCount` told a user who had just saved
    // their first file that they had "no knowledge files yet", and then answered from them
    // on the very next comment. Phase 20.23's pre-flight smoke test caught this.
    verdict = INDEX_STATE_WORDS.empty;
  } else {
    verdict = INDEX_STATE_WORDS[state] || { text: 'Needs re-indexing', cls: 'is-pending' };
  }

  el.textContent = verdict.text;
  el.className = 'hint kb-status ' + verdict.cls;

  // `storedDocumentCount` is what is IN the base; `documentCount` is what is INDEXED.
  // Reading only the second would tell a user who has just saved their first file that they
  // have none, and then answer from it on the next comment.
  if (error) {
    // The failure text names WHICH files broke, so it is worth showing rather than
    // replacing with a generic message.
    detailEl.textContent = error;
    return;
  }
  if (documents === 0) {
    detailEl.textContent =
      'Add Markdown files to the Knowledge Base to answer factual questions. Trigger mode needs none.';
    return;
  }
  const indexed = Number.isFinite(s.documentCount) ? s.documentCount : 0;
  detailEl.textContent =
    sections > 0
      ? `${documents} file${documents === 1 ? '' : 's'}, ${sections} section${sections === 1 ? '' : 's'} indexed. ` +
        'Re-indexing re-reads every file; you only need it if you think answers are coming from an older version.'
      // Files exist but nothing is indexed yet: the next comment builds the index, so say so
      // rather than implying the base is broken.
      : `${documents} file${documents === 1 ? '' : 's'} saved. The index builds on the next comment, ` +
        'or press Re-index now.';
}

/**
 * Phase 20.20 — ask the background for the current index state.
 *
 * Never throws: a dead worker must leave the row readable rather than blank, and the
 * background answers with zeros after a restart rather than being silent.
 */
async function refreshKnowledgeStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_KNOWLEDGE_STATUS' });
    renderKnowledgeStatus(response && response.status);
  } catch (_) {
    const el = document.getElementById('kb-status');
    if (el) {
      el.textContent = 'Status unavailable';
      el.className = 'hint kb-status is-error';
    }
  }
}

/**
 * Phase 21.1 — the knowledge folder (pick, sync, forget).
 *
 * THE SPLIT WITH THE WORKER IS FORCED, not chosen. `showDirectoryPicker()` does not exist in
 * an MV3 service worker — verified in the Chrome build this ships against — and needs a user
 * gesture besides. But a `FileSystemDirectoryHandle` CAN be stored in IndexedDB and restored
 * and walked from the worker, which is the only reason unattended syncing is possible at all.
 * So this page picks and this page grants permission; the worker reads.
 *
 * That is why the permission request lives HERE and not in the sync: `requestPermission()`
 * requires the gesture, and a click on "Sync now" is the one gesture that can re-grant it
 * after a browser restart.
 */

// ── Phase 21.1 — folder state rendering ───────────────────────────────────────

/** Set the one-line state under the folder buttons. */
function setFolderState(text, tone) {
  const el = document.getElementById('kb-folder-state');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (tone ? ' ' + tone : '');
}

/** Set the one-line result of the last sync. Empty text clears it. */
function setFolderResult(text, tone) {
  const el = document.getElementById('kb-folder-result');
  if (!el) return;
  el.textContent = text || '';
  if (!text) return;
  el.className = 'hint' + (tone ? ' ' + tone : '');
}

/**
 * Render the folder state and say what the buttons can do next.
 *
 * The unsupported case is handled rather than left to fail on click: an offer the browser
 * cannot keep is worse than no offer, and the reason is worth stating because "why is this
 * feature missing" is otherwise unanswerable from the UI.
 */
function renderFolderState(state) {
  const pickBtn = document.getElementById('kb-folder-pick');
  const syncBtn = document.getElementById('kb-folder-sync');
  const forgetBtn = document.getElementById('kb-folder-forget');

  const supported = isFolderSyncSupported();
  if (pickBtn) pickBtn.disabled = !supported;
  if (!supported) {
    setFolderState('This browser cannot link a folder to the extension.', 'kb-status is-error');
    return;
  }

  if (!state || state.linked !== true) {
    if (syncBtn) syncBtn.disabled = true;
    if (forgetBtn) forgetBtn.hidden = true;
    setFolderState('No folder linked.');
    return;
  }

  if (forgetBtn) forgetBtn.hidden = false;

  // A `prompt` permission is the one state the user can fix with the button they are looking
  // at, so it names the button rather than reporting a dead end.
  if (state.permission !== 'granted') {
    if (syncBtn) syncBtn.disabled = false;
    setFolderState(
      state.permission === 'denied'
        ? `Permission to read “${state.folderName}” was denied. Re-choose the folder to grant it.`
        : `“${state.folderName}” is linked. Click “Sync now” once to allow reading it.`,
      'kb-status is-pending'
    );
    return;
  }

  if (syncBtn) syncBtn.disabled = false;
  const when = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : 'never';
  setFolderState(`Syncing from “${state.folderName}” every 5 minutes — last synced ${when}.`);

  const result = state.lastResult;
  if (result && !state.lastError) {
    setFolderResult(
      `${result.added} added · ${result.updated} updated · ${result.unchanged} unchanged · ` +
      `${result.removed} removed` +
      (result.skipped ? ` · ${result.skipped} skipped` : '') +
      (result.truncated ? ' · stopped early: the folder has more Markdown files than the base can hold' : '')
    );
  }
  if (state.lastError) setFolderResult(state.lastError, 'kb-status is-error');
}

/** Read the folder state from the worker and render it. */
async function loadFolderState() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_KNOWLEDGE_FOLDER_STATE' });
    if (response && response.success === true) renderFolderState(response.state);
    else setFolderState('Could not read the folder link.', 'kb-status is-error');
  } catch (_) {
    setFolderState('Could not read the folder link.', 'kb-status is-error');
  }
}

/**
 * Open the folder picker and link the chosen directory.
 *
 * The permission is requested HERE, immediately after the pick, because the click that opened
 * the dialog is the user gesture `requestPermission()` needs. Asking later — from the worker,
 * or from a later sync — cannot work at all.
 */
async function pickKnowledgeFolder() {
  if (!isFolderSyncSupported()) return;

  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (error) {
    // AbortError is the user closing the picker. Not an error, and saying "failed" would be
    // a lie about something the user just did deliberately.
    if (error && error.name === 'AbortError') {
      setFolderResult('');
      return;
    }
    setFolderResult('Could not open the folder picker: ' + (error.message || 'unknown error'), 'kb-status is-error');
    return;
  }

  if (!handle) return;

  const permission = await requestFolderPermission(handle);
  if (permission === FOLDER_PERMISSION.DENIED) {
    setFolderResult('The extension was not given permission to read that folder.', 'kb-status is-error');
    return;
  }

  const stored = await saveFolderHandle(handle);
  if (!stored) {
    setFolderResult(
      'The folder could not be remembered. It will have to be chosen again next time.',
      'kb-status is-error'
    );
    return;
  }

  setFolderResult('Folder linked. Reading it…');
  await syncKnowledgeFolderNow();
}

/**
 * Run a sync now, with this click's gesture available for re-granting permission.
 *
 * THE GESTURE STAYS IN THE PAGE, and this is the whole reason the function exists as more
 * than a message send. After a browser restart the stored handle comes back with its
 * permission reset to `prompt`, and only a real user gesture can move it back to `granted`.
 * The worker cannot do this for itself — it has no gesture, ever — so if the request were
 * left to the sync, the button would be permanently unable to fix the one thing it exists to
 * fix, and the folder would work once after being chosen and then silently stop.
 *
 * The handle is read from the SAME IndexedDB the worker reads, because the page and the
 * worker share the extension origin.
 */
async function syncKnowledgeFolderNow() {
  const btn = document.getElementById('kb-folder-sync');
  if (btn) btn.disabled = true;
  setFolderResult('Reading the folder…');

  try {
    // Ask first, and ignore the outcome: a denial is reported by the worker's own sync, which
    // is where the base is left untouched.
    const handle = await loadFolderHandle();
    if (handle) await requestFolderPermission(handle);

    const response = await chrome.runtime.sendMessage({ action: 'SYNC_KNOWLEDGE_FOLDER' });

    if (!response || response.success !== true) {
      setFolderResult((response && response.error) || 'The folder sync failed.', 'kb-status is-error');
      return;
    }

    // The worker returns the documents too, so the list does not need a second round trip.
    if (Array.isArray(response.documents)) {
      renderKnowledgeDocuments(response.documents, null);
    }
    renderFolderState(response.state);
    await refreshKnowledge();
  } catch (_) {
    setFolderResult('The folder sync failed.', 'kb-status is-error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Unlink the folder, keeping the documents already imported.
 *
 * Deliberately not a delete. Forgetting WHERE knowledge came from must not destroy the
 * knowledge itself; the user who links a folder and then wants it gone has said nothing about
 * wanting their answers gone.
 */
async function forgetKnowledgeFolder() {
  try {
    await chrome.runtime.sendMessage({ action: 'FORGET_KNOWLEDGE_FOLDER' });
  } catch (_) {
    // Nothing to do but show the state as unlinked anyway; the next read is authoritative.
  }
  setFolderResult('');
  await loadFolderState();
}

// ── Phase 21.2 — split a source document into the knowledge tree ─────────────

/**
 * The generated files currently under review.
 *
 * Module scope because it is written by one handler and read by another, and because the
 * Write button's enabled state depends on it — the same reason `editingKnowledgeId` lives at
 * module level. Deliberately NOT persisted: a stale review list that outlives the session
 * could offer to write a file the user no longer recognises.
 */
let splitReview = [];

/** Set the one-line status under the generator. */
function setDocStatus(text, tone) {
  const el = document.getElementById('doc-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'hint' + (tone ? ' ' + tone : '');
}

/** Enable Write only when there is at least one reviewable file. */
function refreshWriteButton() {
  const btn = document.getElementById('doc-write');
  if (btn) btn.disabled = !splitReview.some((d) => d.selected && d.content);
}

/** Render the review list. Nothing is written from this list without a click on Write. */
function renderSplitResults(documents) {
  const container = document.getElementById('doc-results');
  if (!container) return;

  splitReview = Array.isArray(documents) ? documents : [];

  container.textContent = '';

  if (splitReview.length === 0) {
    refreshWriteButton();
    return;
  }

  for (const doc of splitReview) {
    const row = document.createElement('div');
    row.className = 'kb-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    // A rejected file cannot be written, so it is not offered. Ticking it would produce a
    // write the user cannot sensibly have asked for.
    box.checked = doc.selected === true && !!doc.content;
    box.disabled = !doc.content;
    box.addEventListener('change', () => {
      doc.selected = box.checked;
      refreshWriteButton();
    });

    const text = document.createElement('div');
    text.className = 'kb-row-text';

    const path = document.createElement('div');
    path.className = 'kb-row-title';
    path.textContent = doc.path;

    const detail = document.createElement('div');
    detail.className = 'hint';
    // `textContent`, never innerHTML: this text is model output built from a document the
    // user pasted, and a generated file is exactly the kind of string that must not become
    // markup.
    detail.textContent = doc.content
      ? `${doc.chars} characters` +
        (doc.headingAdded ? ' · a heading was added' : '') +
        (doc.duplicatesAnother ? ' · overlaps another file' : '')
      : `not written — ${doc.reason || 'could not be generated'}`;

    // A duplicate is loud. Two generated files that repeat each other are a §18 blocking
    // conflict, so the questions they were meant to answer would stop being answered until
    // the user resolved it — and they are the one who should get to choose which to keep.
    if (doc.duplicatesAnother) {
      const warn = document.createElement('div');
      warn.className = 'hint kb-status is-pending';
      warn.textContent = doc.reason;
      text.appendChild(warn);
    }

    text.appendChild(path);
    text.appendChild(detail);

    row.appendChild(box);
    row.appendChild(text);
    container.appendChild(row);
  }

  refreshWriteButton();
}

/**
 * Ask the model to split the pasted source into the folder tree.
 *
 * The destinations come from the LINKED FOLDER, read live, rather than from a copy taken when
 * the page loaded — the user may have added folders since, and generating against a stale tree
 * is how files end up somewhere the user does not expect.
 */
async function generateSplitFiles() {
  const btn = document.getElementById('doc-generate');
  const sourceEl = document.getElementById('doc-source');
  const instructionEl = document.getElementById('doc-instruction');

  const sourceText = sourceEl ? sourceEl.value : '';
  if (!sourceText.trim()) {
    setDocStatus('Paste a document first.', 'kb-status is-error');
    return;
  }

  if (btn) btn.disabled = true;
  renderSplitResults([]);
  setDocStatus('Asking the model how to split this…');

  try {
    const foldersResponse = await chrome.runtime.sendMessage({ action: 'PREVIEW_FOLDER_NAMES' });
    if (!foldersResponse || foldersResponse.success !== true || foldersResponse.linked !== true) {
      setDocStatus('Link a folder first — that is where the files will be placed.', 'kb-status is-error');
      return;
    }

    setDocStatus('Planning the split, then writing each file. This takes a moment…');

    const response = await chrome.runtime.sendMessage({
      action: 'SPLIT_SOURCE_DOCUMENT',
      payload: {
        sourceText,
        folders: foldersResponse.folders,
        instruction: instructionEl ? instructionEl.value : '',
      },
    });

    if (!response || response.success !== true) {
      setDocStatus((response && response.error) || 'The split failed.', 'kb-status is-error');
      return;
    }

    renderSplitResults(response.documents);

    const counts = response.counts || { ready: 0, rejected: 0, duplicates: 0 };
    const parts = [`${counts.ready} file(s) ready`];
    if (counts.duplicates) {
      parts.push(`${counts.duplicates} overlap another file — untick one of each pair`);
    }
    if (counts.rejected) {
      parts.push(`${counts.rejected} rejected for stating figures the source does not contain`);
    }
    setDocStatus(
      `${parts.join('; ')}. Nothing has been written yet — review, then write.`,
      'kb-status is-pending'
    );
  } catch (_) {
    setDocStatus('The split failed.', 'kb-status is-error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Write the selected generated files to disk, then let the normal sync pull them in.
 *
 * Write permission is requested HERE, from this click, because a worker can never hold the
 * gesture `requestPermission()` needs. Without it the button would fail every single time
 * with a message nobody could act on.
 */
async function writeSplitFiles() {
  const btn = document.getElementById('doc-write');
  const files = splitReview.filter((d) => d.selected && d.content).map((d) => ({ path: d.path, content: d.content }));

  if (files.length === 0) return;

  if (btn) btn.disabled = true;
  setDocStatus('Writing to the folder…');

  try {
    const handle = await loadFolderHandle();
    if (handle) await requestFolderPermission(handle, 'readwrite');

    const response = await chrome.runtime.sendMessage({ action: 'WRITE_GENERATED_DOCUMENTS', files });

    if (!response || !response.written || response.written.length === 0) {
      setDocStatus((response && response.error) || 'Nothing could be written.', 'kb-status is-error');
      return;
    }

    const failed = (response.failed || []).length;
    setDocStatus(
      `Wrote ${response.written.length} file(s) to the folder.` +
        (failed ? ` ${failed} could not be written.` : ' They are now in your Knowledge Base.'),
      failed ? 'kb-status is-pending' : ''
    );

    // The review list is cleared only on success, so a partial failure keeps the files the
    // user had selected and had not managed to write.
    if (!failed) renderSplitResults([]);
    await refreshKnowledge();
    await loadFolderState();
  } catch (_) {
    setDocStatus('The files could not be written.', 'kb-status is-error');
  } finally {
    refreshWriteButton();
  }
}

/**
 * Phase 20.20 — the manual re-index (§20's explicit fallback).
 *
 * The button is disabled for the duration rather than the request being left to race: two
 * concurrent forced rebuilds would each re-parse the whole base and the second would
 * invalidate the first's result for no benefit.
 */
async function reloadKnowledgeIndex() {
  const btn = document.getElementById('kb-reload');
  const statusEl = document.getElementById('kb-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Re-indexing…';
    statusEl.className = 'hint kb-status is-pending';
  }

  try {
    const response = await chrome.runtime.sendMessage({ action: 'RELOAD_KNOWLEDGE' });
    if (response && response.success === true) {
      renderKnowledgeStatus(response.status);
    } else {
      const message = (response && (response.error || response.code)) || 'the re-index failed';
      const el = document.getElementById('kb-status');
      if (el) {
        el.textContent = 'Re-index failed';
        el.className = 'hint kb-status is-error';
      }
      const detailEl = document.getElementById('kb-detail');
      if (detailEl) detailEl.textContent = String(message);
    }
  } catch (_) {
    const el = document.getElementById('kb-status');
    if (el) {
      el.textContent = 'Re-index failed';
      el.className = 'hint kb-status is-error';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}


/**
 * Phase 20.23 — §4's document management: list, add, edit, remove, enable/disable.
 *
 * WHY THIS EXISTS AT ALL. The store's `addKnowledgeDocument` / `updateKnowledgeDocument` /
 * `removeKnowledgeDocument` were implemented in 20.2, unit-tested, and called by NOTHING —
 * not by the worker, not by this page. A Knowledge Base nobody can put files into is not a
 * feature, and Phase 20.23 (real runtime testing) was blocked on exactly this: the first step
 * of the manual test is "add a knowledge file".
 *
 * MESSAGES ARE KEYED ON `reason`, NOT ON THE WORKER'S TEXT. The store already sends a
 * readable message, but a UI that renders another component's prose cannot adapt when that
 * prose is reworded, and `trigger-crud`/`fixed-reply` set the precedent here: branch on the
 * stable code, keep the wording here.
 *
 * NO `innerHTML` FOR ANYTHING THE USER TYPED. Document content is arbitrary Markdown and
 * filenames are user input, so the list is built with `createElement`/`textContent` exactly
 * as the Knowledge panel's skip-reason list is. The trigger list uses `innerHTML` with an
 * escaper because it renders only ids and fixed phrases; that is a different problem.
 */
const KNOWLEDGE_REJECTION_MESSAGES = {
  BAD_FILENAME: 'That filename is not usable. Use a relative path like books/chemistry.md — no "..", no leading slash.',
  EMPTY_CONTENT: 'The file is empty. A knowledge file needs at least one heading.',
  CONTENT_TOO_LONG: 'That file is too large to index. Split it into smaller files.',
  DUPLICATE_FILENAME: 'A knowledge file with that filename already exists. Edit it instead.',
  TOO_MANY_DOCUMENTS: 'You have reached the maximum number of knowledge files.',
  STORE_TOO_LARGE: 'Your knowledge base is too large in total. Remove or shorten a file.',
  NOT_FOUND: 'That knowledge file no longer exists. Reload the list and try again.'
};

/** The document currently open in the editor, or '' when adding a new one. */
let editingKnowledgeId = '';

/**
 * The last list the worker returned.
 *
 * Held so the delegated click handler can act on a row without re-reading: the row's dataset
 * carries only an id, and the content is already in hand. Deliberately not a second source of
 * truth for what is stored — `refreshKnowledge()` always re-reads after a change, so this can
 * only ever be a few hundred milliseconds stale.
 */
let knowledgeDocCache = [];

const knowledgeDocById = (id) =>
  knowledgeDocCache.find((d) => String(d.id) === String(id)) || null;

/** Show a message under the editor. `isError` tints it. */
function setKnowledgeMessage(text, isError) {
  const el = document.getElementById('kb-message');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'hint' + (isError ? ' is-error' : ' is-ok');
}

/** Turn a refused store call into a message worth reading. */
function describeKnowledgeFailure(response) {
  const reason = response && response.reason ? response.reason : '';
  if (reason && KNOWLEDGE_REJECTION_MESSAGES[reason]) return KNOWLEDGE_REJECTION_MESSAGES[reason];
  // A WRITE_FAILED carries the storage error, and the store's own text is the useful one.
  if (response && response.error) return String(response.error);
  return 'The knowledge base could not be changed.';
}

/**
 * Render the document list.
 *
 * Rebuilt wholesale on every change, so the click handlers are delegated on the container
 * rather than attached per row — the same reason the trigger list does it.
 */
function renderKnowledgeDocuments(documents, stats) {
  const container = document.getElementById('kb-list');
  if (!container) return;

  while (container.firstChild) container.removeChild(container.firstChild);

  const list = Array.isArray(documents) ? documents : [];

  knowledgeDocCache = list;

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No knowledge files yet. Add one below — plain Markdown, nothing to convert.';
    container.appendChild(empty);
  } else {
    for (const doc of list) {
      container.appendChild(buildKnowledgeRow(doc));
    }
  }

  const counts = document.getElementById('kb-counts');
  if (counts && stats) {
    counts.textContent = stats.total === 1
      ? `1 file, ${stats.enabled} enabled`
      : `${stats.total} files, ${stats.enabled} enabled`;
  }
}

/** One document row: name, size, enable toggle, edit, remove. */
function buildKnowledgeRow(doc) {
  const row = document.createElement('div');
  row.className = 'kb-row' + (doc.enabled === false ? ' is-off' : '');

  const main = document.createElement('div');
  main.className = 'kb-row-main';

  const name = document.createElement('span');
  name.className = 'kb-row-name';
  name.textContent = doc.filename;
  main.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'kb-row-meta';
  const chars = Number.isFinite(doc.charCount) ? doc.charCount : String(doc.content || '').length;
  meta.textContent = `${chars.toLocaleString()} chars · v${doc.version || 1}`;
  main.appendChild(meta);

  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'kb-row-actions';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost';
  toggle.dataset.kbToggle = String(doc.id);
  const enabled = doc.enabled !== false;
  toggle.textContent = enabled ? 'Disable' : 'Enable';
  toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  actions.appendChild(toggle);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-ghost';
  edit.dataset.kbEdit = String(doc.id);
  edit.textContent = 'Edit';
  actions.appendChild(edit);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-ghost';
  remove.dataset.kbRemove = String(doc.id);
  remove.textContent = 'Remove';
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

/**
 * Load the documents AND the index status together.
 *
 * One call each rather than one call per mutation: every add/edit/remove re-reads both, and
 * the index status is what proves the edit landed, which is the user's actual question after
 * pressing Save.
 */
async function refreshKnowledge() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_KNOWLEDGE_DOCUMENTS' });
    if (!response || response.success !== true) {
      throw new Error(describeKnowledgeFailure(response));
    }
    renderKnowledgeDocuments(response.documents, response.stats);
  } catch (error) {
    const container = document.getElementById('kb-list');
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
      const p = document.createElement('p');
      p.textContent = `The knowledge list could not be read: ${error.message}`;
      container.appendChild(p);
    }
  }
  await refreshKnowledgeStatus();
}

/** Put a document into the editor, or clear it when `doc` is null. */
function startKnowledgeEdit(doc) {
  const filenameEl = document.getElementById('kb-filename');
  const contentEl = document.getElementById('kb-content');
  const saveBtn = document.getElementById('kb-save');
  const cancelBtn = document.getElementById('kb-cancel');
  if (!filenameEl || !contentEl || !saveBtn) return;

  if (doc) {
    editingKnowledgeId = String(doc.id);
    filenameEl.value = doc.filename;
    contentEl.value = doc.content;
    saveBtn.textContent = 'Save changes';
    if (cancelBtn) cancelBtn.hidden = false;
    setKnowledgeMessage(`Editing ${doc.filename}`, false);
  } else {
    editingKnowledgeId = '';
    filenameEl.value = '';
    contentEl.value = '';
    saveBtn.textContent = 'Add file';
    if (cancelBtn) cancelBtn.hidden = true;
    setKnowledgeMessage('', false);
  }
}

/**
 * Save whatever is in the editor.
 *
 * The button is disabled for the duration, not just the request guarded: two rapid presses
 * would send the same document twice, and the second is rejected as a DUPLICATE_FILENAME
 * after the first has already succeeded — which reads to a user as "the save failed".
 */
async function saveKnowledgeDocument() {
  const filenameEl = document.getElementById('kb-filename');
  const contentEl = document.getElementById('kb-content');
  const saveBtn = document.getElementById('kb-save');
  if (!filenameEl || !contentEl || !saveBtn) return;

  const filename = filenameEl.value.trim();
  const content = contentEl.value;

  if (!editingKnowledgeId && !filename) {
    setKnowledgeMessage('Give the file a name, for example books/chemistry.md', true);
    return;
  }

  saveBtn.disabled = true;
  try {
    const response = editingKnowledgeId
      ? await chrome.runtime.sendMessage({
        action: 'UPDATE_KNOWLEDGE_DOCUMENT',
        documentId: editingKnowledgeId,
        // Only what the user can change. `version` and `updatedAt` are the store's business:
        // §18 reads them, so letting a form field write them would let a save rewrite the
        // precedence order the conflict rule depends on.
        updates: { content, filename }
      })
      : await chrome.runtime.sendMessage({
        action: 'ADD_KNOWLEDGE_DOCUMENT',
        document: { filename, content }
      });

    if (!response || response.success !== true) {
      setKnowledgeMessage(describeKnowledgeFailure(response), true);
      return;
    }

    const saved = response.document || {};

    // Reset the editor BEFORE reporting success, not after. `startKnowledgeEdit(null)`
    // clears the message line as part of returning the form to "add" mode, so reporting
    // first meant the confirmation was wiped a few lines later and the user never saw it —
    // the save looked like it had done nothing.
    startKnowledgeEdit(null);
    setKnowledgeMessage(`Saved ${saved.filename}. It answers from the next comment.`, false);
    await refreshKnowledge();
  } catch (error) {
    setKnowledgeMessage(String(error.message || error), true);
  } finally {
    saveBtn.disabled = false;
  }
}

/** Enable or disable one document — the same write as an edit, with no content change. */
async function toggleKnowledgeDocument(documentId, enabled) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'UPDATE_KNOWLEDGE_DOCUMENT',
      documentId,
      updates: { enabled }
    });
    if (!response || response.success !== true) {
      setKnowledgeMessage(describeKnowledgeFailure(response), true);
    } else {
      setKnowledgeMessage(`${response.document.filename} is now ${enabled ? 'enabled' : 'disabled'}.`, false);
    }
    await refreshKnowledge();
  } catch (error) {
    setKnowledgeMessage(String(error.message || error), true);
  }
}

/** Remove one document, after an explicit confirmation. */
async function removeKnowledgeDocument(documentId) {
  const response = await chrome.runtime.sendMessage({ action: 'GET_KNOWLEDGE_DOCUMENTS' });
  const doc = ((response && response.documents) || []).find((d) => String(d.id) === String(documentId));
  const name = doc ? doc.filename : 'this file';

  // Removal is the one destructive action in the panel and it has no undo, so it is
  // confirmed explicitly. `confirmRiskyChange()` is the in-page dialog already used for the
  // Phase 16.3 risky settings, rather than a second modal style.
  const confirmed = await confirmRiskyChange({
    title: 'Remove knowledge file',
    body: `${name} will be deleted from the Knowledge Base. Answers that came from it stop until it is added again.`,
    confirmLabel: 'Remove file'
  });
  if (!confirmed) return;

  try {
    const removed = await chrome.runtime.sendMessage({
      action: 'REMOVE_KNOWLEDGE_DOCUMENT',
      documentId
    });
    if (!removed || removed.success !== true) {
      setKnowledgeMessage(describeKnowledgeFailure(removed), true);
    } else {
      if (editingKnowledgeId === String(documentId)) startKnowledgeEdit(null);
      setKnowledgeMessage(`Removed ${(removed.removed && removed.removed.filename) || name}.`, false);
    }
    await refreshKnowledge();
  } catch (error) {
    setKnowledgeMessage(String(error.message || error), true);
  }
}

async function init() {
  await loadSettings();
  await loadTriggers();
  // Phase 19.5 — templates are stored separately from the settings form, so they get
  // their own load rather than riding along in loadSettings().
  await loadTemplates();
  // Phase 20.20/20.23 — the Knowledge Base: the index readout and the document list. Loaded
  // last and separately: it is the only panel block that talks to something other than the
  // settings store, and a knowledge failure must not stop the rest of the page rendering.
  await refreshKnowledge();

  const reloadBtn = document.getElementById('kb-reload');
  if (reloadBtn) reloadBtn.addEventListener('click', reloadKnowledgeIndex);

  // ── Phase 21.1 — the knowledge folder ──────────────────────────────────────
  await loadFolderState();

  const folderPick = document.getElementById('kb-folder-pick');
  if (folderPick) folderPick.addEventListener('click', pickKnowledgeFolder);

  const folderSync = document.getElementById('kb-folder-sync');
  if (folderSync) folderSync.addEventListener('click', syncKnowledgeFolderNow);

  const folderForget = document.getElementById('kb-folder-forget');
  if (folderForget) folderForget.addEventListener('click', forgetKnowledgeFolder);

  const docGenerate = document.getElementById('doc-generate');
  if (docGenerate) docGenerate.addEventListener('click', generateSplitFiles);

  const docWrite = document.getElementById('doc-write');
  if (docWrite) docWrite.addEventListener('click', writeSplitFiles);

  // Delegated on the container: the list is rebuilt wholesale after every change, so per-row
  // listeners would be thrown away each time.
  const kbSave = document.getElementById('kb-save');
  if (kbSave) kbSave.addEventListener('click', saveKnowledgeDocument);

  const kbCancel = document.getElementById('kb-cancel');
  if (kbCancel) kbCancel.addEventListener('click', () => startKnowledgeEdit(null));

  const kbList = document.getElementById('kb-list');
  if (kbList) {
    kbList.addEventListener('click', (event) => {
      const target = event.target;
      if (target.dataset && target.dataset.kbRemove) {
        removeKnowledgeDocument(target.dataset.kbRemove);
        return;
      }
      if (target.dataset && target.dataset.kbEdit) {
        // The content travels with the list, so editing needs no second read.
        const current = knowledgeDocById(target.dataset.kbEdit);
        if (current) startKnowledgeEdit(current);
        return;
      }
      if (target.dataset && target.dataset.kbToggle) {
        const current = knowledgeDocById(target.dataset.kbToggle);
        if (current) toggleKnowledgeDocument(current.id, current.enabled === false);
      }
    });
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 *
 * escapeHtml() goes through a text node, so it escapes &, < and > but leaves quotes
 * alone — fine for a phrase in element content, not for an id inside data-trigger-id.
 */
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Hide any displayed chat message.
 */
function hideChatMessage() {
  const chatResultEl = document.getElementById('chat-result');
  if (chatResultEl) {
    // Classes only. Clearing an inline display here would fight the inline
    // display:none on the markup, which is why that attribute was removed — the
    // .visible class is now the single source of truth for showing this box.
    chatResultEl.classList.remove('visible', 'success', 'error');
  }
}

/**
 * Clear any displayed chat error.
 */
function clearChatError() {
  const chatResultEl = document.getElementById('chat-result');
  if (chatResultEl) {
    chatResultEl.classList.remove('error');
  }
}

// Exported for the browser test harnesses in src/core/tests/ (trigger-delete-tests.js,
// safety-limits-tests.js, fixed-reply-tests.js), which drive the same render + save +
// delete paths the Options page uses. Nothing else imports this file, so the export costs
// nothing at runtime.
export {
  knowledgeDocById,
  toggleKnowledgeDocument,
  renderKnowledgeDocuments,
  buildKnowledgeRow,
  startKnowledgeEdit,
  describeKnowledgeFailure,
  renderTriggersList,
  handleDeleteTrigger,
  handleAddTrigger,
  readTriggerReplyMode,
  setTriggerReplyMode,
  renderTemplatesList,
  handleAddTemplate,
  handleActivateTemplate,
  handleDeleteTemplate,
  handleSave,
  loadSettings,
  confirmRiskyChange,
  readWholeNumber,
  SAFE_HOURLY_CAP,
  MAX_HOURLY_CAP,
  MAX_DELAY_SECONDS
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  debugLog('Settings page ready');
  
  // Initialize the page (loads settings and triggers)
  init();
  
  // Attach save handler to form
  const form = document.getElementById('settings-form');
  if (form) {
    form.addEventListener('submit', handleSave);
  }
  
  // Attach test connection button handler
  const testBtn = document.getElementById('test-connection-btn');
  if (testBtn) {
    testBtn.addEventListener('click', testConnection);
  }

  // The header shortcut runs the exact same test, so it reuses the same handler.
  const headerTestBtn = document.getElementById('header-test-btn');
  if (headerTestBtn) {
    headerTestBtn.addEventListener('click', testConnection);
  }
  
  // Attach chat completion test button handler
  const chatBtn = document.getElementById('test-chat-completion-btn');
  if (chatBtn) {
    chatBtn.addEventListener('click', testChatCompletion);
  }

  // Attach create-trigger handler
  const addTriggerBtn = document.getElementById('add-trigger-btn');
  if (addTriggerBtn) {
    addTriggerBtn.addEventListener('click', handleAddTrigger);
  }

  // Phase 19.6 — reply type. One delegated listener on the container covers both radios,
  // and the fixed-reply box starts hidden because the checked radio is the AI one.
  const replyModeAi = document.getElementById('trigger-reply-mode-ai');
  const replyModeFixed = document.getElementById('trigger-reply-mode-fixed');
  const fixedReplyRow = document.getElementById('trigger-fixed-reply-row');
  if (replyModeAi || replyModeFixed) {
    replyModeAi.addEventListener('change', handleReplyModeChange);
    replyModeFixed.addEventListener('change', handleReplyModeChange);
    handleReplyModeChange();
  }
  // Guarded for the browser test pages, which render only part of this form.
  if (fixedReplyRow) fixedReplyRow.style.display = 'none';

  // Phase 19.5 — template controls.
  const addTemplateBtn = document.getElementById('add-template-btn');
  if (addTemplateBtn) {
    addTemplateBtn.addEventListener('click', handleAddTemplate);
  }

  const templatesList = document.getElementById('templates-list');
  if (templatesList) {
    templatesList.addEventListener('click', (event) => {
      const useBtn = event.target.closest('[data-template-use]');
      if (useBtn) {
        handleActivateTemplate(useBtn.dataset.templateUse);
        return;
      }
      const deleteBtn = event.target.closest('[data-template-delete]');
      if (deleteBtn) {
        handleDeleteTemplate(deleteBtn.dataset.templateDelete);
      }
    });
  }

  // One delegated listener for every delete button. The list is re-rendered wholesale
  // after each add/delete, so per-button listeners would be thrown away each time.
  const triggersList = document.getElementById('triggers-list');
  if (triggersList) {
    triggersList.addEventListener('click', (event) => {
      const deleteBtn = event.target.closest('.trigger-delete');
      if (!deleteBtn) {
        return;
      }
      handleDeleteTrigger(deleteBtn.dataset.triggerId);
    });
  }

  // Sidebar navigation. Every entry is an in-page anchor, so the active pill only
  // has to follow the click — no routing, no state, no history to manage.
  const navItems = document.querySelectorAll('.nav-item[data-nav]');
  navItems.forEach((navItem) => {
    navItem.addEventListener('click', () => {
      navItems.forEach((other) => other.classList.remove('is-active'));
      navItem.classList.add('is-active');
    });
  });

  // Phase 23.1 — target-reply-hearting toggle.
  const heartingToggle = document.getElementById('target-reply-hearting');
  if (heartingToggle) {
    heartingToggle.addEventListener('change', async () => {
      const next = heartingToggle.checked === true;
      try {
        await saveSettings({ targetReplyHeartingEnabled: next });
        if (currentSettings) {
          currentSettings.targetReplyHeartingEnabled = next;
        }
      } catch (error) {
        logError('Error saving target reply hearting setting:', error);
        heartingToggle.checked = !next;
        showSafetyError('Error: Could not save setting');
      }
    });
  }

  // Keep settings honest when modified externally (e.g. Side Panel).
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.targetReplyHeartingEnabled) {
        const next = changes.targetReplyHeartingEnabled.newValue === true;
        const box = document.getElementById('target-reply-hearting');
        if (box) {
          box.checked = next;
        }
        if (currentSettings) {
          currentSettings.targetReplyHeartingEnabled = next;
        }
      }
      if (changes.replyBehavior) {
        const nextBehavior = changes.replyBehavior.newValue || {};
        if (nextBehavior.ignoreCreatorRepliedComments !== undefined) {
          const box = document.getElementById('ignore-creator-replied-comments');
          if (box) {
            box.checked = nextBehavior.ignoreCreatorRepliedComments !== false;
          }
        }
        if (nextBehavior.ignoreHeartedComments !== undefined) {
          const box = document.getElementById('ignore-hearted-comments');
          if (box) {
            box.checked = nextBehavior.ignoreHeartedComments !== false;
          }
        }
        if (currentSettings && currentSettings.replyBehavior) {
          Object.assign(currentSettings.replyBehavior, nextBehavior);
        }
      }
    });
  }
});