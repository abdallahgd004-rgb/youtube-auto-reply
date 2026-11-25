// Content Script - YouTube Auto Reply Extension
// Phase 5: Comment detection with SiteAdapter + MutationObserver
// No ES modules - uses globalThis.YouTubeSiteAdapter

__YTAR_DEBUG.debugLog('Content script loaded');

/**
 * Get the current enabled state from storage.
 * @returns {Promise<boolean>} True if extension is enabled, false otherwise
 */
async function getEnabledState() {
  try {
    const result = await chrome.storage.local.get('enabled');
    return result.enabled !== undefined ? result.enabled : false;
  } catch (error) {
    __YTAR_DEBUG.logError('Error getting enabled state:', error);
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
 * Build the comment object handed to the background for processing.
 *
 * Phase 5.6 — the comment TEXT is normalized with the project's existing Arabic
 * normalizer before it enters the processing pipeline, so matching, the prompt and
 * the fingerprint all see the same normalized text. The normalizer is exposed as a
 * global by content/arabic-normalizer-global.js, a verbatim copy of
 * src/core/matchers/arabic-normalizer.js (content scripts cannot use ES modules).
 *
 * Only `text` is normalized. `id` and `author` pass through untouched, so `seenIds`
 * deduplication and author logging behave exactly as before. `element` is carried
 * along because sendMessage() reuses this same local object for the reply flow
 * (handleMatchReply needs the DOM node); it is stripped from the wire payload by
 * deepStripNonSerializable().
 *
 * @param {Object} parsed - A comment object from adapter.parseComment()
 * @returns {Object} Same shape as the parsed comment, with normalized text
 */
const detectedCommentsMap = new Map();

function buildDetectedComment(parsed) {
  if (parsed && parsed.id) {
    detectedCommentsMap.set(parsed.id, parsed);
    if (detectedCommentsMap.size > 200) {
      const firstKey = detectedCommentsMap.keys().next().value;
      detectedCommentsMap.delete(firstKey);
    }
  }
  return {
    id: parsed.id,
    author: parsed.author,
    text: normalizeArabic(parsed.text),
    // The channel owner's heart, read by the adapter from THIS comment's own markup.
    //
    // GATED BY THE USER'S SWITCH, and this is the half that matters. With the filter turned
    // off the flag is forced to `false` rather than merely left unused: the worker refuses a
    // hearted comment outright, so a stale tab that still had the filter cached on would
    // otherwise keep answering hearted comments after the creator switched it off. Sending
    // `false` makes "off" mean off at the enqueue gate too, and costs one `&&`.
    //
    // Strict boolean rather than a truthy value: `"true"` leaning yes would silence a comment
    // the creator never hearted.
    hearted: isHeartFilterEnabled() && parsed.hearted === true,
    creatorReplied: isCreatorReplyFilterEnabled() && parsed.creatorReplied === true,
    element: parsed.element
  };
}

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
// ── Phase 20.23: recognising the replies WE posted ──────────────────────────────
//
// Module scope, not locals of processBatch(), because the writer is handleMatchReply() —
// a top-level function — and the reader is the detection gate. Putting the registry where
// only the reader could see it would leave the writer unable to fill it.
//
// The markup check (`isOwnComment`) is the broad one, but it rests on a single CSS class.
// This is the backstop that does not: whatever YouTube does to the markup, the text of a
// reply we posted this session is still recognised when it comes back as a comment.

/**
 * Normalised form used to recognise a reply WE posted coming back as a comment.
 *
 * Folds whitespace and case, and strips Arabic diacritics and Alef variants through the
 * same normalizer the matchers use, because YouTube re-renders a posted comment and the
 * text that comes back is not guaranteed byte-identical to what was typed.
 */
const normalizeForOwnReplyCheck = function (text) {
  const base = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (typeof normalizeArabic === 'function') {
    try {
      return normalizeArabic(base).replace(/\s+/g, ' ').trim();
    } catch (_) {
      return base;
    }
  }
  return base;
};

/**
 * Text of every reply this session posted, so the observer can recognise them coming back.
 *
 * BOUNDED, because a long session on a busy video posts a lot of replies. The oldest are
 * dropped past the cap; a reply posted hours ago is not coming back as a new comment.
 */
const ownReplyTexts = [];
const MAX_OWN_REPLY_TEXTS = 50;

const rememberOwnReply = function (text) {
  const normalized = normalizeForOwnReplyCheck(text);
  if (!normalized) return;
  ownReplyTexts.push(normalized);
  while (ownReplyTexts.length > MAX_OWN_REPLY_TEXTS) ownReplyTexts.shift();
};

const isTextWeWrote = function (text) {
  const normalized = normalizeForOwnReplyCheck(text);
  if (!normalized) return false;
  return ownReplyTexts.indexOf(normalized) !== -1;
};
function processBatch(nodes) {
  const adapter = new SiteAdapter();

  // The page is reading new comments off the DOM right now. Reported once per batch
  // rather than per node, so a scroll burst of 50 comments costs one message.
  reportStage(STAGE_LABELS_FOR_REPORT.READING_COMMENTS, '', '');

  // Counts for this batch only. Together with the totals below they answer the
  // "10 comments became 20 detections" question: nodesExamined is not the same as
  // uniqueCommentsFound, and parseFailures explains the gap.
  let uniqueCommentsFound = 0;
  let duplicateNodesIgnored = 0;
  let parseFailures = 0;
  let nonCommentNodesSkipped = 0;
  // Phase 20.23: our OWN replies seen and skipped. Counted rather than dropped silently —
  // a filter that cannot be observed is a filter whose absence looks like working code.
  let ownCommentsSkipped = 0;
  // Comments the CHANNEL OWNER has hearted. Counted for the same reason as the counter above:
  // a filter that cannot be observed is indistinguishable from one that is not matching.
  let heartedCommentsSkipped = 0;
  // Comments the CHANNEL OWNER has already replied to in the thread.
  let creatorRepliedCommentsSkipped = 0;
  // Phase 23.1 — the mirror image: comments WE hearted after drafting a reply. Counted for
  // the same reason as the two above. An action taken in the creator's account that cannot
  // be observed is one they discover by scrolling their own channel.
  let heartedCommentsApplied = 0;

  // Cap the excerpt: enough to recognise the comment, far too little to fill a log.
  const previewOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  /**
   * THE GATE every detected comment passes through: this node, or one of the two
   * "we wrote this" tests.
   *
   * Routing all three detection paths through ONE function is the point. The loop came back
   * from three independent call sites, and a filter added to only one of them would look
   * complete while two thirds of the paths still fed the pipeline. `verify-extension.mjs`
   * asserts that no path calls `accept(` directly.
   *
   * @param {HTMLElement} node
   * @param {string} source - which selector path found it
   * @returns {Object|null} the accepted comment, or null
   */
  const acceptNode = function (node, source) {
    // THE CHANNEL OWNER'S HEART. A heart means the creator has already read this comment and
    // singled it out, so the extension answers it exactly once more — to someone who has
    // already been spoken to, on a thread the creator is watching. Excluded before the text
    // is parsed, so it never reaches the model, the semantic matcher or the queue.
    //
    // Checked BEFORE parseComment() rather than alongside the own-comment test: reading the
    // heart needs no comment text, and doing it first means a hearted comment never has its
    // body even extracted. Failing open is deliberate — an unreadable markup means the
    // comment is processed normally, which is the recoverable direction here.
    //
    // The user's switch is tested FIRST, so a filter that is off costs one cached boolean per
    // batch and no DOM query at all. That ordering matters here and not just for tidiness:
    // this runs on the mutation path, which fires every 300ms while the creator scrolls.
    if (isHeartFilterEnabled() &&
        typeof adapter.isHeartedComment === 'function' && adapter.isHeartedComment(node)) {
      heartedCommentsSkipped++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_HEARTED',
        level: 'DEBUG',
        data: { source: source, detectedBy: 'creator-heart' }
      });
      return null;
    }
    if (isCreatorReplyFilterEnabled() &&
        typeof adapter.hasCreatorReply === 'function' && adapter.hasCreatorReply(node)) {
      creatorRepliedCommentsSkipped++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_CREATOR_REPLIED',
        level: 'DEBUG',
        data: { source: source, detectedBy: 'creator-reply-in-thread' }
      });
      return null;
    }
    if (typeof adapter.isOwnComment === 'function' && adapter.isOwnComment(node)) {
      ownCommentsSkipped++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_OWN_COMMENT',
        level: 'DEBUG',
        data: { source: source, detectedBy: 'owner-badge' }
      });
      return null;
    }
    // The markup check is the broad one but it is a single CSS class, so the text check
    // backs it up: if YouTube changes that class, every reply we post is still recognised.
    const parsed = adapter.parseComment(node);
    if (parsed && isTextWeWrote(parsed.text)) {
      ownCommentsSkipped++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_OWN_COMMENT',
        level: 'DEBUG',
        commentId: parsed.id,
        data: { source: source, detectedBy: 'own-reply-text' }
      });
      return null;
    }
    return accept(parsed, source);
  };

  /**
   * Record one candidate comment, logging whether it was accepted or why not.
   *
   * Returns the SAME parsed object it was given, so the caller hands that exact object
   * to buildDetectedComment(). Re-parsing would risk a second, different fallback id
   * for the same node and is a behaviour change, not an optimisation.
   *
   * @param {Object|null} parsed
   * @param {string} source - which selector path found it
   * @returns {Object|null} parsed when newly accepted, otherwise null
   */
  const accept = function (parsed, source) {
    if (parsed && !seenIds.has(parsed.id)) {
      seenIds.add(parsed.id);
      uniqueCommentsFound++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_DETECTED',
        level: 'DEBUG',
        commentId: parsed.id,
        data: {
          source: source,
          textPreview: previewOf(parsed.text),
          textChars: parsed.text.length,
          author: parsed.author || null,
          knownCommentsSoFar: seenIds.size
        }
      });
      __YTAR_DEBUG.debugLog('New comment detected:', parsed.text.substring(0, 50) + '...');
      return parsed;
    }
    if (parsed) {
      duplicateNodesIgnored++;
      // Logged rather than silently skipped: a duplicate is the single most likely
      // cause of an inflated counter.
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_DETECTED_DUPLICATE',
        level: 'DEBUG',
        commentId: parsed.id,
        data: { source: source, reason: 'already in seenIds' }
      });
    } else {
      parseFailures++;
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_PARSE_FAILED',
        level: 'WARN',
        data: { source: source }
      });
    }
    return null;
  };

  for (const node of nodes) {
    // Only treat the node itself as a comment if it IS one. The observer also hands
    // us large containers; parseComment() on a container would return the first
    // comment inside it under a fabricated fallback id, creating a bogus comment and
    // burning a seenIds entry for it.
    if (adapter.isCommentNode(node)) {
      const accepted = acceptNode(node, 'mutation_node');
      if (accepted) {
        // Send to background via message bridge
        sendMessage('COMMENT_DETECTED', { comment: buildDetectedComment(accepted) }).catch(function (err) {
          __YTAR_DEBUG.logError('sendMessage failed for comment id=' + accepted.id + ': ' + err.message);
        });
      }
    } else {
      nonCommentNodesSkipped++;
    }

    // Also check for nested comment threads within the mutation.
    // Use adapter's static SELECTORS property (exposed for cross-script access).
    // querySelectorAll matches all descendants, not just direct children, so a
    // comment rendered several levels below the inserted node is also found.
    const childComments = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD);
    if (childComments.length > 0) {
      childComments.forEach(function (commentNode) {
        const pc = acceptNode(commentNode, 'nested_thread');
        if (pc) {
          sendMessage('COMMENT_DETECTED', { comment: buildDetectedComment(pc) }).catch(function (err) {
            __YTAR_DEBUG.logError('sendMessage failed for comment id=' + pc.id + ': ' + err.message);
          });
        }
      });
    }

    // A mutation may also carry comments that use the inner renderer only. Covered by
    // the adapter's own selector list so detection does not depend on the wrapper tag.
    const innerComments = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_RENDERER);
    innerComments.forEach(function (commentNode) {
      // Skip renderers already covered as descendants of a matched thread.
      if (commentNode.closest && commentNode.closest(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD)) return;
      const pc = acceptNode(commentNode, 'inner_renderer');
      if (pc) {
        sendMessage('COMMENT_DETECTED', { comment: buildDetectedComment(pc) }).catch(function (err) {
          __YTAR_DEBUG.logError('sendMessage failed for comment id=' + pc.id + ': ' + err.message);
        });
      }
    });

    // Modern YouTube comments and thread replies use ytd-comment-view-model directly.
    const viewModels = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_VIEW_MODEL);
    viewModels.forEach(function (commentNode) {
      const pc = acceptNode(commentNode, 'view_model');
      if (pc) {
        sendMessage('COMMENT_DETECTED', { comment: buildDetectedComment(pc) }).catch(function (err) {
          __YTAR_DEBUG.logError('sendMessage failed for comment id=' + pc.id + ': ' + err.message);
        });
      }
    });
  }

  // One summary per batch, so the totals are reconstructable without reading every
  // individual detection line.
  __YTAR_DEBUG.devLog({
    component: 'CONTENT',
    event: 'COMMENT_SCAN_END',
    level: 'DEBUG',
    data: {
      nodesExamined: nodes.length,
      nonCommentNodesSkipped,
      // Phase 20.23. Reported because a filter that cannot be observed is indistinguishable
      // from working code: if this is 0 while replies are being posted, the own-comment
      // filter has stopped matching YouTube's markup and the loop is about to come back.
      ownCommentsSkipped,
      // The creator-heart filter's own tally, for the same observability reason.
      heartedCommentsSkipped,
      // Phase 23.1 — hearts we APPLIED, alongside the hearts we honoured.
      heartedCommentsApplied,
      uniqueCommentsFound,
      duplicateNodesIgnored,
      parseFailures,
      seenIdsSize: seenIds.size
    }
  });
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

    // Phase 22: a batch that carried thread activity is also the moment a previously
    // expanded thread's replies exist. The scan is self-throttled, so this rides the
    // existing debounce without adding a second timer — and without turning a scroll burst
    // into a scan per batch.
    scanAnsweredComments().catch(function (err) {
      __YTAR_DEBUG.logError('Error in scanAnsweredComments:', err);
    });
  }, THROTTLE_MS);
}

