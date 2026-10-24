#!/usr/bin/env node
/**
 * Headless test runner for the browser test pages under the `tests` directories in src/.
 *
 * The suites are plain pages that run on load and print a summary. There is no Node test
 * runner in this project, which means "run the tests" has always meant "open the page" —
 * workable by hand, useless for a change that has to be verified before shipping.
 *
 * This drives one headless Chrome over the DevTools Protocol: it opens each page as a tab,
 * waits for the suite to publish `window.__TEST_RESULTS__`, and reports the counts.
 *
 * WHY CDP AND NOT `--dump-dom`: `--dump-dom` relies on `--virtual-time-budget`, and Chrome
 * in that mode does not reliably terminate on this machine — it hangs after printing,
 * whatever page it was given, including an empty one. The CDP route reads the result out
 * of a running page and leaves the browser in charge of its own lifecycle, which is both
 * faster and deterministic. No dependencies: Node 22's global WebSocket speaks CDP
 * directly.
 *
 * A suite that never publishes results is reported as UNREADABLE and fails the run, rather
 * than being counted as a pass.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # every suite
 *   node scripts/run-tests.mjs fixed-reply  # only suites whose path matches
 */

import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** How long one suite may take before it is declared stuck. */
const SUITE_TIMEOUT_MS = 60_000;

/** Chrome candidates, most-preferred first. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) || null;
}

/** Every test page, as absolute paths. */
function findSuites() {
  const suites = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Descend everywhere: the suites live in src/<area>/tests/, two levels down.
        walk(full);
        continue;
      }
      // A page is a suite by name, matching the two shapes in use: `<area>-tests.html`
      // and the matchers' `test-runner.html`.
      if (/-tests\.html$/.test(entry.name) || entry.name === 'test-runner.html') {
        suites.push(full);
      }
    }
  };
  walk(SRC);
  return suites.sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch headless Chrome and return its DevTools endpoint.
 *
 * A throwaway profile per run: it keeps a running Chrome from being reused and means
 * nothing touches the user's own profile. Port 0 lets the OS pick a free port, read back
 * from the DevTools HTTP endpoint rather than guessed.
 */
async function launchChrome(chrome) {
  const profile = mkdtempSync(join(tmpdir(), 'ytar-tests-'));
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  // Chrome prints "DevTools listening on ws://127.0.0.1:PORT/..." on stderr once ready.
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint in 30s')), 30_000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with code ${code} before it was ready`));
    });
  });

  return { child, profile, endpoint };
}

/**
 * Minimal CDP client over a single WebSocket.
 *
 * Only what this runner needs: send a command with an id, resolve when the matching reply
 * arrives, and ignore everything else. A real CDP client would handle redirects and
 * reconnection, neither of which a local headless tab needs.
 */
function connect(wsUrl, { onConsoleError } = {}) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    // Events arrive without an id. A page error here is what distinguishes "the suite
    // never ran" from "the suite ran and found a bug".
    if (message.method && onConsoleError) {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails;
        onConsoleError(details?.exception?.description || details?.text || 'uncaught exception');
      } else if (message.method === 'Runtime.consoleAPICalled') {
        const text = message.params?.args?.map(a => a.value ?? a.description ?? '').join(' ');
        if (text && (text.includes('✗') || text.includes('FAIL'))) {
          onConsoleError(text);
        }
      }
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  return {
    ready,
    send(method, params, sessionId) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      });
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Read a suite's counts out of the page.
 *
 * Every suite renders a `.summary` block containing `Total:`, `Passed:` and `Failed:`, and
 * they all do it the same way. Reading that DOM — rather than requiring a new global on
 * every page — is what lets this runner work with the existing suites unmodified, which is
 * the whole reason it is a runner and not a rewrite of the tests.
 *
 * A suite that also sets `window.__TEST_RESULTS__` (the newer ones) is preferred, because
 * that needs no parsing, but it is not required.
 */
function readResults(probe) {
  if (probe.globals && probe.globals.total !== undefined) return probe.globals;

  const summary = probe.summary;
  if (!summary) return null;

  const total = /Total:\s*(\d+)/.exec(summary);
  const passed = /Passed:\s*(\d+)/.exec(summary);
  const failed = /Failed:\s*(\d+)/.exec(summary);
  if (!total || !failed) return null;

  return { total: Number(total[1]), passed: Number(passed ? passed[1] : 0), failed: Number(failed[1]) };
}

/**
 * Open one suite as a tab, wait for its results, and close the tab.
 *
 * @returns {Promise<{ok: boolean, total?: number, passed?: number, failed?: number,
 *   reason?: string}>}
 */
