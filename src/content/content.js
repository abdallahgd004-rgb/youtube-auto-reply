// Content Script - YouTube Auto Reply Extension
// Phase 5: Comment detection with SiteAdapter + MutationObserver
// No ES modules - uses globalThis.YouTubeSiteAdapter

console.log('[YouTube Auto Reply] Content script loaded');

/**
 * Get the current enabled state from storage.
 * @returns {Promise<boolean>} True if extension is enabled, false otherwise
 */
async function getEnabledState() {
  try {
    const result = await chrome.storage.local.get('enabled');
    return result.enabled !== undefined ? result.enabled : false;
  } catch (error) {
    console.error('[YouTube Auto Reply] Error getting enabled state:', error);
    return false;
  }
}

/**
 * Check if we're on a supported YouTube page.
 * @returns {boolean} True if on YouTube domain
 */
function isSupportedPage() {
  const hostname = window.location.hostname;
  return hostname === 'www.youtube.com' || hostname === 'youtube.com';
}

// Initialize adapter from global scope (defined by youtube-adapter.js)
const SiteAdapter = globalThis.YouTubeSiteAdapter || null;

/**
 * Throttle the mutation observer callback to avoid CPU hammering during scroll bursts.
 * YouTube fires huge mutation bursts while scrolling; we batch them with a trailing debounce.
 */
const THROTTLE_MS = 300; // Debounce window for processing added nodes
let pendingNodes = [];      // Queue of element nodes to process after debounce
let throttleTimer = null;   // Holds the pending timer (null when no timer armed)
let seenIds = new Set();    // Shared dedup set for both page-load and mutation paths

// ── TEMPORARY DIAGNOSTIC INSTRUMENTATION ─────────────────────────────────────
// Added to find out why the MutationObserver path does not detect comments that
// findCommentNodes() can see. Purely additive counters and logging; no detection
// behaviour is changed and no timers, polling or retries are introduced. Remove
// once the cause is identified.
const diag = {
  mutationRecords: 0,   // Q1: did the observer callback fire at all?
  addedNodes: 0,        // Q2: how many addedNodes arrived in total?
  elementNodes: 0,      // addedNodes that were usable elements
  skippedNonElement: 0, // addedNodes dropped by the nodeType guard
  flushes: 0,           // times the throttled batch actually ran
  nodesProcessed: 0,    // nodes examined in processBatch
  selfMatches: 0,       // nodes that were themselves a comment
  descendantThreads: 0, // comment threads found as descendants
  descendantRenderers: 0,
  parsedOk: 0,          // successfully parsed
  parseFailed: 0,       // parseComment returned null
  alreadySeen: 0,       // rejected because seenIds already had the id
  sampleShown: 0
};

/** Minimal node description for diagnostic output only. */
function diagDescribe(node) {
  if (!node) return 'null';
  let out = node.tagName ? node.tagName.toLowerCase() : 'unknown';
  try {
    if (node.id) out += '#' + node.id;
    const cls = typeof node.className === 'string'
      ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
      : [];
    if (cls.length) out += '.' + cls.join('.');
  } catch (_) { /* ignore */ }
  return out;
}

/**
 * Process a batch of comment nodes.
 * @param {Array} nodes - Array of HTMLElement nodes to check for comments
 */