let activeMutationObserver = null;
let currentEnabledState = false;

/**
 * Start observing and detecting comments when extension is enabled.
 */
function startCommentDetection() {
  if (!SiteAdapter) {
    __YTAR_DEBUG.debugLog('Comment detection skipped - adapter not loaded');
    return;
  }

  // Start MutationObserver if not running
  if (!activeMutationObserver) {
    setupMutationObserver(true);
  }

  // Detect existing comments on page load or enable
  detectExistingComments(true).catch(function (error) {
    __YTAR_DEBUG.logError('Error in detectExistingComments:', error);
  });

  // Check answered followups if enabled
  if (isFollowupEnabled()) {
    scanAnsweredComments({ force: true }).catch(function (error) {
      __YTAR_DEBUG.logError('Error in scanAnsweredComments:', error);
    });
  }
}

/**
 * Stop observing comments when extension is disabled.
 */
function stopCommentDetection() {
  if (activeMutationObserver) {
    activeMutationObserver.disconnect();
    activeMutationObserver = null;
    __YTAR_DEBUG.debugLog('MutationObserver stopped');
  }
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  pendingNodes = [];
}

/**
 * Set up MutationObserver for new comments.
 */
function setupMutationObserver(enabled) {
  if (!enabled || !SiteAdapter) {
    __YTAR_DEBUG.debugLog('MutationObserver skipped - disabled or adapter not loaded');
    return;
  }

  if (activeMutationObserver) {
    activeMutationObserver.disconnect();
    activeMutationObserver = null;
  }

  function observeComments() {

    __YTAR_DEBUG.debugLog('MutationObserver started');

    const config = {
      childList: true,
      subtree: true
      // attributes: true is dropped - we only need to detect new comment nodes.
      // data-id changes on existing elements don't add comments (they're handled via childList).
    };

    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          // Skip non-element nodes.
          if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }

          pendingNodes.push(node);

          // Schedule flush after debounce window (throttles callback frequency)
          scheduleFlush();
        });
      });
    });

    observer.observe(document.body, config);
    activeMutationObserver = observer;

    // Cleanup on page teardown.
    //
    // `pagehide`, NOT `unload`. `unload` is disabled by a Permissions-Policy on YouTube
    // documents, so registering one logs "[Violation] Permissions policy violation: unload is
    // not allowed in this document" on every single page load, and — worse — the listener is
    // never invoked, so the handler silently does nothing while looking like it works.
    // `pagehide` fires for the same teardown and is not policy-gated.
    window.addEventListener('pagehide', function() {
      if (activeMutationObserver) {
        activeMutationObserver.disconnect();
        activeMutationObserver = null;
      }
    });
  }

  observeComments();
}

