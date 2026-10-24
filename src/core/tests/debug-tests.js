/**
 * Diagnostics Logging Tests — Phase 18.3
 *
 * The switch itself is the thing under test: it must default to off, it must refuse
 * anything that is not a strict boolean true, and it must gate progress lines without
 * ever swallowing a real error.
 *
 * Runs in the browser from debug-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before debug.js is
 * evaluated.
 */

import { resetStorage, readStore, store as liveStore } from './chrome-storage-stub.js';
import {
  loadDebugSetting,
  isDebugEnabled,
  setDebugEnabled,
  debugLog,
  debugWarn,
  logError,
  DEBUG_STORAGE_KEY
} from '../debug.js';

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

/**
 * Capture what a callable writes to the console.
 * Restores the real console methods even if the callback throws.
 */
async function capture(fn) {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => seen.log.push(a.join(' '));
  console.warn = (...a) => seen.warn.push(a.join(' '));
  console.error = (...a) => seen.error.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return seen;
}

async function testDefaultsToOff() {
  resetStorage();
  const enabled = await loadDebugSetting();
  if (enabled !== false) return 'Expected a missing flag to read as off';
  if (isDebugEnabled() !== false) return 'Cache should mirror the stored value';
  return true;
}

async function testWritesAndCaches() {
  resetStorage();
  await setDebugEnabled(true);
  if (readStore()[DEBUG_STORAGE_KEY] !== true) return 'Expected the flag to be stored';
  if (isDebugEnabled() !== true) return 'Cache should update immediately';
  if ((await loadDebugSetting()) !== true) return 'A reload should read the stored value back';
  return true;
}

async function testOnlyStrictTrueEnables() {
  resetStorage();
  for (const value of ['true', 1, 'yes', {}, [], 'TRUE']) {
    await setDebugEnabled(value);
    if (isDebugEnabled() !== false) return `Expected ${JSON.stringify(value)} to be rejected`;
    if (readStore()[DEBUG_STORAGE_KEY] !== false) return `Expected ${JSON.stringify(value)} to store false`;
  }
  return true;
}

async function testProgressLinesAreGated() {
  resetStorage();
  await loadDebugSetting();
  const off = await capture(() => { debugLog('hidden'); debugWarn('hidden too'); });
  if (off.log.length || off.warn.length) return 'Progress lines must be silent while diagnostics are off';

  await setDebugEnabled(true);
  const on = await capture(() => { debugLog('visible'); debugWarn('warned'); });
  if (on.log.length !== 1) return `Expected 1 logged line, got ${on.log.length}`;
  if (on.warn.length !== 1) return `Expected 1 warning line, got ${on.warn.length}`;
  if (!/visible/.test(on.log[0])) return `Unexpected log content: ${on.log[0]}`;
  return true;
}

async function testEveryLineCarriesThePrefix() {
  resetStorage();
  await setDebugEnabled(true);
  const seen = await capture(() => debugLog('body'));
  if (!/^\[YouTube Auto Reply\] body$/.test(seen.log[0])) {
    return `Expected the standard prefix, got "${seen.log[0]}"`;
  }
  return true;
}

async function testErrorsAlwaysPrint() {
  resetStorage();
  await loadDebugSetting();
  const seen = await capture(() => logError('real failure'));
  if (seen.error.length !== 1) return 'A real error must print even with diagnostics off';
  if (!/real failure/.test(seen.error[0])) return 'Error content was lost';
  return true;
}

async function testTurnOffAgain() {
  resetStorage();
  await setDebugEnabled(true);
  await setDebugEnabled(false);
  if (isDebugEnabled() !== false) return 'Expected the flag to go back off';
  const seen = await capture(() => debugLog('hidden again'));
  if (seen.log.length) return 'Progress lines must be silent again after turning off';
  return true;
}

async function testKeyIsNotASetting() {
  // The flag must stay out of DEFAULT_CONFIG / getSettings(): that list only loads
  // settings, and a top-level key there would never be written by this module.
  resetStorage();
  await setDebugEnabled(true);
  const { DEFAULT_CONFIG } = await import('../config.js');
  if (DEBUG_STORAGE_KEY in DEFAULT_CONFIG) return 'debugMode must not be part of DEFAULT_CONFIG';
  if (liveStore.replyBehavior && DEBUG_STORAGE_KEY in liveStore.replyBehavior) {
    return 'debugMode must not be nested inside replyBehavior';
  }
  return true;
}

async function runAllTests() {
  console.log('\n=== Diagnostics Logging Tests (Phase 18.3) ===\n');

  await runTest('Diagnostics default to off', testDefaultsToOff);
  await runTest('Enabling writes the flag and updates the cache', testWritesAndCaches);
  await runTest('Only a strict boolean true enables diagnostics', testOnlyStrictTrueEnables);
  await runTest('Progress lines are gated by the flag', testProgressLinesAreGated);
  await runTest('Every gated line carries the standard prefix', testEveryLineCarriesThePrefix);
  await runTest('Errors print even with diagnostics off', testErrorsAlwaysPrint);
  await runTest('Diagnostics can be turned back off', testTurnOffAgain);
  await runTest('The flag is not a settings key', testKeyIsNotASetting);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;