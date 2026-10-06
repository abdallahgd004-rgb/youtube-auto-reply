// YouTube Site Adapter - Phase 5.2, 5.3, 5.4, 5.5, 5.6
// Implements the SiteAdapter interface for comment detection on YouTube

/**
 * YouTube Site Adapter Class
 */
class YouTubeSiteAdapter {
  /**
   * Check if the current page is a supported YouTube page with comments.
   * @returns {boolean} True if on a YouTube page that supports comments
   */
  isSupportedPage() {
    const hostname = window.location.hostname;
    return hostname === 'www.youtube.com' || hostname === 'youtube.com';
  }

  /**
   * Find all comment nodes in the current document.
   * @returns {Array} Array of comment element nodes
   */
  findCommentNodes() {
    const comments = [];
    
    // Try primary selector first (exposed as static property for cross-script access)
    let commentElements = document.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD);
    
    if (commentElements.length === 0) {
      // Fall back to legacy selector
      commentElements = document.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_LEGACY);
    }
    
    if (commentElements.length === 0) {
      // Last resort: try simple selector
      commentElements = document.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_SIMPLE);
    }
    
    for (const element of commentElements) {
      comments.push(element);
    }
    
    return comments;
  }

  /**
   * Parse a single comment node into the normalized shape.
   * 
   * @param {HTMLElement} node - The comment DOM element
   * @returns {Object|null} Parsed comment object or null if parsing fails
   */
  parseComment(node) {
    try {
      // Get stable ID from data-id attribute (YouTube's standard identifier)
      const idAttr = node.getAttribute('data-id');
      let id = idAttr || '';
      
      // Fallback: generate a unique ID based on the element if no data-id exists.
      // Use WeakMap for stability across multiple parse calls on same element.
      if (!id) {
        const fallbackId = YouTubeSiteAdapter._fallbackIds.get(node);
        id = fallbackId || 'comment-' + (++YouTubeSiteAdapter._fallbackCounter);
        if (fallbackId === undefined) {
          YouTubeSiteAdapter._fallbackIds.set(node, id);
        }
      }

      // Extract author name. YouTube has used several markups over time, so try
      // the current anchor first and fall back to the legacy span.
      //
      // Read the element's OWN textContent rather than searching it for nested
      // <span>s: in current markup `.author-name` IS the element holding the
      // name, so a nested span query returns nothing and the author came out
      // empty on every comment.
      let author = '';
      const authorSelectors = [
        YouTubeSiteAdapter.SELECTORS.AUTHOR_LINK,
        YouTubeSiteAdapter.SELECTORS.AUTHOR_LINE
      ];
      for (const selector of authorSelectors) {
        const authorEl = node.querySelector(selector);
        if (!authorEl) continue;
        const text = (authorEl.textContent || '').trim();
        // Skip metadata markers such as "[deleted]" or "[الم|作者 محذوف]".
        if (text && !text.startsWith('[')) {
          author = text;
          break;
        }
      }

      // Extract comment body text only - no author, like count, or button labels.
      // Use ytd-comment-text-renderer (YouTube's stable element for comment body).
      let text = '';
      
      const textRenderers = node.querySelectorAll(YouTubeSiteAdapter.SELECTORS.COMMENT_TEXT);
      for (const renderer of textRenderers) {
        // Read yt-formatted-string content if present, otherwise use the renderer directly.
        const formatted = renderer.querySelector('yt-formatted-string');
        const target = formatted || renderer;
        const rendererText = (target.textContent || '').trim();
        if (rendererText && !rendererText.startsWith('[')) {
          text += (text ? ' ' : '') + rendererText;
        }
      }

      // Clean up the text - remove trailing whitespace and metadata markers FIRST,
      // then check for empty. This ensures we don't accept comments that are only metadata.
      const cleanedText = text.replace(/^\[.*?\]\s*/, '').trim().replace(/\s+/g, ' ');
      
      // Skip comments with empty or whitespace-only text (hard constraint)
      if (!cleanedText || cleanedText.length === 0) {
        return null;
      }

      return {
        id: id,
        author: author,
        text: cleanedText,
        element: node
      };
    } catch (error) {
      console.error('[YouTube Auto Reply] Error parsing comment:', error.message);
      return null;
    }
  }

  /**
   * Find the reply button for a given comment.
   *
   * @param {Object} comment - Parsed comment object with element property
   * @returns {HTMLElement|null} The reply button element or null
   */
  findReplyButton(comment) {
    if (!comment || !comment.element) {
      console.log('[YouTube Auto Reply] findReplyButton: no valid comment');
      return null;
    }

    const el = comment.element;
    let btn = null;

    // Strategy 1: button with aria-label "Reply" inside the comment thread
    try {
      btn = el.querySelector('button[aria-label="Reply"]');
    } catch (_) {}
    if (btn) return btn;

    // Strategy 2: element with data-command="reply"
    try {
      btn = el.querySelector('[data-command="reply"]');
    } catch (_) {}
    if (btn) return btn;

    // Strategy 3: yt-touch-button wrapper containing a tp-yt-paper-icon-button
    try {
      const touchBtn = el.querySelector('yt-touch-button[aria-label="Reply"]');
      if (touchBtn) return touchBtn;
    } catch (_) {}

    // Strategy 4: any button whose textContent contains "reply" (case-insensitive)
    try {
      const buttons = el.querySelectorAll('button');
      for (const b of buttons) {
        if ((b.textContent || '').toLowerCase().includes('reply')) {
          return b;
        }
      }
    } catch (_) {}

    console.log('[YouTube Auto Reply] findReplyButton: no reply button found');
    return null;
  }

  /**
   * Open the reply box for a given comment.
   *
   * @param {Object} comment - Parsed comment object with element property
   * @returns {Promise<HTMLElement|null>} The opened reply editor container or null
   */
  openReplyBox(comment) {
    const btn = this.findReplyButton(comment);
    if (!btn) {
      console.log('[YouTube Auto Reply] openReplyBox: no reply button found');
      return Promise.resolve(null);
    }

    // Click the reply button to trigger YouTube's reply UI
    try {
      btn.click();
    } catch (e) {
      console.warn('[YouTube Auto Reply] openReplyBox: click failed:', e.message);
      return Promise.resolve(null);
    }

    // Wait for the reply editor to appear in the DOM.
    // YouTube renders asynchronously; an immediate querySelector after click
    // usually finds nothing. Poll with a bounded timeout.
    const POLL_INTERVAL = 150;
    const MAX_TIMEOUT_MS = 3000;
    let elapsed = 0;

    return new Promise(function (resolve) {
      function poll() {
        if (!comment || !comment.element) {
          resolve(null);
          return;
        }

        // Strategy 1: ytd-comment-reply-box-renderer inside the comment thread
        let editor = null;
        try {
          editor = comment.element.querySelector('ytd-comment-reply-box-renderer');
        } catch (_) {}
        if (editor) { resolve(editor); return; }

        // Strategy 2: textbox with id="textbox" inside the reply box
        try {
          const tb = document.querySelector('#reply-container ytd-textbox, #text-box-container ytd-textbox');
          if (tb && comment.element.contains(tb)) { resolve(tb); return; }
        } catch (_) {}

        // Strategy 3: any yt-formatted-string with class "content" inside the reply area
        try {
          const content = document.querySelector('#reply-container .yt-formatted-string.content');
          if (content && comment.element.contains(content)) { resolve(content); return; }
        } catch (_) {}

        elapsed += POLL_INTERVAL;
        if (elapsed >= MAX_TIMEOUT_MS) {
          console.log('[YouTube Auto Reply] openReplyBox: timed out after ' + elapsed + 'ms');
          resolve(null);
          return;
        }
        setTimeout(poll, POLL_INTERVAL);
      }

      poll();
    });
  }

  /**
   * Set the reply text in the reply box.
   *
   * YouTube's editor is a contenteditable / yt-formatted-string — setting .value
   * does nothing. We must focus, clear, insert via execCommand (which fires the
   * input/change events React listens to), and fall back to direct DOM + manual
   * event dispatch if execCommand is unavailable.
   *
   * @param {HTMLElement} replyBox - The reply editor element
   * @param {string} text  - Text to insert
   * @returns {boolean} True on success, false on failure (never throws)
   */
  setReplyText(replyBox, text) {
    if (!replyBox || typeof text !== 'string') {
      console.log('[YouTube Auto Reply] setReplyText: invalid arguments');
      return false;
    }

    try {
      // Focus the editor so YouTube's React layer knows it is active.
      replyBox.focus();

      // Clear any existing content.
      replyBox.textContent = '';

      // Preferred path: document.execCommand('insertText') fires the native
      // input / composition events that React actually listens to.
      if (typeof document.execCommand === 'function') {
        const ok = document.execCommand('insertText', false, text);
        if (ok) return true;
        // execCommand returned false — fall through to manual fallback.
      }

      // Fallback: set textContent and manually dispatch the events React expects.
      replyBox.textContent = text;

      const inputEvent  = new Event('input',  { bubbles: true });
      const changeEvent = new Event('change', { bubbles: true });
      replyBox.dispatchEvent(inputEvent);
      replyBox.dispatchEvent(changeEvent);
    } catch (err) {
      console.warn('[YouTube Auto Reply] setReplyText failed:', err.message);
      return false;
    }

    return true;
  }

  /**
   * Submit the reply from the reply box.
   *
   * HARD REQUIREMENT: if dryRun is true (the default), this method MUST NOT click
   * anything. It logs what it would have submitted and returns false.
   *
   * Reads dryRun directly from chrome.storage.local with a fallback of true so that
   * any storage error defaults to the safe direction — never post without explicit
   * user consent.
   *
   * @param {HTMLElement} replyBox - The reply editor element (used only for logging)
   * @returns {Promise<boolean>} True if submitted, false otherwise (never throws)
   */
  async submitReply(replyBox) {
    // --- dry-run gate ----------------------------------------------------------
    let dryRun = true; // fail-safe: unreadable setting → do not post

    try {
      const result = await chrome.storage.local.get(['dryRun']);
      if (result && typeof result.dryRun === 'boolean') {
        dryRun = result.dryRun;
      }
    } catch (_) {
      // Storage error or rejection → keep dryRun = true. Nothing is posted.
      console.warn('[YouTube Auto Reply] submitReply: could not read dryRun setting, defaulting to dry-run');
    }

    if (dryRun) {
      const textContent = replyBox ? replyBox.textContent : null;
      if (textContent && textContent.trim()) {
        console.info(
          '[YouTube Auto Reply] submitReply: dry-run mode — would have submitted '
            + '"' + textContent.trim().substring(0, 80) + '"'
            + '; click count stays at 0'
        );
      } else {
        console.warn(
          '[YouTube Auto Reply] submitReply: DRY-RUN — reply box appears empty; '
            + 'posting an empty reply would be a bug'
        );
      }
      return false;
    }

    // --- find the Submit button (multi-fallback, same style as existing code) --
    let submitBtn = null;

    try {
      submitBtn = replyBox.querySelector('button[aria-label*="Comment"]');
    } catch (_) {}
    if (!submitBtn) {
      try {
        submitBtn = replyBox.querySelector('#submit-button');
      } catch (_) {}
    }
    if (!submitBtn) {
      try {
        // Last resort: any button whose aria-label or textContent contains "send" / "post"
        const buttons = replyBox.querySelectorAll('button');
        for (const b of buttons) {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const text  = (b.textContent || '').toLowerCase();
          if (label.includes('send') || label.includes('post') ||
              text.includes('send') || text.includes('post')) {
            submitBtn = b;
            break;
          }
        }
      } catch (_) {}
    }

    if (!submitBtn) {
      console.log('[YouTube Auto Reply] submitReply: no submit button found');
      return false;
    }

    try {
      submitBtn.click();
      return true;
    } catch (err) {
      console.warn('[YouTube Auto Reply] submitReply: click failed:', err.message);
      return false;
    }
  }
}