/**
 * Detect existing comments on page load.
 */
async function detectExistingComments(enabled) {
  if (!enabled || !SiteAdapter) {
    __YTAR_DEBUG.debugLog('Comment detection skipped - disabled or adapter not loaded');
    return;
  }

  const adapter = new SiteAdapter();

  reportStage(STAGE_LABELS_FOR_REPORT.READING_COMMENTS, '', '');

  // Check if page is supported first
  if (!adapter.isSupportedPage()) {
    __YTAR_DEBUG.debugWarn('Not on a supported YouTube page');
    return;
  }

  const commentNodes = adapter.findCommentNodes();
  
  if (commentNodes.length === 0) {
    __YTAR_DEBUG.debugLog('No comments found on this page');
    return;
  }

  __YTAR_DEBUG.debugLog('Found', commentNodes.length, 'comment(s) on page load');

  // Parse each comment and log the results
  for (const node of commentNodes) {
    // The channel owner's heart, on the PAGE-LOAD path.
    //
    // This loop does not go through `acceptNode()`, so the gate above does not run for it —
    // and a hearted comment is very often already on screen when the tab opens, because that
    // is exactly how a comment gets a heart. Checking only `acceptNode()` would therefore
    // exclude hearted comments that arrive while you are watching and let through every one
    // that was already there, which is the majority of them.
    //
    // Kept as an explicit second call rather than by routing this path through `acceptNode()`
    // to avoid changing behaviour for the OWN-comment filter that loop has never applied.
    if (isHeartFilterEnabled() &&
        typeof adapter.isHeartedComment === 'function' && adapter.isHeartedComment(node)) {
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_HEARTED',
        level: 'DEBUG',
        data: { source: 'page_load', detectedBy: 'creator-heart' }
      });
      continue;
    }
    if (isCreatorReplyFilterEnabled() &&
        typeof adapter.hasCreatorReply === 'function' && adapter.hasCreatorReply(node)) {
      __YTAR_DEBUG.devLog({
        component: 'CONTENT',
        event: 'COMMENT_SKIPPED_CREATOR_REPLIED',
        level: 'DEBUG',
        data: { source: 'page_load', detectedBy: 'creator-reply-in-thread' }
      });
      continue;
    }

    const parsedComment = adapter.parseComment(node);
    
    if (!parsedComment) {
      __YTAR_DEBUG.debugWarn('Failed to parse comment:', node.getAttribute('data-id') || 'unknown');
      continue;
    }

    // Add ID to seenIds so this comment won't be reported again when mutations occur.
    //
    // This is PAGE-SESSION state and that is exactly right: it lives in this content
    // script, which Chrome recreates on every page load, so a reload starts with an empty
    // set and re-detects every visible comment. It is not the deduplication that should
    // survive a reload — only a genuinely published reply is (see handled-comments.js).
    seenIds.add(parsedComment.id);
    
    // Log the parsed comment (truncated for readability)
    const textPreview = parsedComment.text.substring(0, 60);
    __YTAR_DEBUG.debugLog('Comment detected:', textPreview + '...');
    
    // Send to background via message bridge
    sendMessage('COMMENT_DETECTED', { comment: buildDetectedComment(parsedComment) }).catch(function (err) {
      __YTAR_DEBUG.logError('sendMessage failed for comment id=' + parsedComment.id + ': ' + err.message);
    });
  }
}

