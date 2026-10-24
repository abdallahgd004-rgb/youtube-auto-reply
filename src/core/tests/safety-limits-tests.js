/**
 * Safety & Limits Tests — Phase 16.3
 *
 * Focused coverage for the settings that decide whether a reply is actually posted
 * and how fast: dry run, the hourly cap, and the reply delay. The point of the phase
 * is not that these values save — it is that a risky value CANNOT save silently.
 *
 * Runs in the browser from safety-limits-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * storage.js is evaluated.
 */

import { resetStorage, readStore, store as liveStore } from './chrome-storage-stub.js';
import { DEFAULT_CONFIG } from '../config.js';
import { getTemplates } from '../context-templates.js';
import {
  handleSave,
  loadSettings,
  renderTriggersList,
  renderTemplatesList,
  handleAddTemplate,
  handleActivateTemplate,
  handleDeleteTemplate,
  readWholeNumber,
  SAFE_HOURLY_CAP,
  MAX_HOURLY_CAP,
  MAX_DELAY_SECONDS
} from '../../options/options.js';

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

/** A submit event stand-in: handleSave only calls preventDefault(). */
function submitEvent() {
  return { preventDefault() {} };
}

/** Put the safety form into a known-good, non-risky state. */
function fillSafeForm(overrides = {}) {
  const values = {
    baseUrl: 'http://localhost:1234/v1',
    model: 'stub-model',
    cap: '30',
    minDelay: '8',
    maxDelay: '20',
    dryRun: true,
    blacklist: '',
    ...overrides
  };
  document.getElementById('baseUrl').value = values.baseUrl;
  document.getElementById('model').value = values.model;
  document.getElementById('max-replies-per-hour').value = values.cap;
  document.getElementById('reply-delay-min').value = values.minDelay;
  document.getElementById('reply-delay-max').value = values.maxDelay;
  document.getElementById('dry-run').checked = values.dryRun;
  const blacklist = document.getElementById('reply-blacklist');
  if (blacklist) blacklist.value = values.blacklist;
  return values;
}