// Selectors are exposed as a static property on the class for cross-script access
YouTubeSiteAdapter.SELECTORS = {
  // Primary selector for comment threads (most common)
  COMMENT_THREAD: 'ytd-comment-thread-renderer',

  // Alternative selectors if primary fails
  COMMENT_LEGACY: '#comment',
  COMMENT_SIMPLE: '.ytd-comment',

  // Comment author line selectors. Current YouTube puts the name directly in
  // an anchor with id "author-text"; older markup wrapped it in a
  // span.author-name. Try both.
  AUTHOR_LINK: '#author-text',
  AUTHOR_LINE: '.author-name',

  // Comment text content selector (yt-formatted-string or #text)
  COMMENT_TEXT: 'ytd-comment-text-renderer',

  // --- Phase 8 reply-UI selectors (YouTube markup drifts; use fallback chains) ---

  // Reply button inside a comment thread:
  //   Strategy A: <button aria-label="Reply">  (most reliable)
  //   Strategy B: element with data-command="reply"
  //   Strategy C: <yt-touch-button aria-label="Reply">
  REPLY_BUTTON_ARIA: 'button[aria-label="Reply"]',
  REPLY_BUTTON_DATA_CMD: '[data-command="reply"]',
  REPLY_TOUCH_BUTTON: 'yt-touch-button[aria-label="Reply"]',

  // Reply editor container (appears after clicking the reply button):
  //   Strategy A: <ytd-comment-reply-box-renderer>
  //   Strategy B: #text-box-container > ytd-textbox
  //   Strategy C: .yt-formatted-string.content inside #reply-container
  REPLY_BOX_RENDERER: 'ytd-comment-reply-box-renderer',
  REPLY_TEXTBOX_CONTAINER: '#text-box-container ytd-textbox',
  REPLY_CONTENT_STRING: '.yt-formatted-string.content',
};

// WeakMap for stable fallback IDs when data-id is missing.
// This ensures the same element always gets the same ID across multiple parse calls,
// enabling proper deduplication via seenIds in content.js.
YouTubeSiteAdapter._fallbackIds = new WeakMap();

// Counter to generate unique fallback IDs (incremented once per new element).
YouTubeSiteAdapter._fallbackCounter = 0;

// Export as globalThis so content.js can use it without ES modules
if (typeof window !== 'undefined') {
  window.YouTubeSiteAdapter = YouTubeSiteAdapter;
}