// ─── Phase 22: comments the creator has already answered ───────────────────────
//
// A SEPARATE path with its own message, and it never touches COMMENT_DETECTED. That
// separation is the whole safety property of the feature: these comments have already been
// answered by hand, so putting them through the auto-reply pipeline would publish a second
// automated reply under the creator's name to a viewer who already got one. `verify-
// extension.mjs` asserts this function never sends COMMENT_DETECTED.
//
// The toggle is read here rather than in the worker for the same reason the picker gesture
// lives in the page: the scan EXPANDS collapsed threads, which clicks real controls on the
// page, and that must not happen at all when the feature is off.
//
// The qualification decision — "does this thread carry a reply from the channel owner?" —
// is NOT made here. It belongs to core/answered-followups.js, which is an ES module and
// therefore unreachable from a content script; duplicating it would be the second copy of
// an Arabic rule that drifts silently. This function ships the raw evidence and lets the
// worker decide.

/** How many threads to expand per pass. Expanding is a real click; unbounded is a hang. */
const FOLLOWUP_MAX_EXPANSIONS_PER_PASS = 8;

/**
 * Minimum gap between scans.
 *
 * The mutation debounce is 300 ms, and scrolling a comment section fires batches back to
 * back — so without this the scan would run several times a second, each one doing a
 * storage read and a `querySelectorAll` over the whole comment list. On a busy video that
 * is real main-thread work for a feature that is usually switched OFF, and it is paid
 * whether or not the creator uses it.
 */
const FOLLOWUP_MIN_SCAN_INTERVAL_MS = 5000;

/** Ids already reported to the worker this page session. */
const followupSeenIds = new Set();

let followupLastScanAt = 0;

/**
 * The replyBehavior toggles the PAGE needs, CACHED, in ONE storage read.
 *
 * Both `followupOnAnswered` and `ignoreHeartedComments` are cached together rather than each
 * getting its own read: `chrome.storage.onChanged` fires for the whole `replyBehavior` object,
 * so two listeners would mean two `chrome.storage.local.get` calls per settings change, for
 * the sake of two booleans that arrive in the same object.
 *
 * It is re-read when `chrome.storage.onChanged` fires, so the cache cannot go stale across a
 * real change — and a stale tab that never sees the event keeps whatever value it last saw,
 * which the worker then rejects anyway. That is the right way round: the page is allowed to
 * be stale, the worker is not.
 */
let followupEnabledCache = false;
let heartFilterEnabledCache = false;
let creatorReplyFilterEnabledCache = false;
let followupCacheLoaded = false;

function isFollowupEnabled() {
  return followupEnabledCache;
}

/**
 * Whether the page may skip a comment the creator hearted.
 *
 * FAILS CLOSED, and that is the opposite of `isHeartedComment`'s own rule, so the asymmetry is
 * deliberate rather than an accident. This flag answers "did the user turn the POLICY on?", and
 * a flag we could not read is a policy whose state is unknown; skipping is the state that
 * preserves today's behaviour when the read works, so an unread one falls back to it. The
 * opposite choice would mean a storage failure silently mutes every comment on the page, and
 * unlike a heart, nobody would be able to see why.
 */
function isHeartFilterEnabled() {
  return heartFilterEnabledCache;
}

/**
 * Whether the page may skip a comment thread the creator already replied to.
 */
