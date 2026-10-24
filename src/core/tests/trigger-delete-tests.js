/**
 * Trigger Delete Tests
 *
 * Focused coverage for deleting a single trigger from the Triggers list:
 * one trigger is removed while the others survive, a duplicate phrase is not
 * collateral damage, an unknown id is handled safely, and the rendered list
 * reflects exactly what was saved.
 *
 * Runs in the browser from trigger-delete-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * storage.js is evaluated.
 */

import { resetStorage, readStore } from './chrome-storage-stub.js';
import { addTrigger, deleteTrigger, getTriggers } from '../trigger-crud.js';
import { renderTriggersList, handleDeleteTrigger } from '../../options/options.js';

const results = { total: 0, passed: 0, failed: 0 };

/**
 * Run one async test case.
 */
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

/**
 * Test 1: deleting one trigger preserves the others.
 */
async function testDeletePreservesOthers() {
  resetStorage();

  const keepA = await addTrigger({ phrases: ['بكام'] });
  const drop = await addTrigger({ phrases: ['السعر'] });
  const keepB = await addTrigger({ phrases: ['منين أجيب'] });

  await deleteTrigger(drop.id);

  const remaining = await getTriggers();
  const ids = remaining.map((t) => t.id);

  if (remaining.length !== 2) {
    return `Expected 2 remaining triggers, got ${remaining.length}`;
  }
  if (!ids.includes(keepA.id) || !ids.includes(keepB.id)) {
    return 'Expected the untouched triggers to survive';
  }
  if (ids.includes(drop.id)) {
    return 'Deleted trigger is still present';
  }
  return true;
}

/**
 * Test 2: two triggers sharing a phrase — deleting one leaves the other.
 *
 * Deleting by phrase would take both, which is why the button carries the id.
 */
async function testDuplicatePhraseDeletesOnlyOne() {
  resetStorage();

  const first = await addTrigger({ phrases: ['بكام'] });
  await addTrigger({ phrases: ['بكام'] });

  await deleteTrigger(first.id);

  const remaining = await getTriggers();

  if (remaining.length !== 1) {
    return `Expected exactly 1 remaining duplicate, got ${remaining.length}`;
  }
  if (remaining[0].phrases[0] !== 'بكام') {
    return `Unexpected remaining phrase: ${remaining[0].phrases[0]}`;
  }
  return true;
}

/**
 * Test 3: deleting an id that does not exist rejects and changes nothing.
 */
async function testDeleteUnknownIdIsSafe() {
  resetStorage();

  const keep = await addTrigger({ phrases: ['بكام'] });

  let threw = false;
  try {
    await deleteTrigger('rule-does-not-exist');
  } catch (error) {
    threw = /not found/.test(error.message);
  }

  if (!threw) {
    return 'Expected deleteTrigger() to reject for an unknown id';
  }

  const remaining = await getTriggers();
  if (remaining.length !== 1 || remaining[0].id !== keep.id) {
    return 'Failed delete must not alter the stored triggers';
  }
  return true;
}

/**
 * Test 4: the Options-page handler swallows the unknown-id error, surfaces it in
 * the existing #trigger-error box, and leaves the list alone.
 */
async function testHandleDeleteUnknownIdShowsError() {
  resetStorage();
  await addTrigger({ phrases: ['بكام'] });

  const container = document.getElementById('triggers-list');
  const errorEl = document.getElementById('trigger-error');

  renderTriggersList(await getTriggers());

  await handleDeleteTrigger('rule-does-not-exist');

  if (errorEl.style.display !== 'block' || !errorEl.textContent) {
    return 'Expected a visible trigger error message';
  }
  if (container.querySelectorAll('.trigger-item').length !== 1) {
    return 'List should still show the single remaining trigger';
  }
  return true;
}

/**
 * Test 5: after deleting, the rendered list shows exactly the saved triggers,
 * each with a delete button carrying that row's own id.
 */
async function testRenderAfterDelete() {
  resetStorage();

  const keepArabic = await addTrigger({ phrases: ['بكام', 'السعر'], matchMode: 'contains' });
  const drop = await addTrigger({ phrases: ['منين أجيب'] });
  const keepPaused = await addTrigger({ phrases: ['شحن'], enabled: false });

  const container = document.getElementById('triggers-list');
  const errorEl = document.getElementById('trigger-error');

  renderTriggersList(await getTriggers());
  await handleDeleteTrigger(drop.id);

  if (errorEl.style.display === 'block') {
    return `Unexpected error shown: ${errorEl.textContent}`;
  }

  const rows = container.querySelectorAll('.trigger-item');
  if (rows.length !== 2) {
    return `Expected 2 rendered rows, got ${rows.length}`;
  }

  const html = container.innerHTML;
  if (html.includes('منين أجيب')) {
    return 'Deleted trigger still rendered';
  }
  if (!html.includes('بكام') || !html.includes('السعر') || !html.includes('شحن')) {
    return 'Remaining triggers are missing from the rendered list';
  }
  if (!container.querySelector('.trigger-item.disabled')) {
    return 'Paused trigger lost its disabled styling';
  }

  const deleteIds = [...container.querySelectorAll('.trigger-delete')]
    .map((btn) => btn.dataset.triggerId);
  if (deleteIds.length !== 2) {
    return `Expected 2 delete buttons, got ${deleteIds.length}`;
  }
  if (!deleteIds.includes(keepArabic.id) || !deleteIds.includes(keepPaused.id)) {
    return 'Delete buttons do not carry the surviving trigger ids';
  }
  if (deleteIds.includes(drop.id)) {
    return 'Deleted trigger still has a delete button';
  }
  return true;
}

/**
 * Test 6: the stored settings match the rendered list after deletion.
 */
async function testStorageMatchesRender() {
  const saved = readStore().triggers || [];
  const container = document.getElementById('triggers-list');
  const rows = container.querySelectorAll('.trigger-item');

  if (saved.length !== rows.length) {
    return `Stored ${saved.length} triggers but rendered ${rows.length} rows`;
  }
  return true;
}

/**
 * Run all tests and print a summary.
 */
async function runAllTests() {
  console.log('\n=== Trigger Delete Tests ===\n');

  await runTest('Delete preserves other triggers', testDeletePreservesOthers);
  await runTest('Duplicate phrase: only the clicked one is deleted', testDuplicatePhraseDeletesOnlyOne);
  await runTest('Deleting an unknown id is safe', testDeleteUnknownIdIsSafe);
  await runTest('Unknown id surfaces an error in the UI', testHandleDeleteUnknownIdShowsError);
  await runTest('List renders the remaining triggers after deletion', testRenderAfterDelete);
  await runTest('Stored triggers match the rendered list', testStorageMatchesRender);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;