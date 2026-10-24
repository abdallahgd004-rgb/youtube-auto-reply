/**
 * Chrome Storage Stub - trigger CRUD tests
 *
 * Installs an in-memory `globalThis.chrome.storage` so the real storage.js /
 * trigger-crud.js can be exercised outside the extension.
 *
 * Import this module first: Chrome already defines a global `chrome` object, so the
 * stub merges onto it instead of replacing it, and storage.js must not be evaluated
 * before the merge happens.
 */

const store = {};

/** Wipe the stubbed storage between tests. */
function resetStorage() {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}

/** Read the raw stubbed store (bypasses the DEFAULT_CONFIG deep merge). */
function readStore() {
  return JSON.parse(JSON.stringify(store));
}

globalThis.chrome = globalThis.chrome || {};

globalThis.chrome.storage = {
  local: {
    async get(keys) {
      // chrome.storage.local.get returns only the requested keys that are present.
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          out[key] = JSON.parse(JSON.stringify(store[key]));
        }
      }
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        store[key] = JSON.parse(JSON.stringify(value));
      }
    },
    // Needed by the clear paths (activity-log, queue-persistence).
    async remove(key) {
      const list = Array.isArray(key) ? key : [key];
      for (const k of list) {
        delete store[k];
      }
    }
  },

  /**
   * `chrome.storage.onChanged`, which real Chrome has and this stub previously did not.
   *
   * Added because popup.js and content.js register listeners on it at load time, and without
   * it those registrations THROW — taking down whatever the page was doing at init and
   * reporting a failure that points at the listener rather than at the missing API.
   *
   * The stub is deliberately the more complete one rather than the production code being
   * made defensive about it. Guarding a real API call because a test double is incomplete
   * would hide a genuine wiring failure, which is a worse problem than a louder test.
   *
   * `set()` fires it for real, so a test can drive the change and assert the page reacted —
   * `storageSet()` below does exactly that with the real `newValue` shape.
   */
  onChanged: {
    _listeners: [],
    addListener(fn) {
      this._listeners.push(fn);
    },
    removeListener(fn) {
      this._listeners = this._listeners.filter((l) => l !== fn);
    },
    hasListener(fn) {
      return this._listeners.includes(fn);
    }
  }
};

/** Deliver a storage change to every registered listener, as Chrome does. */
function fireStorageChanged(changes, area = 'local') {
  for (const listener of globalThis.chrome.storage.onChanged._listeners.slice()) {
    listener(changes, area);
  }
}

/** Write through `storage.local.set` and fire `onChanged` with a real old/new pair. */
async function storageSet(values) {
  const changes = {};
  for (const [key, value] of Object.entries(values)) {
    changes[key] = {
      oldValue: Object.prototype.hasOwnProperty.call(store, key)
        ? JSON.parse(JSON.stringify(store[key]))
        : undefined,
      newValue: JSON.parse(JSON.stringify(value))
    };
  }
  await globalThis.chrome.storage.local.set(values);
  fireStorageChanged(changes);
}

/**
 * Canned background responses, keyed by the action the page asked for.
 *
 * One object answers every action both UIs ask about, so options.js (which awaits
 * the promise form) and popup.js (which uses the callback form) can share this stub.
 * Fields unrelated to the requested action are simply ignored by each caller.
 */
const RESPONSES = {
  GET_LM_STUDIO_MODELS: { success: true, models: [{ id: 'stub-model' }] },
  GET_CONNECTION_STATUS: { success: true, status: 'connected', modelCount: 1 },
  GET_CURRENT_MODEL: { success: true, model: 'stub-model' },
  GET_QUEUE_COUNT: { success: true, count: 0 },
  GET_REPLY_STATS: { success: true, count: 0, limit: 30, windowMs: 3600000 },
  GET_LOGS: { success: true, logs: [] },
  // Finished run: the counters and the frozen total the Popup renders.
  GET_PROCESSING_STATE: {
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
  },
  RESET_PROCESSING_STATS: {
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
  }
};

globalThis.chrome.runtime = globalThis.chrome.runtime || {};

/**
 * Answer both calling conventions.
 *
 * options.js awaits the returned promise; popup.js passes a callback and reads
 * chrome.runtime.lastError. Supporting both here means neither page needs its own
 * stub, and a test can pick either style.
 */
globalThis.chrome.runtime.sendMessage = function sendMessage(message, callback) {
  const response = Object.assign({}, RESPONSES[message && message.action]);
  if (typeof callback === 'function') {
    callback(response);
    return undefined;
  }
  return Promise.resolve(response);
};

globalThis.chrome.runtime.lastError = undefined;

export { store, resetStorage, readStore, RESPONSES, fireStorageChanged, storageSet };