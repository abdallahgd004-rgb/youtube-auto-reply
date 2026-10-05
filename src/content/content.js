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

/**
 * Process a batch of comment nodes.
 * @param {Array} nodes - Array of HTMLElement nodes to check for comments
 */
function processBatch(nodes) {
  const adapter = new SiteAdapter();
  
  for (const node of nodes) {
    // Try to parse as a comment directly first
    let parsedComment = adapter.parseComment(node);
    
    if (parsedComment && !seenIds.has(parsedComment.id)) {
      seenIds.add(parsedComment.id);
      
      console.log('[YouTube Auto Reply] New comment detected:', parsedComment.text.substring(0, 50) + '...');
      
      // Send to background via message bridge
      sendMessage('COMMENT_DETECTED', { comment: parsedComment });
    }

    // Also check for nested comment threads within the mutation.
    // Use adapter's static SELECTORS property (exposed for cross-script access).
    const childComments = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD);
    if (childComments.length > 0) {
      childComments.forEach(function(commentNode) {
        let pc = adapter.parseComment(commentNode);
        if (pc && !seenIds.has(pc.id)) {
          seenIds.add(pc.id);
          
          console.log('[YouTube Auto Reply] New comment detected:', pc.text.substring(0, 50) + '...');
          
          sendMessage('COMMENT_DETECTED', { comment: pc });
        }
      });
    }
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
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) return; // Skip non-element nodes early

          pendingNodes.push(node);
          
          // Schedule flush after debounce window (throttles callback frequency)
          scheduleFlush();
        });
      });
    });

    observer.observe(document.body, config);
    
    // Cleanup on page unload
    window.addEventListener('unload', function() {
      observer.disconnect();
    });
  }
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
    sendMessage('COMMENT_DETECTED', { comment: parsedComment });
  }
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
 */
function sendMessage(action, data) {
  if (!chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }

  // Generic sanitizer with null guard
  const payload = data === undefined ? undefined : deepStripNonSerializable(data);

  chrome.runtime.sendMessage({ action: action, data: payload }, function(response) {
    // Defect 8 fix: Check for runtime errors before handling response
    if (chrome.runtime.lastError) {
      console.error('[YouTube Auto Reply] Message failed:', chrome.runtime.lastError.message);
      return;
    }

    // Response handling can be added later when needed
    console.log('[YouTube Auto Reply] Message sent successfully');
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

  // Set up MutationObserver for new comments (throttled) with error handling (Defect 9 fix)
  setupMutationObserver(enabled).catch(error => {
    console.error('[YouTube Auto Reply] Error in setupMutationObserver:', error);
  });
}

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded, run immediately
  init();
}
