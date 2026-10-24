// Phase 18.3 — diagnostics shim for the content scripts
//
// content.js and youtube-adapter.js are CLASSIC scripts: content_scripts in the
// manifest declares no "type": "module", so neither can `import` core/debug.js.
// They share one isolated world per frame, so a plain global installed here — with
// this file listed FIRST in content_scripts — is visible to both.
//
// Reads the diagnostics flag once at load. A content script lives for the life of
// the page, and re-reading storage on every log line would make logging the
// bottleneck; a user who flips the switch reloads the YouTube tab to see it.

(function installDiagnosticsShim(global) {
  'use strict';

  const PREFIX = '[YouTube Auto Reply]';
  const STORAGE_KEY = 'debugMode';
  const VERBOSITY_KEY = 'debugVerbosity';
  let enabled = false;

  // The structured development log engine, installed by core/dev-log.js which is
  // listed ahead of this file in content_scripts. It is the SAME object the module
  // contexts use, so redaction and formatting cannot drift between them.
  const engine = global.YTAR_DEVLOG || null;

  chrome.storage.local.get([STORAGE_KEY, VERBOSITY_KEY]).then(function readFlag(result) {
    enabled = !!(result && result[STORAGE_KEY] === true);
    if (engine) {
      const stored = result && result[VERBOSITY_KEY];
      engine.configure({
        enabled: enabled,
        verbosity: stored === 'VERBOSE' ? 'VERBOSE' : 'NORMAL'
      });
    }
  }).catch(function readFailed(error) {
    // Failing open would flood the console on top of a storage problem, so a
    // read failure leaves diagnostics off.
    enabled = false;
    console.error(PREFIX, 'diagnostics flag read error:', error && error.message);
  });

  global.__YTAR_DEBUG = {
    isEnabled: function isEnabled() {
      return enabled;
    },
    debugLog: function debugLog() {
      if (!enabled) return;
      console.log.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },
    debugWarn: function debugWarn() {
      if (!enabled) return;
      console.warn.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },
    // Real failures always print, matching core/debug.js in the module contexts.
    logError: function logError() {
      console.error.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },

    // ── Structured diagnostics, delegated to the shared engine ──────────────
    // Every arg is forwarded as an options object, so a content script uses exactly
    // the same schema as the service worker. If the engine is somehow absent the call
    // is a no-op rather than a crash: diagnostics must never break the reply flow.
    devLog: function devLog(options) {
      if (engine) engine.log(options);
    },
    startTimer: function startTimer(spec) {
      if (!engine) {
        return {
          done: function () {},
          fail: function () {},
          elapsed: function () { return 0; }
        };
      }
      return engine.startTimer(spec);
    },
    newRunId: function newRunId() {
      return engine ? engine.newRunId() : '';
    },
    newRequestId: function newRequestId() {
      return engine ? engine.newRequestId() : '';
    },
    getEntries: function getEntries() {
      return engine ? engine.getEntries() : [];
    }
  };
})(window);