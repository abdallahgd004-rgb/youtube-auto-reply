// Phase 18.3 — Diagnostics logging switch
//
// Progress logging is gated behind one user-visible flag (`debugMode`) instead of
// being deleted, because these lines are the primary debugging channel when a
// reply does not appear and the only way to see them is the service worker console.
//
// Errors are deliberately NOT gated: a genuine failure must stay visible even when
// diagnostics are off, and it costs one line to read.

/**
 * Storage key holding the user's diagnostics flag.
 *
 * IMPORTANT: like `queuePaused`, `handledComments`, `recentReplyTimestamps` and
 * `activityLogs`, this is a top-level chrome.storage.local key read directly. It
 * must NOT be added to DEFAULT_CONFIG or to the key list in getSettings() — that
 * list only loads settings, and adding it there would do nothing useful.
 */
const STORAGE_KEY = 'debugMode';

/**
 * Storage key holding the user's diagnostics verbosity (NORMAL | VERBOSE).
 *
 * Like `debugMode` itself, this is a top-level chrome.storage.local key read
 * directly — NOT part of DEFAULT_CONFIG and NOT in the getSettings() key list.
 * It is optional: when absent, diagnostics run at NORMAL.
 */
const VERBOSITY_STORAGE_KEY = 'debugVerbosity';

/**
 * The structured engine, installed as a global by core/dev-log.js.
 *
 * That file is a classic script with no import/export syntax, so the same single
 * implementation serves this module context AND the classic content scripts (which
 * cannot import anything). Importing it here is a side-effect import; the engine is
 * then reachable as `globalThis.YTAR_DEVLOG`.
 *
 * This module is the ES-module facade over it, so module contexts have one import
 * site and one set of names.
 */
import './dev-log.js';

const PREFIX = '[YouTube Auto Reply]';

/**
 * Cached flag, so the hot paths can check it synchronously.
 *
 * A storage read per log line would turn logging into the bottleneck. The cache is
 * refreshed at startup and whenever the user flips the switch.
 */
let cached = false;

/**
 * Read the flag from storage and refresh the cache.
 *
 * Call once per context at startup: the service worker, the options page and the
 * popup. A read failure resolves to `false` — diagnostics stay off rather than
 * silently flooding the console on top of a storage problem.
 *
 * The verbosity is read alongside the switch so the two can never disagree: a user
 * who has chosen VERBOSE keeps it across reloads.
 *
 * @returns {Promise<boolean>} whether diagnostics logging is enabled
 */
export async function loadDebugSetting() {
  try {
    const keys = [STORAGE_KEY, VERBOSITY_STORAGE_KEY];
    const result = await chrome.storage.local.get(keys);
    cached = !!(result && result[STORAGE_KEY] === true);

    const stored = result && result[VERBOSITY_STORAGE_KEY];
    const verbosity = stored === VERBOSITY.VERBOSE ? VERBOSITY.VERBOSE : VERBOSITY.NORMAL;
    YTAR_DEVLOG.configure({ enabled: cached, verbosity });
  } catch (error) {
    cached = false;
    YTAR_DEVLOG.configure({ enabled: false, verbosity: VERBOSITY.OFF });
    console.error(PREFIX, 'diagnostics flag read error:', error.message);
  }
  return cached;
}

/**
 * Whether diagnostics logging is currently on (cached value).
 * @returns {boolean}
 */
export function isDebugEnabled() {
  return cached;
}

/**
 * Write the flag and update the cache in one step.
 *
 * Only a strict `true` enables it, so a malformed stored value cannot turn logging
 * on permanently.
 *
 * @param {*} enabled
 * @returns {Promise<boolean>} the value actually stored
 */
export async function setDebugEnabled(enabled) {
  const value = enabled === true;
  cached = value;
  YTAR_DEVLOG.configure({ enabled: value });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: value });
  } catch (error) {
    console.error(PREFIX, 'diagnostics flag write error:', error.message);
  }
  return value;
}

/**
 * Write the verbosity (NORMAL | VERBOSE) and reconfigure the engine.
 *
 * OFF is accepted and means "silence everything", which also switches the master
 * flag off — so the two settings can never disagree about whether output is on.
 *
 * @param {string} verbosity
 * @returns {Promise<string>} the value actually stored
 */