async function runSuite(browserWs, file) {
  const target = await fetch(`http://127.0.0.1:${new URL(browserWs).port}/json/new?${encodeURIComponent(pathToFileURL(file).href)}`, {
    method: 'PUT',
  }).then((response) => response.json());

  // Collected before connecting so nothing thrown during page setup is missed.
  const consoleErrors = [];
  const client = connect(target.webSocketDebuggerUrl, {
    onConsoleError: (text) => consoleErrors.push(text),
  });

  try {
    await client.ready;
    await client.send('Runtime.enable');

    // Neutralise window.close() for the duration of the suite.
    //
    // popup-tests.js clicks the side panel's close control and states in a comment that
    // `window.close()` "is a no-op in a test page" — that is true in a tab a human opened,
    // but a tab created over CDP CAN be closed by script, so the click tears the page down
    // mid-run and the suite never reports. Making the suite's own stated assumption true is
    // the smaller change than editing a test that is passing on its own terms, and it only
    // ever applies here: no shipped file is touched.
    await client.send('Page.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.close = function () {};',
    });
    await client.send('Page.reload', { ignoreCache: false });

    const deadline = Date.now() + SUITE_TIMEOUT_MS;
    let results = null;
    while (Date.now() < deadline) {
      const probe = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const summary = document.querySelector('.summary');
          return JSON.stringify({
            globals: window.__TEST_RESULTS__ || null,
            summary: summary ? summary.textContent : null
          });
        })()`,
        returnByValue: true,
      });

      // `connect()` hands back the CDP `result` object, so the evaluated value is
      // `result.value` from here — one level, not two.
      const value = probe?.result?.value;
      let parsed = null;
      try {
        parsed = JSON.parse(value);
      } catch (_) {
        parsed = null;
      }

      if (parsed) {
        results = readResults(parsed);
        if (results) break;
      }
      await sleep(150);
    }

    if (!results) {
      failures.push(...consoleErrors);
      return {
        ok: false,
        reason: failures.length
          ? `the suite threw before publishing results: ${failures[0]}`
          : `no results after ${SUITE_TIMEOUT_MS / 1000}s — the page may not have finished loading`,
      };
    }

    return {
      ok: results.failed === 0,
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      errors: consoleErrors,
    };
  } finally {
    client.close();
    await fetch(`http://127.0.0.1:${new URL(browserWs).port}/json/close/${target.id}`).catch(() => {});
  }
}

/**
 * Stop Chrome and remove its profile.
 *
 * The wait matters: deleting a profile directory while Chrome is still writing to it
 * fails with ENOTEMPTY, which is a shutdown-order bug in the RUNNER, not a test failure —
 * so it must not be allowed to mask a real result. The profile is left behind on a hard
 * timeout rather than retried forever.
 */
async function shutdown(browser) {
  const exited = new Promise((resolve) => browser.child.once('exit', resolve));
  browser.child.kill();
  await Promise.race([exited, sleep(5_000)]);
  try {
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (_) {
    // A leftover temp profile is harmless; failing the run over it would be worse.
  }
}

const filter = process.argv[2];
const suites = findSuites().filter((p) => !filter || p.includes(filter));

if (suites.length === 0) {
  console.error(`No test suites matched "${filter ?? ''}".`);
  process.exit(1);
}

const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome/Chromium found. Set CHROME_PATH to a binary.');
  process.exit(1);
}

console.log(`Running ${suites.length} suite(s) in headless Chrome\n`);

let browser;
try {
  browser = await launchChrome(chrome);
} catch (error) {
  console.error(`Could not start Chrome: ${error.message}`);
  process.exit(1);
}

const failures = [];
const unreadable = [];

try {
  for (const file of suites) {
    const name = relative(ROOT, file);
    process.stdout.write(`${name} … `);
    const result = await runSuite(browser.endpoint, file);

    if (result.total === undefined) {
      unreadable.push(`${name}: ${result.reason}`);
      console.log('UNREADABLE');
      continue;
    }

    if (result.ok) {
      console.log(`✓ ${result.passed}/${result.total}`);
    } else {
      failures.push(`${name}: ${result.failed} of ${result.total} failed`);
      if (result.errors && result.errors.length) {
        for (const err of result.errors) failures.push(`  ${err}`);
      }
      console.log(`✗ ${result.failed}/${result.total} failed`);
    }
  }
} finally {
  await shutdown(browser);
}

console.log('');
for (const line of failures) console.log(`FAIL  ${line}`);
for (const line of unreadable) console.log(`SKIP  ${line}`);

if (failures.length || unreadable.length) {
  process.exit(1);
}
console.log('All suites passed.');