/**
 * LM Studio Timeout Tests
 *
 * Focused coverage for the single timeout constant in src/background/api-client.js:
 * the request must abort at 60,000 ms (not 30,000 ms), an abort must still surface
 * exactly LM_STUDIO_TIMEOUT_MESSAGE, an unreachable server must still be classified
 * as offline, and the pre-flight model check must be untouched.
 *
 * Runs in the browser from api-client-timeout-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * storage.js is evaluated.
 */

import { store, resetStorage } from './chrome-storage-stub.js';
import {
  chatCompletion,
  getModels,
  LM_STUDIO_TIMEOUT_MESSAGE,
  LM_STUDIO_OFFLINE_MESSAGE,
  LM_STUDIO_NO_MODEL_MESSAGE,
  LM_STUDIO_INVALID_MODEL_MESSAGE
} from '../../background/api-client.js';

const EXPECTED_TIMEOUT_MS = 60000;
const LEGACY_TIMEOUT_MS = 30000;

const results = { total: 0, passed: 0, failed: 0 };

/** Point storage at a usable LM Studio config for the tests below. */
function primeSettings() {
  resetStorage();
  store.lmStudio = {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    model: 'test-model'
  };
}

/**
 * Run `fn` with a stubbed `fetch` and a `setTimeout` that records the requested
 * delay and fires its callback on the next macrotask.
 *
 * The recorded delay is what the assertion is about: it is the value
 * DEFAULT_TIMEOUT_MS was asked to wait, without actually waiting for it.
 *
 * @param {(info: {delays: number[]}) => any} fetchImpl - the fake fetch
 * @param {() => Promise<any>} fn - the code under test
 */
async function withStubs(fetchImpl, fn) {
  const realSetTimeout = globalThis.setTimeout;
  const realFetch = globalThis.fetch;
  const delays = [];

  globalThis.setTimeout = (callback, delay, ...rest) => {
    delays.push(delay);
    return realSetTimeout(callback, 0, ...rest);
  };
  globalThis.fetch = fetchImpl;

  try {
    return { result: await fn(), delays };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
  }
}