function processBatch(nodes) {
  const adapter = new SiteAdapter();
  diag.flushes++;
  diag.nodesProcessed += nodes.length;

  // Q3/Q4: processBatch does NOT call findCommentNodes() today; it queries each
  // inserted node. So sample the live page to compare the two views.
  // Sampled rather than every flush, because it scans the whole document.
  if (diag.flushes <= 3 || diag.flushes % 25 === 0) {
    let liveCount = -1;
    let liveSample = '';
    try {
      const live = adapter.findCommentNodes();
      liveCount = live.length;
      if (live.length) liveSample = diagDescribe(live[0]);
    } catch (err) {
      liveSample = 'error: ' + err.message;
    }
    console.log(
      `[YouTube Auto Reply] DIAG flush#${diag.flushes}: batchSize=${nodes.length} ` +
      `findCommentNodes() now returns ${liveCount} ${liveSample}`
    );
  }

  for (const node of nodes) {
    // Only treat the node itself as a comment if it IS one. The observer also hands
    // us large containers; parseComment() on a container would return the first
    // comment inside it under a fabricated fallback id, creating a bogus comment and
    // burning a seenIds entry for it.
    if (adapter.isCommentNode(node)) {
      diag.selfMatches++;
      const parsedComment = adapter.parseComment(node);

      if (!parsedComment) {
        // Q5: rejected because parsing produced no usable comment.
        diag.parseFailed++;
        console.log(`[YouTube Auto Reply] DIAG parse failed for ${diagDescribe(node)}`);
      } else if (seenIds.has(parsedComment.id)) {
        // Q5: rejected because this comment was already recorded.
        diag.alreadySeen++;
      }

      if (parsedComment && !seenIds.has(parsedComment.id)) {
        seenIds.add(parsedComment.id);
        diag.parsedOk++;

        // Q6: log the parsed id/text immediately before the existing flow.
        if (diag.sampleShown < 5) {
          diag.sampleShown++;
          console.log(
            `[YouTube Auto Reply] DIAG parsed: id=${parsedComment.id} ` +
            `author=${parsedComment.author} text="${parsedComment.text.substring(0, 60)}"`
          );
        }

        console.log('[YouTube Auto Reply] New comment detected:', parsedComment.text.substring(0, 50) + '...');

        // Send to background via message bridge
        sendMessage('COMMENT_DETECTED', { comment: parsedComment }).catch(function (err) {
          console.error('[YouTube Auto Reply] sendMessage failed for comment id=' + parsedComment.id + ': ' + err.message);
        });
      }
    }

    // Also check for nested comment threads within the mutation.
    // Use adapter's static SELECTORS property (exposed for cross-script access).
    // querySelectorAll matches all descendants, not just direct children, so a
    // comment rendered several levels below the inserted node is still found.
    const childComments = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD);
    diag.descendantThreads += childComments.length;
    if (childComments.length > 0) {
      childComments.forEach(function(commentNode) {
        let pc = adapter.parseComment(commentNode);
        if (!pc) {
          diag.parseFailed++;
        } else if (seenIds.has(pc.id)) {
          diag.alreadySeen++;
        } else {
          seenIds.add(pc.id);
          diag.parsedOk++;
          if (diag.sampleShown < 5) {
            diag.sampleShown++;
            console.log(
              `[YouTube Auto Reply] DIAG parsed (descendant): id=${pc.id} ` +
              `author=${pc.author} text="${pc.text.substring(0, 60)}"`
            );
          }

          console.log('[YouTube Auto Reply] New comment detected:', pc.text.substring(0, 50) + '...');

          sendMessage('COMMENT_DETECTED', { comment: pc }).catch(function (err) {
            console.error('[YouTube Auto Reply] sendMessage failed for comment id=' + pc.id + ': ' + err.message);
          });
        }
      });
    }

    // A mutation may also carry comments that use the inner renderer only. Covered by
    // the adapter's own selector list so detection does not depend on the wrapper tag.
    const innerComments = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_RENDERER);
    innerComments.forEach(function(commentNode) {
      // Skip renderers already covered as descendants of a matched thread.
      diag.descendantRenderers++;
      if (commentNode.closest && commentNode.closest(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD)) return;
      const pc = adapter.parseComment(commentNode);
      if (!pc) {
        diag.parseFailed++;
      } else if (seenIds.has(pc.id)) {
        diag.alreadySeen++;
      } else {
        seenIds.add(pc.id);
        diag.parsedOk++;
        console.log('[YouTube Auto Reply] New comment detected (renderer):', pc.text.substring(0, 50) + '...');
        sendMessage('COMMENT_DETECTED', { comment: pc }).catch(function (err) {
          console.error('[YouTube Auto Reply] sendMessage failed for comment id=' + pc.id + ': ' + err.message);
        });
      }
    });

  // Running totals, so a single line answers how far the observer path got.
  console.log(
    `[YouTube Auto Reply] DIAG totals: flushes=${diag.flushes} nodesProcessed=${diag.nodesProcessed} ` +
    `selfMatches=${diag.selfMatches} descThreads=${diag.descendantThreads} ` +
    `descRenderers=${diag.descendantRenderers} parsedOk=${diag.parsedOk} ` +
    `parseFailed=${diag.parseFailed} alreadySeen=${diag.alreadySeen} seenIdsSize=${seenIds.size}`
  );
  }
}

