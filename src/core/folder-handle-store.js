/**
 * Folder Handle Persistence — Phase 21.1
 *
 * Stores the `FileSystemDirectoryHandle` the user picks, so it survives the Options page
 * closing and the service worker being torn down.
 *
 * ── WHY IndexedDB AND NOT chrome.storage ─────────────────────────────────────
 *
 * A directory handle is an opaque platform object. It can only be persisted by structured
 * clone, which is exactly IndexedDB's contract — `chrome.storage` would reject it, and
 * stringifying it yields `{}`. This is the whole reason the handle lives here rather than in
 * the knowledge store: it is not knowledge, it is a capability.
 *
 * ── WHY THE PAGE PICKS AND THE WORKER READS ──────────────────────────────────
 *
 * `showDirectoryPicker()` does not exist in a worker — verified in this Chrome build, it is
 * `undefined` there — and it needs a user gesture besides. But `FileSystemDirectoryHandle`,
 * `for await (... of handle.values())` and `handle.getFile()` DO exist in a worker, as does
 * IndexedDB. So the split is forced and it happens to be the good split:
 *
 *   Options page  → opens the picker, stores the handle, asks for a sync
 *   Service worker → restores the handle, walks it, syncs on an alarm
 *
 * That is what makes unattended sync possible at all under MV3, where the worker is torn down
 * when idle and woken by `chrome.alarms`. Verified rather than assumed: an early draft of
 * this design had the worker unable to read anything, which would have made automatic sync
 * impossible and quietly reduced the feature to the button it was meant to replace.
 *
 * PURE-ish: no `chrome.*` and no DOM. IndexedDB is a global in every context that has one,
 * and the suite exercises this against a real in-memory database.
 */

const DB_NAME = 'ytar-folder-sync';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'knowledge-folder';

/**
 * Open (and if necessary create) the database.
 *
 * Never rejects in a way the caller cannot act on: a failed open resolves to `null` and the
 * caller reports "this browser will not keep the folder", which is true and actionable,
 * rather than throwing from inside a background alarm where nobody is watching.
 *
 * @returns {Promise<IDBDatabase|null>}
 */
function openDatabase() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (_) {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Run one transaction and resolve with its result.
 *
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} action
 * @returns {Promise<*>}
 */
function withStore(mode, action) {
  return openDatabase().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let request;
      try {
        request = action(db.transaction(STORE, mode).objectStore(STORE));
      } catch (_) {
        db.close();
        resolve(null);
        return;
      }
      request.onerror = () => {
        db.close();
        resolve(null);
      };
      request.onsuccess = () => {
        const value = request.result;
        db.close();
        resolve(value);
      };
    });
  });
}

/**
 * Whether this browser can keep a folder at all.
 *
 * Checked so the Options page can say so up front rather than offering a button that fails
 * silently on click. `showDirectoryPicker` is the capability that matters; the handle types
 * are what the worker needs afterwards.
 *
 * @returns {boolean}
 */
export function isFolderSyncSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function' &&
    typeof indexedDB !== 'undefined'
  );
}

/**
 * Persist the picked directory handle.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>} whether it was stored
 */
export async function saveFolderHandle(handle) {
  if (!handle) return false;
  const stored = await withStore('readwrite', (store) => store.put(handle, KEY));
  return stored != null;
}

/**
 * The stored directory handle, or null.
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function loadFolderHandle() {
  const handle = await withStore('readonly', (store) => store.get(KEY));
  return handle || null;
}

/**
 * Forget the folder.
 *
 * Also used as the RECOVERY path: if a stored handle becomes unreadable (the profile was
 * reset, the extension reloaded as unpacked, the origin changed), clearing it and re-picking
 * is the fix, and a handle that keeps failing to read is worse than none.
 *
 * @returns {Promise<boolean>}
 */
export async function clearFolderHandle() {
  const cleared = await withStore('readwrite', (store) => store.delete(KEY));
  return cleared != null;
}

/** Whether the platform's own permission for a handle is already granted. */
export const FOLDER_PERMISSION = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
  PROMPT: 'prompt',
});

/**
 * Read a handle's current permission WITHOUT prompting.
 *
 * `requestPermission()` needs a user gesture, which the service worker can never have — that
 * is the hard limit on unattended sync and the reason the alarm can skip rather than retry.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<string>} one of {@link FOLDER_PERMISSION}
 */
export async function queryFolderPermission(handle, mode = 'read') {
  if (!handle || typeof handle.queryPermission !== 'function') return FOLDER_PERMISSION.PROMPT;
  try {
    const state = await handle.queryPermission({ mode });
    return state || FOLDER_PERMISSION.PROMPT;
  } catch (_) {
    return FOLDER_PERMISSION.PROMPT;
  }
}

/**
 * Ask for read permission, for use from a user gesture.
 *
 * Only the Options page may call this. A denial is a normal outcome, not an error: the user
 * said no, and the correct behaviour is to leave the base exactly as it was.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<string>} one of {@link FOLDER_PERMISSION}
 */
export async function requestFolderPermission(handle, mode = 'read') {
  if (!handle || typeof handle.requestPermission !== 'function') return FOLDER_PERMISSION.DENIED;
  try {
    const state = await handle.requestPermission({ mode });
    return state || FOLDER_PERMISSION.DENIED;
  } catch (_) {
    return FOLDER_PERMISSION.DENIED;
  }
}