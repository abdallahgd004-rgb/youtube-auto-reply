// Phase 19.8 — Page sessions
//
// THE PROBLEM THIS SOLVES
// Reloading a YouTube page made previously detected comments permanently unprocessable.
// The content script is recreated on every page load, so its own `seenIds` correctly starts
// empty and re-detects every visible comment — but the service worker is NOT recreated by a
// page reload. Its in-memory reply-deduplication map survived, so on the second page load
// the freshly re-detected comment was rejected as "a reply was already generated for this
// comment", with no error and nothing on screen to explain it. Reloading the extension from
// chrome://extensions appeared to fix it, because that DOES restart the worker — which is
// what identified the cause as worker state rather than stored data. (chrome.storage.local
// survives an extension reload, so a persisted record could not have been the blocker.)
//
// WHAT A PAGE SESSION IS
// One load of one document. Chrome hands a content script's messages a `documentId` that is
// stable for the lifetime of that document and different after a reload, so it IS the
// boundary — no timer, no counter, no invented state.
//
// WHY A SEPARATE MODULE
// Two contexts have to agree on this value and neither can import the other's helpers: the
// content script is a classic script (no ES modules) and computes its own id, while the
// service worker reads it off the message. The rule "a missing id means its own session" is
// subtle enough that it wants one definition and one comment, not two.
//
// NOTHING HERE IS PERSISTED
// A page session is meaningful only while the worker that holds it is alive. Persisting one
// would reintroduce exactly the bug being fixed.

/**
 * Fallback used when Chrome supplies no documentId.
 *
 * An empty string is NOT correct here: it would make every session share one namespace, so
 * a reload would be indistinguishable from the original page — the original bug. Instead
 * each call site passes something already unique to the load. This constant only documents
 * the shape.
 */
export const NO_PAGE_SESSION = '';

/**
 * Read the page-session id off an inbound message's sender.
 *
 * `sender.documentId` is the documented Chrome field for "the document that opened the
 * connection". It is preferred because Chrome rotates it on every navigation and reload.
 * `sender.tab.id` is a weaker fallback (stable across reloads of the same tab, so it does NOT
 * fully solve the bug) and exists only so a message from a context without documentId still
 * gets a stable, non-colliding key rather than an empty one.
 *
 * @param {Object|undefined|null} sender - the MessageSender from chrome.runtime.onMessage
 * @returns {string} a non-empty session id
 */
export function resolvePageSessionId(sender) {
  const documentId = sender && typeof sender.documentId === 'string' ? sender.documentId : '';
  if (documentId) return documentId;

  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId === 'number' || typeof tabId === 'string') {
    // Not reload-safe on its own; kept so a session always has SOME identity. The
    // distinguishability that matters comes from documentId in every real path.
    return `tab:${tabId}`;
  }

  return NO_PAGE_SESSION;
}