/**
 * Schedule processing of pending nodes after debounce.
 */
function scheduleFlush() {
  // If a timer is already armed, don't arm another one (prevents double-processing)
  if (throttleTimer !== null) return;
  
  throttleTimer = setTimeout(function () {
    throttleTimer = null;
    const batch = pendingNodes;
    pendingNodes = [];
    processBatch(batch);
  }, THROTTLE_MS);
}

/**
 * Set up MutationObserver for new comments.
 */
function setupMutationObserver(enabled) {
  if (!enabled || !SiteAdapter) {
    console.log('[YouTube Auto Reply] MutationObserver skipped - disabled or adapter not loaded');
    return;
  }

  function observeComments() {

    console.log('[YouTube Auto Reply] MutationObserver started');

    const config = {
      childList: true,
      subtree: true
      // attributes: true is dropped - we only need to detect new comment nodes.
      // data-id changes on existing elements don't add comments (they're handled via childList).
    };

    const observer = new MutationObserver(function(mutations) {
      // TEMPORARY DIAGNOSTIC: count records and addedNodes to answer Q1/Q2.
      diag.mutationRecords += mutations.length;
      const before = diag.addedNodes;

      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          diag.addedNodes++;
          if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            // Skip non-element nodes early. Counted so we can see whether comment
            // insertions are arriving as a DocumentFragment (nodeType 11) and being
            // dropped here.
            diag.skippedNonElement++;
            return;
          }
          diag.elementNodes++;

          pendingNodes.push(node);

          // Schedule flush after debounce window (throttles callback frequency)
          scheduleFlush();
        });
      });

      if (diag.addedNodes !== before) {
        console.log(
          `[YouTube Auto Reply] DIAG observer: records=${diag.mutationRecords} ` +
          `newAddedNodes=${diag.addedNodes - before} elementNodes=${diag.elementNodes} ` +
          `skippedNonElement=${diag.skippedNonElement} pendingQueue=${pendingNodes.length}`
        );
      }
    });

    observer.observe(document.body, config);
    
    // Cleanup on page unload
    window.addEventListener('unload', function() {
      observer.disconnect();
    });
  }

  observeComments();
}

/**
 * Detect existing comments on page load.
 */
async function detectExistingComments(enabled) {
  if (!enabled || !SiteAdapter) {
    console.log('[YouTube Auto Reply] Comment detection skipped - disabled or adapter not loaded');
    return;
  }

  const adapter = new SiteAdapter();
  
  // Check if page is supported first
  if (!adapter.isSupportedPage()) {
    console.warn('[YouTube Auto Reply] Not on a supported YouTube page');
    return;
  }

  const commentNodes = adapter.findCommentNodes();
  
  if (commentNodes.length === 0) {
    console.log('[YouTube Auto Reply] No comments found on this page');
    return;
  }

  console.log('[YouTube Auto Reply] Found', commentNodes.length, 'comment(s) on page load');

  // Parse each comment and log the results
  for (const node of commentNodes) {
    const parsedComment = adapter.parseComment(node);
    
    if (!parsedComment) {
      console.warn('[YouTube Auto Reply] Failed to parse comment:', node.getAttribute('data-id') || 'unknown');
      continue;
    }

    // Add ID to seenIds so this comment won't be reported again when mutations occur
    seenIds.add(parsedComment.id);
    
    // Log the parsed comment (truncated for readability)
    const textPreview = parsedComment.text.substring(0, 60);
    console.log('[YouTube Auto Reply] Comment detected:', textPreview + '...');
    
    // Send to background via message bridge
    sendMessage('COMMENT_DETECTED', { comment: parsedComment }).catch(function (err) {
      console.error('[YouTube Auto Reply] sendMessage failed for comment id=' + parsedComment.id + ': ' + err.message);
    });
  }
}

