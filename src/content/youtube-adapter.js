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

      // Extract author name from author line
      let author = '';
      const authorLine = node.querySelector(YouTubeSiteAdapter.SELECTORS.AUTHOR_LINE);
      if (authorLine) {
        const textNodes = authorLine.querySelectorAll('span');
        for (const span of textNodes) {
          const text = span.textContent.trim();
          if (text && !text.startsWith('[')) { // Skip metadata like [deleted]
            author = text;
            break;
          }
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
   * @param {HTMLElement} replyBox - The reply input element
   * @param {string} text - Text to insert into the reply box
   * @returns {boolean|null} True if successful, or null (Phase 8 not implemented)
   */
  setReplyText(replyBox, text) {
    // Phase 8: Reply UI automation is out of scope for this phase.
    console.log('[YouTube Auto Reply] setReplyText: Not implemented until Phase 8');
    return null;
  }

  /**
   * Submit the reply from the reply box.
   * 
   * @param {HTMLElement} replyBox - The reply input element
   * @returns {boolean|null} True if submission was successful, or null (Phase 8 not implemented)
   */
  submitReply(replyBox) {
    // Phase 8: Reply UI automation is out of scope for this phase.
    console.log('[YouTube Auto Reply] submitReply: Not implemented until Phase 8');
    return null;
  }
}

// Selectors are exposed as a static property on the class for cross-script access
YouTubeSiteAdapter.SELECTORS = {
  // Primary selector for comment threads (most common)
  COMMENT_THREAD: 'ytd-comment-thread-renderer',

  // Alternative selectors if primary fails
  COMMENT_LEGACY: '#comment',
  COMMENT_SIMPLE: '.ytd-comment',

  // Comment author line selector
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