export async function setDebugVerbosity(verbosity) {
  const value = verbosity === VERBOSITY.VERBOSE ? VERBOSITY.VERBOSE
    : verbosity === VERBOSITY.OFF ? VERBOSITY.OFF
      : VERBOSITY.NORMAL;
  await setDebugEnabled(value !== VERBOSITY.OFF);
  YTAR_DEVLOG.configure({ enabled: value !== VERBOSITY.OFF, verbosity: value });
  try {
    await chrome.storage.local.set({ [VERBOSITY_STORAGE_KEY]: value });
  } catch (error) {
    console.error(PREFIX, 'diagnostics verbosity write error:', error.message);
  }
  return value;
}

/** Diagnostic progress line. Silent unless the user enabled diagnostics. */
export function debugLog(...args) {
  if (!cached) return;
  console.log(PREFIX, ...args);
}

/** Diagnostic warning. Silent unless the user enabled diagnostics. */
export function debugWarn(...args) {
  if (!cached) return;
  console.warn(PREFIX, ...args);
}

/**
 * A real failure. Always logged.
 *
 * Kept separate from debugWarn so a bug report still has something to work with
 * when diagnostics are off.
 *
 * It is also mirrored into the diagnostic buffer when that buffer is switched on, so
 * a failure that happened while the switch was off can still be read back afterwards.
 * Printing stays unconditional — that is pre-existing behaviour and this task must not
 * change it.
 */
export function logError(...args) {
  console.error(PREFIX, ...args);
  try {
    YTAR_DEVLOG.log({
      component: YTAR_DEVLOG.COMPONENT.SYSTEM,
      event: 'UNCAUGHT_ERROR',
      level: YTAR_DEVLOG.LEVEL.ERROR,
      message: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))).join(' '),
      data: { legacyCall: true }
    });
  } catch (_) {
    // The diagnostic mirror must never be the reason a real error fails to print.
  }
}

// ── The structured diagnostic system ───────────────────────────────────────
//
// Everything below is the development-facing API. The three functions above are
// unchanged in behaviour and remain for existing call sites.

// Read the engine off the global the classic script installed.
//
// NOT destructured from `globalThis.YTAR_DEVLOG` for YTAR_DEVLOG itself: the engine
// object exposes LEVEL / VERBOSITY / COMPONENT, but it is not self-referential, so
// pulling a `YTAR_DEVLOG` property out of it yields undefined.
const YTAR_DEVLOG = globalThis.YTAR_DEVLOG;
const { LEVEL, VERBOSITY, COMPONENT } = YTAR_DEVLOG;

/** A new unique id for one processing run. */
export const newRunId = YTAR_DEVLOG.newRunId;

/** A new unique id for one LM Studio (or any outbound) request. */
export const newRequestId = YTAR_DEVLOG.newRequestId;

/** Emit a structured entry. The general-purpose entry point. */
export const devLog = YTAR_DEVLOG.log;

/** Emit a DEBUG entry (emitted only at VERBOSE). */
export const devDebug = YTAR_DEVLOG.debug;

/** Emit an INFO entry. */
export const devInfo = YTAR_DEVLOG.info;

/** Emit a WARN entry, in both the legacy console and the structured record. */
export function devWarn(component, event, fields) {
  // The legacy warn line is kept so existing grep patterns still work.
  YTAR_DEVLOG.warn(component, event, fields);
  if (fields && fields.message) {
    debugWarn(String(fields.message));
  }
  return null;
}

/** Emit an ERROR entry, in both the legacy console and the structured record. */
export function devError(component, event, fields) {
  YTAR_DEVLOG.error(component, event, fields);
  if (fields && fields.message) {
    logError(String(fields.message));
  }
  return null;
}

/**
 * Start a timed operation, producing the matching `_END` or `_ERROR` entry.
 * @see YTAR_DEVLOG.startTimer
 */
export const startTimer = YTAR_DEVLOG.startTimer;

/** Recent buffered diagnostic entries, oldest first. */
export const getDiagEntries = YTAR_DEVLOG.getEntries;

/** Empty the bounded diagnostic buffer. */
export const clearDiagEntries = YTAR_DEVLOG.clearEntries;

export {
  YTAR_DEVLOG,
  LEVEL as DEV_LOG_LEVEL,
  VERBOSITY as DEV_LOG_VERBOSITY,
  COMPONENT as DEV_LOG_COMPONENT,
};

export { STORAGE_KEY as DEBUG_STORAGE_KEY, VERBOSITY_STORAGE_KEY as DEBUG_VERBOSITY_STORAGE_KEY };