// ─── Async reply queue (Phase 8.3) ──────────────────────────────────────────
// Two replies must never be prepared at the same time — overlapping DOM clicks
// on the same page would post half-finished replies or corrupt state.
let _replyQueue = Promise.resolve(); // chain head; new work is appended

/**
 * Enqueue a reply-processing task.  If another task is running, this one waits.
 *
 * @param {Function} fn - Async function taking (comment, response)
 */
function enqueueReply(fn) {
  _replyQueue = _replyQueue.then(function () {
    return fn().catch(function (err) {
      console.error('[YouTube Auto Reply] Reply queue task failed:', err.message);
    });
  });
}

/**
 * Handle a MATCH response from the background.  Runs sequentially via the queue.
 *
 * @param {Object} comment - Local parsed comment (has .element)
 * @param {Object} response - Response object from sendMessage
 */
async function handleMatchReply(comment, response) {
  console.log('[YouTube Auto Reply] MATCH detected for comment id=' + comment.id + '; preparing reply');

  const adapter = new SiteAdapter();

  // Step a: find the reply button
  var replyBtn = adapter.findReplyButton(comment);
  if (!replyBtn) {
    console.error('[YouTube Auto Reply] handleMatchReply: findReplyButton returned null for comment id=' + comment.id);
    return;
  }

  // Step b: open the reply box (async)
  var replyBox = await adapter.openReplyBox(comment);
  if (!replyBox) {
    console.error('[YouTube Auto Reply] handleMatchReply: openReplyBox returned null for comment id=' + comment.id);
    return;
  }

  // Step c: set the reply text
  var setTextOk = adapter.setReplyText(replyBox, response.reply);
  if (!setTextOk) {
    console.error('[YouTube Auto Reply] handleMatchReply: setReplyText returned false for comment id=' + comment.id);
    return;
  }

  // Step d: submit the reply (async; respects dryRun gate internally)
  var submitted = await adapter.submitReply(replyBox);
  if (!submitted) {
    console.warn('[YouTube Auto Reply] handleMatchReply: submitReply returned false for comment id=' + comment.id);
    return;
  }

  console.log('[YouTube Auto Reply] handleMatchReply: reply submission completed for comment id=' + comment.id);
}

/**
 * Check if a value is a serializable primitive.
 */
function isSerializablePrimitive(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

/**
 * Check if a value is a plain object (not a DOM node or other non-serializable type).
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Deep-strip non-serializable values from an object.
 *
 * Recursively copies only JSON-serializable primitives (string, number, boolean,
 * null) and plain arrays/objects. DOM nodes, functions, symbols, dates,
 * maps, sets, etc. are dropped entirely.
 *
 * @param {*} value - Any value to sanitize
 * @returns {*} Sanitized value; if input is not an object/array, returns as-is
 */
function deepStripNonSerializable(value) {
  // 1. primitives: COPY them
  if (isSerializablePrimitive(value)) return value;

  // 2. functions: drop
  if (typeof value === 'function') return undefined;

  // 3. arrays: map, dropping holes
  if (Array.isArray(value)) {
    return value.map(deepStripNonSerializable).filter(v => v !== undefined);
  }

  // 4. plain objects: recurse, dropping dropped keys
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).forEach(function (key) {
      const cleaned = deepStripNonSerializable(value[key]);
      if (cleaned !== undefined) out[key] = cleaned;
    });
    return out;
  }

  // 5. everything else (DOM nodes, Maps, Sets, class instances): DROP
  return undefined;
}



/**
 * Send a message to the background service worker.
 *
 * Returns a Promise that resolves with the response object on success,
 * or rejects if chrome.runtime.sendMessage fails (network error, timeout,
 * or the background script throws).
 *
 * The callback still fires for logging; callers should await the returned
 * promise for the actual result.  Existing call sites that ignore the
 * return value continue to work.
 */