function isCreatorReplyFilterEnabled() {
  return creatorReplyFilterEnabledCache;
}

async function refreshBehaviorSettings() {
  try {
    const result = await chrome.storage.local.get('replyBehavior');
    const behavior = result && result.replyBehavior;
    followupEnabledCache = Boolean(behavior && behavior.followupOnAnswered === true);
    // Mirrors DEFAULT_CONFIG, because this page reads RAW storage and never sees the deep merge
    // `getSettings()` does. Reading `=== true` here would make a fresh install — where the key
    // is simply absent — disagree with the worker, which merges the default and filters. Two
    // halves of one feature reading opposite defaults is the exact bug a fresh install hides,
    // since a user who has saved once never sees it.
    heartFilterEnabledCache = !(behavior && behavior.ignoreHeartedComments === false);
    creatorReplyFilterEnabledCache = !(behavior && behavior.ignoreCreatorRepliedComments === false);
  } catch (error) {
    __YTAR_DEBUG.logError('Could not read the reply behavior settings:', error);
    followupEnabledCache = false;
    // The read THREW, so the policy's state is genuinely unknown rather than merely absent.
    // Do not filter: see isHeartFilterEnabled().
    heartFilterEnabledCache = false;
    creatorReplyFilterEnabledCache = false;
  }
  followupCacheLoaded = true;
  return {
    followup: followupEnabledCache,
    heartFilter: heartFilterEnabledCache,
    creatorReplyFilter: creatorReplyFilterEnabledCache
  };
}

/**
 * Find threads carrying a reply from the channel owner, and report them.
 *
 * Collapsed threads are expanded first, in a bounded number, because YouTube renders only
 * the reply COUNT until a click — so a collapsed thread is indistinguishable from an
 * unanswered one, and skipping the expansion would report every collapsed thread as
 * "nobody answered this". The expansion clicks YouTube's own "View N replies" control, which
 * is visible on screen; nothing is dispatched synthetically.
 *
 * @returns {Promise<void>}
 */