/** A fetch that never answers and only rejects when the abort signal fires. */
function neverAnsweringFetch() {
  return (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
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

/**
 * Test 1: chatCompletion aborts at 60,000 ms, not the old 30,000 ms.
 */
async function testTimeoutIsSixtySeconds() {
  primeSettings();

  const { delays } = await withStubs(neverAnsweringFetch(), async () => {
    try {
      await chatCompletion([{ role: 'user', content: 'hi' }]);
      return true;
    } catch (_) {
      return true;
    }
  });

  if (!delays.includes(EXPECTED_TIMEOUT_MS)) {
    return `Expected a ${EXPECTED_TIMEOUT_MS} ms timeout, saw delays: ${delays.join(', ')}`;
  }
  if (delays.includes(LEGACY_TIMEOUT_MS)) {
    return `Request still uses the old ${LEGACY_TIMEOUT_MS} ms timeout`;
  }
  return true;
}

/**
 * Test 2: the models request shares the same 60,000 ms timeout.
 */
async function testModelsTimeoutIsSixtySeconds() {
  primeSettings();

  const { delays } = await withStubs(neverAnsweringFetch(), async () => {
    try {
      await getModels();
      return true;
    } catch (_) {
      return true;
    }
  });

  if (!delays.includes(EXPECTED_TIMEOUT_MS)) {
    return `Expected a ${EXPECTED_TIMEOUT_MS} ms timeout, saw delays: ${delays.join(', ')}`;
  }
  return true;
}

/**
 * Test 3: an aborted request still produces LM_STUDIO_TIMEOUT_MESSAGE, flagged as
 * a timeout and not as offline.
 */
async function testTimeoutMessageIsUnchanged() {
  primeSettings();

  let thrown = null;
  await withStubs(neverAnsweringFetch(), async () => {
    try {
      await chatCompletion([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      thrown = error;
    }
  });

  if (!thrown) {
    return 'Expected chatCompletion() to reject once the request is aborted';
  }
  if (thrown.message !== LM_STUDIO_TIMEOUT_MESSAGE) {
    return `Unexpected timeout message: ${thrown.message}`;
  }
  if (thrown.isTimeout !== true) {
    return 'Timeout error is missing the isTimeout flag';
  }
  if (thrown.isOffline) {
    return 'A timeout must not be classified as offline';
  }
  return true;
}

/**
 * Test 4: an unreachable LM Studio is still classified as offline, with the
 * unchanged offline message.
 */
async function testOfflineStillClassifiedAsOffline() {
  primeSettings();

  let thrown = null;
  await withStubs(
    () => Promise.reject(new TypeError('Failed to fetch')),
    async () => {
      try {
        await chatCompletion([{ role: 'user', content: 'hi' }]);
      } catch (error) {
        thrown = error;
      }
    }
  );

  if (!thrown) {
    return 'Expected chatCompletion() to reject when LM Studio is unreachable';
  }
  if (thrown.message !== LM_STUDIO_OFFLINE_MESSAGE) {
    return `Unexpected offline message: ${thrown.message}`;
  }
  if (thrown.isOffline !== true) {
    return 'Offline error is missing the isOffline flag';
  }
  return true;
}

/**
 * Test 5: a bare TypeError from the fetch boundary is still treated as offline,
 * not as a timeout.
 */
async function testBareTypeErrorIsOffline() {
  primeSettings();

  let thrown = null;
  await withStubs(
    () => Promise.reject(new TypeError('')),
    async () => {
      try {
        await chatCompletion([{ role: 'user', content: 'hi' }]);
      } catch (error) {
        thrown = error;
      }
    }
  );

  if (!thrown || thrown.message !== LM_STUDIO_OFFLINE_MESSAGE || thrown.isTimeout) {
    return 'An empty-message TypeError should still become the offline error';
  }
  return true;
}

/**
 * Test 6: the pre-flight model check is untouched — no model means a clear error
 * and no request at all.
 */
async function testNoModelStillShortCircuits() {
  resetStorage();
  store.lmStudio = { baseUrl: 'http://localhost:1234/v1', apiKey: 'lm-studio', model: '' };

  let called = false;
  let thrown = null;
  await withStubs(
    () => {
      called = true;
      return Promise.resolve(new Response('{}'));
    },
    async () => {
      try {
        await chatCompletion([{ role: 'user', content: 'hi' }]);
      } catch (error) {
        thrown = error;
      }
    }
  );

  if (!thrown || thrown.message !== LM_STUDIO_NO_MODEL_MESSAGE) {
    return `Expected the no-model error, got: ${thrown && thrown.message}`;
  }
  if (thrown.isModelError !== true) {
    return 'No-model error is missing the isModelError flag';
  }
  if (called) {
    return 'No request should be sent when no model is selected';
  }
  return true;
}

/**
 * Test 7: a 400 that names the model is still reported as an invalid model.
 */
async function testInvalidModelStillClassified() {
  primeSettings();

  let thrown = null;
  await withStubs(
    async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Model 'nope' not found" } })
    }),
    async () => {
      try {
        await chatCompletion([{ role: 'user', content: 'hi' }]);
      } catch (error) {
        thrown = error;
      }
    }
  );

  if (!thrown || thrown.message !== LM_STUDIO_INVALID_MODEL_MESSAGE) {
    return `Expected the invalid-model error, got: ${thrown && thrown.message}`;
  }
  if (thrown.isModelError !== true) {
    return 'Invalid-model error is missing the isModelError flag';
  }
  return true;
}

/**
 * Test 8: a successful request still clears the timer it set.
 */
async function testSuccessfulRequestClearsTimeout() {
  primeSettings();

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Set();

  globalThis.setTimeout = (callback, delay, ...rest) => {
    const id = realSetTimeout(callback, delay, ...rest);
    pending.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    pending.delete(id);
    return realClearTimeout(id);
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'hello' } }] })
  });

  let result = null;
  try {
    result = await chatCompletion([{ role: 'user', content: 'hi' }]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  if (!result || result.text !== 'hello') {
    return 'A successful request should still return its text';
  }
  if (pending.size !== 0) {
    return `Expected the timeout timer to be cleared, ${pending.size} still pending`;
  }
  return true;
}

/** Run all tests and print a summary. */
async function runAllTests() {
  console.log('\n=== LM Studio Timeout Tests ===\n');

  await runTest('Request aborts at 60,000 ms, not 30,000 ms', testTimeoutIsSixtySeconds);
  await runTest('Models request shares the 60,000 ms timeout', testModelsTimeoutIsSixtySeconds);
  await runTest('Timeout still produces LM_STUDIO_TIMEOUT_MESSAGE', testTimeoutMessageIsUnchanged);
  await runTest('Unreachable LM Studio is still offline', testOfflineStillClassifiedAsOffline);
  await runTest('Bare TypeError is still offline, not a timeout', testBareTypeErrorIsOffline);
  await runTest('No model still short-circuits before any request', testNoModelStillShortCircuits);
  await runTest('Model 400 is still an invalid-model error', testInvalidModelStillClassified);
  await runTest('Successful request clears its timeout timer', testSuccessfulRequestClearsTimeout);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;