function sendMessage(action, data) {
  if (!chrome.runtime || !chrome.runtime.sendMessage) {
    return Promise.reject(new Error('chrome.runtime not available'));
  }

  // Generic sanitizer with null guard
  const payload = data === undefined ? undefined : deepStripNonSerializable(data);

  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ action: action, data: payload }, function (response) {
      // Defect 8 fix: Check for runtime errors before handling response
      if (chrome.runtime.lastError) {
        const err = new Error('Message failed: ' + chrome.runtime.lastError.message);
        console.error('[YouTube Auto Reply] Message failed:', chrome.runtime.lastError.message);
        reject(err);
        return;
      }

      // Log the received response from background
      if (!response || !response.success) {
        const errorMsg = response && response.error ? ': ' + response.error : '';
        console.error('[YouTube Auto Reply] Background response failed' + errorMsg);
        reject(new Error('Background response failed' + errorMsg));
        return;
      }

      // Success case - log the echoed id to prove round-trip works
      if (response.id !== undefined) {
        console.log('[YouTube Auto Reply] Round-trip confirmed: background received comment id="' + response.id + '"');
      } else if (response.received === true) {
        // Legacy response format for backward compatibility
        console.log('[YouTube Auto Reply] Background acknowledged message');
      }

      // Phase 8.3: Act on MATCH responses — enqueue reply processing
      if (response.result === 'MATCH' && response.reply) {
        // The local `data` object still has the full comment with .element;
        // the response only carries the stripped payload.
        var localComment = data && data.comment ? data.comment : null;
        if (localComment) {
          enqueueReply(function () {
            return handleMatchReply(localComment, response);
          });
        }
      } else if (response.result === 'MATCH' && !response.reply) {
        console.log('[YouTube Auto Reply] MATCH but empty reply — skipping for comment id=' + (response.id || '?'));
      } else if (response.result === 'NO_MATCH') {
        console.log('[YouTube Auto Reply] NO_MATCH for comment id=' + (response.id || '?'));
      }

      resolve(response);
    });
  });
}

// Main initialization
async function init() {
  const enabled = await getEnabledState();
  
  if (!enabled) {
    console.log('[YouTube Auto Reply] Extension is disabled - comment detection skipped');
    return;
  }

  // Check if we're on a supported page
  if (!isSupportedPage()) {
    console.warn('[YouTube Auto Reply] Not running on YouTube - skipping');
    return;
  }

  console.log('[YouTube Auto Reply] Running on YouTube domain, enabled=true');

  // Detect existing comments with error handling (Defect 9 fix)
  detectExistingComments(enabled).catch(error => {
    console.error('[YouTube Auto Reply] Error in detectExistingComments:', error);
  });

  // Set up MutationObserver for new comments (throttled).
  // setupMutationObserver is synchronous, so wrap in try/catch — .catch() on undefined throws.
  try {
    setupMutationObserver(enabled);
  } catch (error) {
    console.error('[YouTube Auto Reply] Error in setupMutationObserver:', error);
  }
}

// Debugging bridge.
//
// The content script runs in an isolated world, so YouTubeSiteAdapter is NOT reachable
// from the page DevTools console, and the earlier one-shot diagnostic only fires at
// page load, before YouTube has rendered the comments. A CustomEvent crosses the
// isolated-world boundary because both sides share the DOM, which is what makes an
// on-demand diagnostic possible at all.
//
// From the PAGE console, after scrolling the comments into view:
//     document.dispatchEvent(new CustomEvent('youtube-auto-reply-diagnose'))
document.addEventListener('youtube-auto-reply-diagnose', () => {
  if (!SiteAdapter) {
    console.warn('[YouTube Auto Reply] diagnose event: site adapter not loaded');
    return;
  }
  try {
    new SiteAdapter()._logNoCommentsDiagnostic(true);
    console.log('[YouTube Auto Reply] diagnose event: diagnostic requested');
  } catch (error) {
    console.error('[YouTube Auto Reply] diagnose event failed:', error.message);
  }
});

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded, run immediately
  init();
}