async function scanAnsweredComments(options = {}) {
  if (!SiteAdapter) return;

  if (!followupCacheLoaded) await refreshBehaviorSettings();
  if (!isFollowupEnabled()) {
    if (!options.quiet) {
      __YTAR_DEBUG.debugLog('Follow-up scan skipped - the feature is off');
    }
    return;
  }

  // The gap check is AFTER the toggle, so a disabled feature still costs one cached boolean
  // test per batch and nothing else — which is the point of caching it.
  const now = Date.now();
  if (!options.force && now - followupLastScanAt < FOLLOWUP_MIN_SCAN_INTERVAL_MS) return;
  followupLastScanAt = now;

  const adapter = new SiteAdapter();
  if (!adapter.isSupportedPage()) return;

  let threads;
  try {
    threads = adapter.findCommentNodes();
  } catch (error) {
    __YTAR_DEBUG.logError('Follow-up scan could not list threads:', error);
    return;
  }

  let expanded = 0;
  let reported = 0;
  let collapsedLeft = 0;

  for (const thread of threads) {
    try {
      const expander =
        typeof adapter.getRepliesExpander === 'function' ? adapter.getRepliesExpander(thread) : null;
      if (expander) {
        if (expanded >= FOLLOWUP_MAX_EXPANSIONS_PER_PASS) {
          collapsedLeft++;
          continue;
        }
        if (adapter.expandReplies(expander)) {
          expanded++;
          // The replies render asynchronously. Reading now would see an empty list and
          // record a thread as unanswered, which is the one wrong answer this feature can
          // give — so the node is left for the MutationObserver, which re-runs this scan
          // when the bodies actually arrive.
          continue;
        }
      }

      const replies = adapter.readThreadReplies(thread);
      if (!replies || replies.length === 0) continue;

      const parsed = adapter.parseComment(thread);
      if (!parsed || followupSeenIds.has(parsed.id)) continue;
      followupSeenIds.add(parsed.id);

      sendMessage('ANSWERED_COMMENT_FOUND', {
        comment: {
          id: parsed.id,
          author: parsed.author,
          text: parsed.text
        },
        replies: replies.slice(0, 20).map(function (r) {
          return { author: r.author, text: r.text, isOwner: r.isOwner === true };
        })
      }).catch(function (err) {
        __YTAR_DEBUG.logError('Could not report an answered comment: ' + err.message);
        followupSeenIds.delete(parsed.id);
      });
      reported++;
    } catch (error) {
      __YTAR_DEBUG.logError('Follow-up scan failed on a thread:', error);
    }
  }

  __YTAR_DEBUG.devLog({
    component: 'CONTENT',
    event: 'FOLLOWUP_SCAN_END',
    level: 'DEBUG',
    data: {
      threadsExamined: threads.length,
      threadsExpanded: expanded,
      collapsedDeferred: collapsedLeft,
      reported: reported
    }
  });
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
function enqueueReply(fn, commentId) {
  _replyQueue = _replyQueue.then(function () {
    return fn().catch(function (err) {
      __YTAR_DEBUG.logError('Reply queue task failed:', err && err.message ? err.message : String(err));
      if (commentId) {
        reportStage(STAGE_LABELS_FOR_REPORT.ERROR, OUTCOME_FOR_REPORT.FAILED, commentId);
      }
    });
  });
}

/**
 * Guard so a single comment can never be published twice (Task 13.5).
 *
 * YouTube can replace comment DOM nodes mid-reply, and a MATCH response can also be
 * seen more than once if the observer re-reports a comment. Without this set, a
 * re-attempt after a DOM change could post the same reply twice.
 */
const _publishAttempts = new Set();
const _queuedReplyIds = new Set();

/**
 * Enqueue a MATCH reply at most once per comment ID, even when both
 * `sendMessage`'s callback and `MATCH_REPLY_READY` deliver the same verdict.
 */
function enqueueMatchReplyOnce(comment, response) {
  const id = (response && response.id) || (comment && comment.id);
  if (id) {
    if (_queuedReplyIds.has(id) || _publishAttempts.has(id)) {
      return false;
    }
    _queuedReplyIds.add(id);
  }
  enqueueReply(function () {
    return handleMatchReply(comment, response);
  }, id);
  return true;
}

/**
 * Tell the background which processing stage the reply has reached.
 *
 * The content script is the only context that can see the posting steps, so the Popup's
 * stage readout depends on these reports. It is strictly observability: the message is
 * fire-and-forget, its result is ignored, and a failure is swallowed, so a reporting
 * problem can never delay or break a reply.
 *
 * `outcome` is sent only when the attempt actually ends. A stage on its own is a
 * mid-flight update and leaves the background's attempt open.
 *
 * @param {string} stage   - one of the STAGE values in core/processing-stats.js
 * @param {string} [outcome] - one of the OUTCOME values, when the attempt ended
 * @param {string} [commentId]
 */
function reportStage(stage, outcome, commentId) {
  try {
    if (!chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({
      action: 'REPORT_PROCESSING_STAGE',
      stage: stage,
      outcome: outcome || '',
      commentId: commentId || ''
    }, function () {
      // Reading lastError marks it as handled; a closed channel here is not our problem.
      void chrome.runtime.lastError;
    });
  } catch (err) {
    __YTAR_DEBUG.debugWarn('reportStage failed:', err.message);
  }
}

// The STAGE/OUTCOME values are duplicated as literals because content scripts cannot
// use ES modules. They must stay in step with core/processing-stats.js, which rejects
// any value it does not recognise — a mismatch shows up as a stage that never moves
// rather than as a silent counter error.
const STAGE_LABELS_FOR_REPORT = {
  READING_COMMENTS: 'reading_comments',
  CHECKING_MATCHES: 'checking_matches',
  PREPARING_REPLY: 'preparing_reply',
  WAITING_FOR_LM: 'waiting_for_lm',
  OPENING_REPLY_BOX: 'opening_reply_box',
  INSERTING_REPLY: 'inserting_reply',
  // Phase 23.1 — a real, observable step: the creator's heart is applied here, after the
  // draft is in the box and before submit. A stage of its own because "did it heart?" is
  // otherwise invisible — the panel's stage list would jump from inserting to submitting.
  HEARTING_COMMENT: 'hearting_comment',
  SUBMITTING_REPLY: 'submitting_reply',
  COMPLETED: 'completed',
  IDLE: 'idle',
  ERROR: 'error'
};

const OUTCOME_FOR_REPORT = {
  SUBMITTED: 'submitted',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

/**
 * Handle a MATCH response from the background.  Runs sequentially via the queue.
 *
 * Task 13.5 — YouTube is a single-page app and may replace comment nodes between the
 * detection and the publish steps. Each step therefore re-checks that the comment is
 * still attached and re-finds it when it is not. If the comment cannot be found the
 * task aborts quietly: nothing is published against a node that is no longer on screen,
 * and the reply is never re-attempted blindly.
 *
 * @param {Object} comment - Local parsed comment (has .element)
 * @param {Object} response - Response object from sendMessage
 */
async function handleMatchReply(comment, response) {
  __YTAR_DEBUG.debugLog('MATCH detected for comment id=' + comment.id + '; preparing reply');

  // Remember the text BEFORE publishing. The reply re-renders in the page as a comment
  // within a second or two, and the observer has to recognise it the moment it appears —
  // recording it after the publish settles is a race with the very node it is meant to catch.
  rememberOwnReply(response && response.reply);

  const adapter = new SiteAdapter();
  const S = STAGE_LABELS_FOR_REPORT;

  // One span across the whole publish sequence. Because the individual adapter steps
  // log their own spans, a slow run is attributable to a step rather than to "the
  // reply took 20 seconds".
  const publishTimer = __YTAR_DEBUG.startTimer({
    component: 'REPLY',
    event: 'PUBLISH_VERIFY',
    endEvent: 'PUBLISH_VERIFIED',
    errorEvent: 'PUBLISH_FAILED',
    commentId: comment.id,
    data: {
      replyChars: response && typeof response.reply === 'string' ? response.reply.length : null,
      commentConnected: !adapter.isCommentDetached(comment)
    }
  });

  // Every exit path below reports a terminal outcome exactly once, so the background
  // can close the attempt. `reportStage` is fire-and-forget, so this costs nothing on
  // the reply path itself.
  let finished = false;
  function finish(stage, outcome) {
    if (finished) return;
    finished = true;
    reportStage(stage, outcome, comment.id);
  }

  // Refuse a second publish attempt for the same comment outright.
  if (_publishAttempts.has(comment.id)) {
    __YTAR_DEBUG.debugWarn('handleMatchReply: already attempted a reply for comment id=' + comment.id + ' — not repeating it');
    publishTimer.done({ outcome: 'skipped', reason: 'already attempted this comment' });
    finish(S.IDLE, OUTCOME_FOR_REPORT.SKIPPED);
    return;
  }
  _publishAttempts.add(comment.id);

  try {
    reportStage(S.PREPARING_REPLY, '', comment.id);

    if (isHeartFilterEnabled() &&
        typeof adapter.isHeartedComment === 'function' &&
        adapter.isHeartedComment(comment.element || comment)) {
      __YTAR_DEBUG.debugLog('handleMatchReply: creator heart detected in live DOM; skipping comment id=' + comment.id);
      publishTimer.done({ outcome: 'skipped', reason: 'creator hearted' });
      finish(S.IDLE, OUTCOME_FOR_REPORT.SKIPPED);
      return;
    }

    if (isCreatorReplyFilterEnabled() &&
        typeof adapter.hasCreatorReply === 'function' &&
        adapter.hasCreatorReply(comment.element || comment)) {
      __YTAR_DEBUG.debugLog('handleMatchReply: creator reply detected in live DOM; skipping comment id=' + comment.id);
      publishTimer.done({ outcome: 'skipped', reason: 'creator already replied' });
      finish(S.IDLE, OUTCOME_FOR_REPORT.SKIPPED);
      return;
    }

    // Task 13.5: re-find the comment when YouTube has replaced its DOM node.
    if (adapter.isCommentDetached(comment)) {
      const refreshed = adapter.reacquireComment(comment);
      if (!refreshed) {
        __YTAR_DEBUG.logError('handleMatchReply: comment id=' + comment.id +
          ' left the DOM and could not be re-found — aborting without publishing');
        publishTimer.fail(null, { outcome: 'failed', reason: 'comment node detached and could not be re-found' });
        finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
        return;
      }
      __YTAR_DEBUG.debugLog('handleMatchReply: re-acquired the live element for comment id=' + refreshed.id);
      comment = refreshed;
    }

    // Step a: find the reply button
    var replyBtn = adapter.findReplyButton(comment);
    if (!replyBtn) {
      __YTAR_DEBUG.logError('handleMatchReply: findReplyButton returned null for comment id=' + comment.id);
      finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
      return;
    }

    // Step b: open the reply box (async)
    reportStage(S.OPENING_REPLY_BOX, '', comment.id);
    var replyBox = await adapter.openReplyBox(comment);
    if (!replyBox) {
      __YTAR_DEBUG.logError('handleMatchReply: openReplyBox returned null for comment id=' + comment.id);
      finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
      return;
    }

    // Task 13.5: the reply box itself can be torn down between opening it and filling it
    // in (e.g. the comments panel is collapsed or the user scrolls a re-render through).
    // Re-find the comment once; if that no longer works, abort rather than typing into a
    // detached editor.
    if (typeof replyBox.isConnected === 'boolean' && !replyBox.isConnected) {
      __YTAR_DEBUG.debugWarn('handleMatchReply: reply box detached before typing for comment id=' + comment.id);
      const refreshed = adapter.reacquireComment(comment);
      if (!refreshed) {
        __YTAR_DEBUG.logError('handleMatchReply: could not re-find comment id=' + comment.id + ' — aborting without publishing');
        finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
        return;
      }
      comment = refreshed;
      replyBox = await adapter.openReplyBox(comment);
      if (!replyBox) {
        __YTAR_DEBUG.logError('handleMatchReply: could not re-open the reply box for comment id=' + comment.id);
        publishTimer.fail(null, { outcome: 'failed', reason: 'reply box could not be opened' });
        finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
        return;
      }
    }

    // Step c: set the reply text
    reportStage(S.INSERTING_REPLY, '', comment.id);
    var setTextOk = adapter.setReplyText(replyBox, response.reply);
    if (!setTextOk) {
      __YTAR_DEBUG.logError('handleMatchReply: setReplyText returned false for comment id=' + comment.id);
      publishTimer.fail(null, { outcome: 'failed', reason: 'setReplyText returned false', step: 'insert' });
      finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
      return;
    }

    // Step d: Phase 23.1 — apply the creator's heart, now that the draft is in the box.
    //
    // ORDERING IS THE REQUIREMENT, not a preference: the heart goes on AFTER the text is
    // successfully inserted (there is now a draft that deserves it) and BEFORE the submit
    // step, which in dry-run is where the run stops and nothing is published. So a dry-run
    // pass never reaches a click at all.
    //
    // TWO INDEPENDENT GATES, deliberately:
    //   1. `response.heartAfterInsert` — decided by the service worker from the creator's
    //      CURRENT settings. This is what makes the feature enforceable from the background:
    //      a stale tab or panel cannot continue hearting after it has been switched off,
    //      because this value was computed in the worker, not here.
    //   2. `dryRun` re-read from storage — fails SAFE to true. The worker's read happened
    //      before the reply box was even open; this one happens with the draft in front of
    //      the user, which is the last moment a changed setting can still be honoured.
    //
    // Failure here NEVER fails the comment. A heart is a courtesy on a reply that was
    // already drafted correctly; treating a failed heart as a failed publish would discard
    // a good draft and misreport the run.
    if (response.heartAfterInsert === true) {
      reportStage(S.HEARTING_COMMENT, '', comment.id);

      // Re-acquire live node in case opening the reply box re-rendered the action buttons
      if (adapter.isCommentDetached(comment)) {
        const refreshed = adapter.reacquireComment(comment);
        if (refreshed) comment = refreshed;
      }

      var dryRunNow = await adapter.isDryRunActive('handleMatchReply:heart');
      if (dryRunNow) {
        __YTAR_DEBUG.debugLog(
          'handleMatchReply: dry run active; skipping creator heart (id=' + comment.id + ')'
        );
      } else {
        var hearted = adapter.heartComment(comment.element || comment);
        if (hearted) {
          heartedCommentsApplied++;
          __YTAR_DEBUG.debugLog(
            'handleMatchReply: hearted the comment after drafting (id=' + comment.id + ')'
          );
        } else {
          __YTAR_DEBUG.debugWarn(
            'handleMatchReply: could not heart the comment (id=' + comment.id + ') — draft left in place'
          );
        }
      }

      // Target Replies & Hearting workflow: leave the reply in the editor for manual
      // review by the creator; never click Submit automatically. Report SKIPPED so
      // the comment is not counted as submitted or permanently marked handled.
      __YTAR_DEBUG.debugLog('handleMatchReply: draft inserted and heart step completed; leaving in editor');
      publishTimer.done({ outcome: 'drafted', step: 'heart_after_insert' });
      finish(S.IDLE, OUTCOME_FOR_REPORT.SKIPPED);
      return;
    }

    // Step e: submit the reply (async; respects dryRun gate internally)
    reportStage(S.SUBMITTING_REPLY, '', comment.id);
    var submitted = await adapter.submitReply(replyBox);
    if (!submitted) {
      __YTAR_DEBUG.debugWarn('handleMatchReply: submitReply returned false for comment id=' + comment.id);
      // submitReply() returns false in dry-run on purpose (nothing was clicked) and also
      // when the button could not be found. Both are an attempt that ended without a
      // reply going out, so both count as a skip rather than a submission.
      // `dryRunUnknown` is left to the adapter's own SUBMIT_REPLY_DRY_RUN entry, which is
      // the only place that knows which of the two happened.
      publishTimer.done({ outcome: 'skipped', reason: 'submitReply returned false', step: 'submit' });
      finish(S.IDLE, OUTCOME_FOR_REPORT.SKIPPED);
      return;
    }

    __YTAR_DEBUG.debugLog('handleMatchReply: reply submission completed for comment id=' + comment.id);
    publishTimer.done({ outcome: 'submitted', step: 'complete' });
    finish(S.COMPLETED, OUTCOME_FOR_REPORT.SUBMITTED);
  } catch (err) {
    __YTAR_DEBUG.logError('handleMatchReply error:', err && err.message ? err.message : String(err));
    if (publishTimer && typeof publishTimer.fail === 'function') {
      publishTimer.fail(err, { outcome: 'failed', reason: err && err.message ? err.message : String(err) });
    }
    finish(S.ERROR, OUTCOME_FOR_REPORT.FAILED);
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
        __YTAR_DEBUG.logError('Message failed:', chrome.runtime.lastError.message);
        reject(err);
        return;
      }

      // Log the received response from background
      if (!response || !response.success) {
        const errorMsg = response && response.error ? ': ' + response.error : '';
        __YTAR_DEBUG.logError('Background response failed' + errorMsg);
        reject(new Error('Background response failed' + errorMsg));
        return;
      }

      // Success case - log the echoed id to prove round-trip works
      if (response.id !== undefined) {
        __YTAR_DEBUG.debugLog('Round-trip confirmed: background received comment id="' + response.id + '"');
      } else if (response.received === true) {
        // Legacy response format for backward compatibility
        __YTAR_DEBUG.debugLog('Background acknowledged message');
      }

      // Phase 8.3: Act on MATCH responses — enqueue reply processing
      if (response.result === 'MATCH' && response.reply) {
        // The local `data` object still has the full comment with .element;
        // the response only carries the stripped payload.
        var localComment = (data && data.comment) || (response.id && detectedCommentsMap.get(response.id)) || null;
        if (!localComment && response.id) {
          localComment = { id: response.id, element: null };
        }
        if (localComment) {
          enqueueMatchReplyOnce(localComment, response);
        }
      } else if (response.result === 'MATCH' && !response.reply) {
        __YTAR_DEBUG.debugLog('MATCH but empty reply — skipping for comment id=' + (response.id || '?'));
        reportStage(STAGE_LABELS_FOR_REPORT.IDLE, OUTCOME_FOR_REPORT.SKIPPED, response.id || '');
      } else if (response.result === 'NO_MATCH') {
        __YTAR_DEBUG.debugLog('NO_MATCH for comment id=' + (response.id || '?'));
      }

      resolve(response);
    });
  });
}