/** Wait until the confirmation panel is showing (handleSave awaits the answer). */
async function waitForConfirm(timeoutMs = 1000) {
  const panel = document.getElementById('confirm-panel');
  const started = Date.now();
  while (panel.hidden && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !panel.hidden;
}

/** Run a save and answer the confirmation dialog with the given choice. */
async function saveWithConfirm(choice) {
  const saving = handleSave(submitEvent());
  await waitForConfirm();
  if (choice === 'accept') document.getElementById('confirm-accept').click();
  else if (choice === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  else document.getElementById('confirm-cancel').click();
  await saving;
}

function safetyError() {
  const el = document.getElementById('safety-error');
  return el && el.style.display === 'block' ? el.textContent : '';
}

/** The template form has its own error box; it is not the safety one. */
function templateError() {
  const el = document.getElementById('template-error');
  return el && el.style.display === 'block' ? el.textContent : '';
}

// ── readWholeNumber ──────────────────────────────────────────────────────────

async function testReadWholeNumber() {
  if (readWholeNumber('30', 1, 600) !== 30) return 'Expected "30" to parse';
  if (readWholeNumber(' 12 ', 1, 600) !== 12) return 'Expected surrounding space to be tolerated';
  if (readWholeNumber('', 1, 600) !== null) return 'Expected empty string to be rejected';
  if (readWholeNumber('abc', 1, 600) !== null) return 'Expected non-numeric to be rejected';
  if (readWholeNumber('1.5', 1, 600) !== null) return 'Expected a decimal to be rejected';
  if (readWholeNumber('0', 1, 600) !== null) return 'Expected 0 to be below the minimum';
  if (readWholeNumber('601', 1, 600) !== null) return 'Expected 601 to be above the maximum';
  if (readWholeNumber('1e3', 1, 600) !== 1000 && readWholeNumber('1e3', 1, 600) !== null) {
    return 'Exponent form should either parse to 1000 or be rejected, not something else';
  }
  return true;
}

// ── ordinary save ────────────────────────────────────────────────────────────

async function testValidSaveIsPersisted() {
  resetStorage();
  fillSafeForm();
  await handleSave(submitEvent());
  const store = readStore();
  if (store.dryRun !== true) return 'Expected dryRun to stay true';
  if (store.replyBehavior.maxRepliesPerHour !== 30) return 'Hourly cap was not saved';
  if (store.replyBehavior.minDelayMs !== 8000) return 'Min delay was not converted to ms';
  if (store.replyBehavior.maxDelayMs !== 20000) return 'Max delay was not converted to ms';
  if (store.lmStudio.baseUrl !== 'http://localhost:1234/v1') return 'Base URL changed unexpectedly';
  return true;
}

async function testSavePreservesUnrelatedSettings() {
  resetStorage();
  // Seed through the LIVE stub store: readStore() hands back a deep copy, so writing
  // into it would never reach the code under test. loadSettings() then refreshes the
  // module-level snapshot the save merges against — the Options page does the same
  // once, on open.
  liveStore.lmStudio = { baseUrl: 'http://localhost:1234/v1', systemPrompt: 'keep me' };
  await loadSettings();
  fillSafeForm();
  await handleSave(submitEvent());
  const after = readStore();
  if (after.lmStudio.systemPrompt !== 'keep me') return 'systemPrompt was lost on save';
  if (after.replyBehavior.minDelayMs !== 8000) return 'Delay did not survive the merge';
  if (after.replyBehavior.maxRepliesPerHour !== 30) return 'Cap did not survive the merge';
  return true;
}

async function testBaseUrlGetsV1Appended() {
  resetStorage();
  fillSafeForm({ baseUrl: 'localhost:1234' });
  await handleSave(submitEvent());
  // normalizeBaseUrl appends the OpenAI-compatible prefix; it does not invent a
  // scheme, so a scheme-less value is expected to stay scheme-less.
  if (readStore().lmStudio.baseUrl !== 'localhost:1234/v1') {
    return `Expected the /v1 suffix to be appended, got ${readStore().lmStudio.baseUrl}`;
  }
  return true;
}

// ── validation ───────────────────────────────────────────────────────────────

async function testInvalidCapBlocksSave() {
  resetStorage();
  fillSafeForm({ cap: '0' });
  await handleSave(submitEvent());
  if (!safetyError()) return 'Expected a visible error for an out-of-range cap';
  if (readStore().dryRun !== undefined) return 'Nothing may be written when validation fails';
  return true;
}

async function testInvertedDelaysBlockSave() {
  resetStorage();
  fillSafeForm({ minDelay: '30', maxDelay: '5' });
  await handleSave(submitEvent());
  if (!safetyError()) return 'Expected an error when max delay is below min delay';
  if (readStore().replyBehavior) return 'Nothing may be written when the delay range is inverted';
  return true;
}

async function testOversizedDelayBlocksSave() {
  resetStorage();
  fillSafeForm({ maxDelay: String(MAX_DELAY_SECONDS + 1) });
  await handleSave(submitEvent());
  if (!safetyError()) return 'Expected an error for a delay beyond the allowed range';
  return true;
}

// ── Task 16.3 — risky values need confirmation ───────────────────────────────

async function testTurningOffDryRunAsksFirst() {
  resetStorage();
  fillSafeForm({ dryRun: false });
  const saving = handleSave(submitEvent());
  const shown = await waitForConfirm();
  if (!shown) return 'Expected the confirmation panel to appear';
  const body = document.getElementById('confirm-body').textContent;
  if (!/publish|post/i.test(body)) return 'Expected the dialog to explain that replies get posted';
  await saveWithConfirm('cancel');
  await saving;
  if (readStore().dryRun !== undefined) return 'Cancelling must not write dryRun=false';
  if (document.getElementById('dry-run').checked !== true) return 'Cancelling must restore the checkbox';
  if (!safetyError()) return 'Expected a cancellation notice';
  return true;
}

async function testConfirmingDryRunOffSavesIt() {
  resetStorage();
  fillSafeForm({ dryRun: false });
  await saveWithConfirm('accept');
  if (readStore().dryRun !== false) return 'Confirming must persist dryRun=false';
  if (document.getElementById('confirm-panel').hidden !== true) return 'The panel must close after confirming';
  return true;
}

async function testEscapeCancelsConfirmation() {
  resetStorage();
  fillSafeForm({ dryRun: false });
  await saveWithConfirm('escape');
  if (readStore().dryRun !== undefined) return 'Escape must cancel the save';
  if (document.getElementById('confirm-panel').hidden !== true) return 'The panel must close on Escape';
  return true;
}

async function testHighCapNeedsConfirmation() {
  resetStorage();
  const cap = SAFE_HOURLY_CAP + 1;
  fillSafeForm({ cap: String(cap) });
  const saving = handleSave(submitEvent());
  const shown = await waitForConfirm();
  if (!shown) return `Expected a confirmation for a cap of ${cap}`;
  const accept = document.getElementById('confirm-accept');
  if (accept.textContent !== `Allow ${cap}/hour`) return `Unexpected confirm label: ${accept.textContent}`;
  await saveWithConfirm('cancel');
  await saving;
  if (readStore().replyBehavior) return 'Cancelling must not write the risky cap';
  return true;
}

async function testConfirmingHighCapSavesIt() {
  resetStorage();
  const cap = SAFE_HOURLY_CAP + 1;
  fillSafeForm({ cap: String(cap) });
  await saveWithConfirm('accept');
  if (readStore().replyBehavior.maxRepliesPerHour !== cap) return 'Confirming must persist the higher cap';
  return true;
}

async function testCapAtThresholdNeedsNoConfirmation() {
  resetStorage();
  fillSafeForm({ cap: String(SAFE_HOURLY_CAP) });
  await handleSave(submitEvent());
  if (document.getElementById('confirm-panel').hidden !== true) {
    return 'A cap exactly at the safe threshold must save without a dialog';
  }
  if (readStore().replyBehavior.maxRepliesPerHour !== SAFE_HOURLY_CAP) return 'Cap was not saved';
  return true;
}

async function testCapCeilingIsEnforced() {
  resetStorage();
  fillSafeForm({ cap: String(MAX_HOURLY_CAP + 1) });
  await handleSave(submitEvent());
  if (!safetyError()) return `A cap above ${MAX_HOURLY_CAP} must be rejected before any confirmation`;
  return true;
}

// ── diagnostics flag ─────────────────────────────────────────────────────────

async function testDiagnosticsFlagIsWrittenSeparately() {
  resetStorage();
  fillSafeForm();
  document.getElementById('debug-mode').checked = true;
  await handleSave(submitEvent());
  const store = readStore();
  if (store.debugMode !== true) return 'Expected debugMode to be written as its own top-level key';
  if (store.replyBehavior.debugMode !== undefined) return 'debugMode must not leak into replyBehavior';
  return true;
}

// ── regression guard: the trigger rows the redesign renders ──────────────────

async function testTriggerRowsCarryDeleteButtons() {
  const container = document.getElementById('triggers-list');
  renderTriggersList([
    { id: 'rule-1', phrases: ['بكام'], matchMode: 'contains', enabled: true, caseSensitive: false },
    { id: 'rule-2', phrases: ['السعر'], matchMode: 'exact', enabled: false, caseSensitive: true }
  ]);
  const rows = container.querySelectorAll('.trigger-item');
  if (rows.length !== 2) return `Expected 2 rows, got ${rows.length}`;
  const ids = [...container.querySelectorAll('.trigger-delete')].map((b) => b.dataset.triggerId);
  if (ids.length !== 2) return `Expected 2 delete buttons, got ${ids.length}`;
  if (ids[0] !== 'rule-1' || ids[1] !== 'rule-2') return 'Delete buttons must carry their own row id';
  return true;
}

async function testDefaultsAreWithinTheValidatedBounds() {
  const b = DEFAULT_CONFIG.replyBehavior;
  if (b.maxRepliesPerHour < 1 || b.maxRepliesPerHour > MAX_HOURLY_CAP) return 'Default cap is out of range';
  if (b.minDelayMs < 0 || b.maxDelayMs < b.minDelayMs) return 'Default delay range is invalid';
  if (b.maxDelayMs > MAX_DELAY_SECONDS * 1000) return 'Default max delay is out of range';
  return true;
}


async function testEmptyBlacklistKeepsTheBuiltInList() {
  // Clearing the box must not switch the check OFF: an empty list means "use the
  // built-in list", which takes a deliberate edit rather than an empty field.
  resetStorage();
  fillSafeForm({ blacklist: '' });
  await handleSave(submitEvent());
  const saved = readStore().replyBehavior.blacklist;
  if (!Array.isArray(saved) || saved.length === 0) return 'An empty box should fall back to the defaults';
  if (!saved.some((p) => /ai/i.test(p))) return `Expected the built-in list, got ${JSON.stringify(saved)}`;
  return true;
}

async function testCustomBlacklistRoundTrips() {
  resetStorage();
  // Leading/trailing spaces and an empty entry between commas must all be handled.
  fillSafeForm({ blacklist: '  عرض خاص ,  , خصم  ' });
  await handleSave(submitEvent());
  const saved = readStore().replyBehavior.blacklist;
  if (JSON.stringify(saved) !== JSON.stringify(['عرض خاص', 'خصم'])) {
    return `Expected a trimmed, non-empty list, got ${JSON.stringify(saved)}`;
  }
  return true;
}

async function testBlacklistSurvivesTheReplyMerge() {
  resetStorage();
  liveStore.replyBehavior = { blacklist: ['كلمة محفوظة'], minDelayMs: 8000, maxDelayMs: 20000, maxRepliesPerHour: 30 };
  // loadSettings fills the form from storage; saving straight afterwards must not
  // disturb a value the user never touched. fillSafeForm() is deliberately NOT called
  // here, because it would overwrite the field and defeat the point of the test.
  await loadSettings();
  await handleSave(submitEvent());
  if (!readStore().replyBehavior.blacklist.includes('كلمة محفوظة')) return 'An untouched blacklist was overwritten';
  return true;
}


async function testTemplateAddValidatesThenPersists() {
  resetStorage();
  renderTemplatesList([]);
  await handleAddTemplate();
  if (!templateError()) return 'A blank form should be refused rather than stored';
  if ((await getTemplates()).length !== 0) return 'Nothing should be stored';

  document.getElementById('template-name').value = 'الأسعار';
  document.getElementById('template-body').value = 'منتج Acme Pro بسعر ٩٩ جنيهًا';
  await handleAddTemplate();

  const list = await getTemplates();
  if (list.length !== 1) return `Expected 1 template, got ${list.length}`;
  if (document.getElementById('template-name').value !== '') return 'The form should reset after adding';
  return true;
}

async function testTemplateRowsShowTheActiveOne() {
  const container = document.getElementById('templates-list');
  renderTemplatesList([
    { id: 'tpl-a', name: 'الأسعار', body: 'سعر المنتج ٩٩', enabled: true },
    { id: 'tpl-b', name: 'الشحن', body: 'الشحن三天', enabled: false }
  ]);
  const rows = container.querySelectorAll('.trigger-item');
  if (rows.length !== 2) return `Expected 2 rows, got ${rows.length}`;
  if (!rows[0].classList.contains('is-active')) return 'The active row should be marked';
  if (rows[1].classList.contains('is-active')) return 'Only one row should be marked';
  const useBtn = container.querySelector('[data-template-use]');
  if (!useBtn || useBtn.dataset.templateUse !== 'tpl-b') return 'The inactive row should offer a Use button';
  if (!container.querySelector('[data-template-delete="tpl-a"]')) return 'Each row needs its own delete button';
  return true;
}

async function testTemplateActivationThroughTheUi() {
  resetStorage();

  // First template: the form starts empty, so fill it the way a user would.
  document.getElementById('template-name').value = 'الأسعار';
  document.getElementById('template-body').value = 'سعر المنتج ٩٩ جنيه';
  await handleAddTemplate();
  const afterFirst = await getTemplates();
  if (afterFirst.length !== 1) return 'The first add should have stored one template';

  // Second template.
  document.getElementById('template-name').value = 'الشحن';
  document.getElementById('template-body').value = 'الشحن خلال ثلاثة أيام';
  await handleAddTemplate();
  const list = await getTemplates();
  if (list.length !== 2) return `Expected 2 templates, got ${list.length}`;

  const activeBefore = list.find((t) => t.enabled);
  const target = list.find((t) => !t.enabled);
  await handleActivateTemplate(target.id);

  const after = await getTemplates();
  if (after.filter((t) => t.enabled).length !== 1) return 'Exactly one template must stay active';
  if (!after.find((t) => t.id === target.id).enabled) return 'The requested template should be active';
  if (after.find((t) => t.id === activeBefore.id).enabled) return 'The previous template should be off';
  return true;
}

async function testTemplateDeletionThroughTheUi() {
  resetStorage();
  document.getElementById('template-name').value = 'الأسعار';
  document.getElementById('template-body').value = 'سعر ٩٩';
  await handleAddTemplate();
  const created = (await getTemplates())[0];

  await handleDeleteTemplate('does-not-exist');
  if ((await getTemplates()).length !== 1) return 'Deleting an unknown id must change nothing';

  await handleDeleteTemplate(created.id);
  if ((await getTemplates()).length !== 0) return 'The template should be gone';
  renderTemplatesList([]);
  if (!document.getElementById('templates-list').querySelector('p')) return 'The empty state should return';
  return true;
}

async function runAllTests() {
  console.log('\n=== Safety & Limits Tests (Phase 16.3) ===\n');

  await runTest('readWholeNumber accepts only whole numbers in range', testReadWholeNumber);
  await runTest('A valid save persists cap, delays and dry run', testValidSaveIsPersisted);
  await runTest('A save keeps unrelated settings', testSavePreservesUnrelatedSettings);
  await runTest('Base URL still gets /v1 appended', testBaseUrlGetsV1Appended);
  await runTest('An out-of-range cap blocks the save', testInvalidCapBlocksSave);
  await runTest('An inverted delay range blocks the save', testInvertedDelaysBlockSave);
  await runTest('A delay beyond the allowed range blocks the save', testOversizedDelayBlocksSave);
  await runTest('Turning dry run off asks first', testTurningOffDryRunAsksFirst);
  await runTest('Confirming dry run off saves it', testConfirmingDryRunOffSavesIt);
  await runTest('Escape cancels the confirmation', testEscapeCancelsConfirmation);
  await runTest('A cap above the safe threshold asks first', testHighCapNeedsConfirmation);
  await runTest('Confirming a higher cap saves it', testConfirmingHighCapSavesIt);
  await runTest('A cap at the safe threshold saves without a dialog', testCapAtThresholdNeedsNoConfirmation);
  await runTest('A cap beyond the ceiling is rejected', testCapCeilingIsEnforced);
  await runTest('The diagnostics flag is its own storage key', testDiagnosticsFlagIsWrittenSeparately);
  await runTest('Trigger rows carry per-row delete buttons', testTriggerRowsCarryDeleteButtons);
  await runTest('Default limits sit inside the validated bounds', testDefaultsAreWithinTheValidatedBounds);
  await runTest('An empty blacklist keeps the built-in list', testEmptyBlacklistKeepsTheBuiltInList);
  await runTest('A custom blacklist round-trips', testCustomBlacklistRoundTrips);
  await runTest('An untouched blacklist survives the merge', testBlacklistSurvivesTheReplyMerge);
  await runTest('Adding a template validates then persists', testTemplateAddValidatesThenPersists);
  await runTest('Template rows mark the active one', testTemplateRowsShowTheActiveOne);
  await runTest('Activation through the UI keeps exactly one active', testTemplateActivationThroughTheUi);
  await runTest('Deletion through the UI', testTemplateDeletionThroughTheUi);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;