// Listen for pushed match events from the background (in case message port timed out during long queue wait)
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.action === 'MATCH_REPLY_READY' && message.data) {
      var resp = message.data;
      if (resp.result === 'MATCH' && resp.reply && resp.id) {
        var local = (detectedCommentsMap && detectedCommentsMap.get(resp.id)) || { id: resp.id, element: null };
        enqueueMatchReplyOnce(local, resp);
      }
      if (typeof sendResponse === 'function') sendResponse({ received: true });
      return false;
    }
  });
}

// Main initialization
async function init() {
  // Check if we're on a supported page first
  if (!isSupportedPage()) {
    __YTAR_DEBUG.debugWarn('Not running on YouTube - skipping');
    return;
  }

  __YTAR_DEBUG.debugLog('Running on YouTube domain');

  // Read the replyBehavior toggles BEFORE any detection, and AWAIT them.
  //
  // This is ordering, not politeness. `acceptNode()` is synchronous and consults the cached
  // heart-filter flag, so starting detection first would run the whole first batch against
  // `false` — the "unreadable policy, don't filter" fallback — and a hearted comment arriving
  // in that first batch would be answered. `refreshBehaviorSettings` swallows its own errors,
  // so this cannot reject and strand init below it.
  await refreshBehaviorSettings();

  // Reset processing stats on page load/reload so the live counters count fresh for this page session.
  sendMessage('RESET_PROCESSING_STATS', { reason: 'page_load' }).catch(function () {});

  currentEnabledState = await getEnabledState();

  if (currentEnabledState) {
    __YTAR_DEBUG.debugLog('Running on YouTube domain, enabled=true');
    startCommentDetection();
  } else {
    __YTAR_DEBUG.debugLog('Extension is disabled - comment detection waiting for enable');
  }

  // Storage change listener: handles BOTH enabled toggles and replyBehavior changes
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    if (changes.enabled) {
      const newEnabled = Boolean(changes.enabled.newValue);
      if (newEnabled !== currentEnabledState) {
        currentEnabledState = newEnabled;
        if (newEnabled) {
          __YTAR_DEBUG.debugLog('Extension enabled via storage - starting comment detection');
          startCommentDetection();
        } else {
          __YTAR_DEBUG.debugLog('Extension disabled via storage - stopping comment detection');
          stopCommentDetection();
        }
      }
    }

    if (changes.replyBehavior) {
      refreshBehaviorSettings()
        .then(function (enabled) {
          if (!enabled.followup || !currentEnabledState) return undefined;
          // `force`, because the creator asked for a scan NOW and the interval exists only to
          // stop the scroll-driven path from firing constantly.
          return scanAnsweredComments({ force: true });
        })
        .catch(function () {});
    }
  });

  // On YouTube SPA navigations, clear in-memory seen comments and reset counters for the new page.
  window.addEventListener('yt-navigate-finish', function () {
    seenIds.clear();
    sendMessage('RESET_PROCESSING_STATS', { reason: 'spa_navigate' }).catch(function () {});
    if (currentEnabledState) {
      detectExistingComments(currentEnabledState).catch(function () {});
    }
  });
}

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded, run immediately
  init();
}
