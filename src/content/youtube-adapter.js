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
   * Selectors that can identify a single comment element, most specific first.
   *
   * COMMENT_THREAD is the usual wrapper. COMMENT_RENDERER is the inner element that
   * actually holds the author and body, so it is a safe second choice: whenever a
   * comment is rendered at all, this element exists too.
   *
   * @returns {string[]} selectors to try, in order
   */
  getCommentSelectors() {
    const S = YouTubeSiteAdapter.SELECTORS;
    return [S.COMMENT_THREAD, S.COMMENT_RENDERER, S.COMMENT_LEGACY, S.COMMENT_SIMPLE];
  }

  /**
   * Whether this element IS a comment, rather than merely containing one.
   *
   * Needed because the MutationObserver hands us every inserted element, including
   * large containers. parseComment() on a container would happily return the text of
   * the first comment inside it under a fabricated fallback id, producing a bogus
   * comment and polluting the seenIds dedup set.
   *
   * @param {HTMLElement} node - candidate element
   * @returns {boolean} true when the node itself is a comment element
   */
  isCommentNode(node) {
    if (!node || typeof node.matches !== 'function') return false;
    return this.getCommentSelectors().some((selector) => {
      try {
        return node.matches(selector);
      } catch (_) {
        return false;
      }
    });
  }

  /**
   * Find all comment nodes in the current document.
   * @returns {Array} Array of comment element nodes
   */
  findCommentNodes() {
    const comments = [];

    // First selector that matches anything wins, so we never return the same
    // comment twice via two different selectors.
    for (const selector of this.getCommentSelectors()) {
      let found = [];
      try {
        found = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        continue;
      }
      if (found.length > 0) {
        for (const element of found) {
          comments.push(element);
        }
        return comments;
      }
    }

    if (comments.length === 0) {
      this._logNoCommentsDiagnostic();
    }

    return comments;
  }

  /**
   * DEBUGGING ONLY. Describe a DOM node compactly for the diagnostic log.
   * Never used for detection.
   *
   * @param {Element} node
   * @returns {string} one-line description
   */
  static _describeNode(node) {
    if (!node) return 'null';
    let out = node.tagName ? node.tagName.toLowerCase() : String(node.nodeName || '?');
    try {
      if (node.id) out += '#' + node.id;
      const cls = node.className && typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 4)
        : [];
      if (cls.length) out += '.' + cls.join('.');
    } catch (_) { /* ignore */ }
    try {
      const data = [];
      for (const attr of Array.from(node.attributes || [])) {
        if (attr.name.indexOf('data-') === 0) data.push(attr.name + '=' + String(attr.value).slice(0, 40));
        if (data.length >= 4) break;
      }
      if (data.length) out += ' [' + data.join(' ') + ']';
    } catch (_) { /* ignore */ }
    return out;
  }

  /**
   * DEBUGGING ONLY. Inspect the real DOM to work out why comment detection found
   * nothing. Uses no assumed YouTube selector: it probes iframes, open shadow roots,
   * and the presence of recognisable comment UI text, then reports what it actually
   * found. One-shot per page load unless `force` is passed, so it can be re-run by
   * hand from the console once comments are on screen.
   *
   * @param {boolean} [force] - log again even if already logged this page load
   * @returns {void}
   */
  _logNoCommentsDiagnostic(force) {
    if (YouTubeSiteAdapter._diagnosticLogged && !force) return;
    YouTubeSiteAdapter._diagnosticLogged = true;

    const sel = YouTubeSiteAdapter.SELECTORS;
    const describe = YouTubeSiteAdapter._describeNode;
    const report = {};

    // 1. Current known selectors, for reference.
    const counts = {};
    for (const selector of this.getCommentSelectors()) {
      try {
        counts[selector] = document.querySelectorAll(selector).length;
      } catch (_) {
        counts[selector] = 'invalid selector';
      }
    }
    report.selectorCounts = counts;
    try {
      report.page = {
        url: String(location.href).slice(0, 140),
        readyState: document.readyState,
        bodyChildren: document.body ? document.body.children.length : -1
      };
    } catch (_) { report.page = 'unavailable'; }

    // 2. Probe iframes. Comments rendered inside a same-origin iframe are invisible
    //    to document.querySelectorAll in this document.
    const iframeFindings = [];
    try {
      const frames = Array.from(document.querySelectorAll('iframe'));
      for (const frame of frames.slice(0, 8)) {
        const entry = {
          src: String(frame.getAttribute('src') || '(none)').slice(0, 120),
          title: String(frame.getAttribute('title') || '').slice(0, 80),
          name: String(frame.getAttribute('name') || '').slice(0, 80),
          id: String(frame.getAttribute('id') || '').slice(0, 80),
          size: (() => {
            try {
              const r = frame.getBoundingClientRect();
              return Math.round(r.width) + 'x' + Math.round(r.height);
            } catch (_) { return '?'; }
          })()
        };
        try {
          const doc = frame.contentDocument;
          if (!doc) {
            entry.reachable = false;
          } else {
            entry.reachable = true;
            entry.selectorHits = {};
            for (const selector of this.getCommentSelectors()) {
              try {
                const n = doc.querySelectorAll(selector).length;
                if (n) entry.selectorHits[selector] = n;
              } catch (_) { /* ignore */ }
            }
            // The frame may be the one actually rendering the comments, so describe
            // ITS structure too rather than only counting our own selectors in it.
            entry.frameUrl = String(doc.location && doc.location.href || '(unknown)').slice(0, 140);
            try {
              const all = Array.from(doc.querySelectorAll('*')).slice(0, 8000);
              entry.frameElementCount = all.length;
              const custom = [];
              for (const el of all) {
                const tag = el.tagName ? el.tagName.toLowerCase() : '';
                if (tag.indexOf('-') !== -1 && custom.indexOf(tag) === -1) {
                  custom.push(tag);
                  if (custom.length >= 60) break;
                }
              }
              entry.frameCustomElementTags = custom;
              // Comment-UI landmarks inside the frame.
              const marks = [];
              for (const el of Array.from(doc.querySelectorAll('button, [aria-label], a')).slice(0, 4000)) {
                const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
                if (label === 'Reply' || /translate to english/i.test(label)) {
                  marks.push(label.slice(0, 40) + ' @ ' + describe(el));
                  if (marks.length >= 3) break;
                }
              }
              entry.frameCommentUiLandmarks = marks;
              // Ancestor walk inside the frame, from the first landmark.
              if (marks.length) {
                const chain = [];
                let cur = null;
                for (const el of Array.from(doc.querySelectorAll('button, [aria-label], a')).slice(0, 4000)) {
                  const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
                  if (label === 'Reply' || /translate to english/i.test(label)) { cur = el; break; }
                }
                for (let i = 0; i < 8 && cur; i++) {
                  chain.push(describe(cur));
                  cur = cur.parentElement;
                }
                entry.frameAncestorChain = chain;
              }
              // A text sample, so a frame can be identified at a glance.
              const body = doc.body;
              entry.frameBodyTextSample = body
                ? String(body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
                : '(no body)';
            } catch (err) {
              entry.frameInspectError = err && err.message;
            }
          }
        } catch (err) {
          entry.reachable = false;
          entry.error = err && err.name;
        }
        iframeFindings.push(entry);
      }
    } catch (_) { /* ignore */ }
    report.iframes = iframeFindings;

    // Frame topology: are we even running in the frame the user is looking at?
    try {
      report.frameTopology = {
        isTopFrame: window.top === window,
        frameCount: (() => { try { return window.frames.length; } catch (_) { return '?'; } })(),
        parentIsTop: (() => { try { return window.parent === window.top; } catch (_) { return '?'; } })()
      };
    } catch (_) { report.frameTopology = 'unavailable'; }

    // 3. Probe open shadow roots, which querySelectorAll cannot cross.
    const shadowFindings = [];
    try {
      const all = Array.from(document.querySelectorAll('*')).slice(0, 6000);
      for (const el of all) {
        let root = null;
        try { root = el.shadowRoot; } catch (_) { root = null; }
        if (!root) continue;
        const entry = { host: describe(el), hits: {} };
        for (const selector of this.getCommentSelectors()) {
          try {
            const n = root.querySelectorAll(selector).length;
            if (n) entry.hits[selector] = n;
          } catch (_) { /* ignore */ }
        }
        shadowFindings.push(entry);
        if (shadowFindings.length >= 5) break;
      }
    } catch (_) { /* ignore */ }
    report.openShadowRoots = shadowFindings;

    // 4. Look for recognisable comment UI, purely as a landmark for the dump.
    //    This is NOT used as a production selector.
    const landmarks = [];
    let landmarkScanTruncated = false;
    try {
      // Scan every candidate rather than the first N. YouTube's document is enormous
      // and the first few thousand buttons all live in the masthead, player and
      // sidebar, so an early cap could never reach the comments.
      const all = Array.from(document.querySelectorAll('button, [aria-label], a'));
      const LANDMARK_SCAN_LIMIT = 60000;
      const scanned = all.length > LANDMARK_SCAN_LIMIT ? all.slice(0, LANDMARK_SCAN_LIMIT) : all;
      landmarkScanTruncated = all.length > LANDMARK_SCAN_LIMIT;
      for (const el of scanned) {
        const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!label) continue;
        if (label === 'Reply' || /translate to english/i.test(label)) {
          landmarks.push({ label: label.slice(0, 60), node: describe(el) });
          if (landmarks.length >= 3) break;
        }
      }
    } catch (_) { /* ignore */ }
    report.commentUiLandmarks = landmarks;
    report.commentUiLandmarkScanTruncated = landmarkScanTruncated;

    // 5. Walk up from a landmark so the surrounding structure is visible.
    const ancestorChains = [];
    try {
      const all = Array.from(document.querySelectorAll('button, [aria-label], a'));
      for (const el of all.slice(0, 60000)) {
        const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
        if (label !== 'Reply' && !/translate to english/i.test(label)) continue;
        const chain = [];
        let cur = el;
        for (let i = 0; i < 8 && cur; i++) {
          chain.push(describe(cur));
          cur = cur.parentElement;
        }
        ancestorChains.push(chain);
        if (ancestorChains.length >= 2) break;
      }
    } catch (_) { /* ignore */ }
    report.ancestorChainsFromCommentUi = ancestorChains;

    // 6. Census of custom element tag names, the most likely place a renamed
    //    comment element would show up.
    //
    //    This previously stopped after 60 distinct tags in DOCUMENT ORDER, which on
    //    YouTube means it never got past the masthead and player and reported a
    //    misleadingly short list. It now scans the whole document, keeps any tag that
    //    looks comment-related, and says explicitly whether it truncated.
    const custom = [];
    const commentRelatedTags = [];
    const commentRelatedClasses = [];
    let totalElements = 0;
    let censusTruncated = false;
    const CENSUS_LIMIT = 1500;
    try {
      const all = Array.from(document.querySelectorAll('*'));
      totalElements = all.length;
      for (const el of all) {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag.indexOf('comment') !== -1 && commentRelatedTags.indexOf(tag) === -1) {
          commentRelatedTags.push(tag);
          if (commentRelatedTags.length >= 80) break;
        }
        try {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (cls && cls.indexOf('comment') !== -1) {
            for (const c of cls.trim().split(/\s+/)) {
              if (c.indexOf('comment') !== -1 && commentRelatedClasses.indexOf(c) === -1) {
                commentRelatedClasses.push(c);
                if (commentRelatedClasses.length >= 60) break;
              }
            }
          }
        } catch (_) { /* ignore */ }
      }
      // Distinct custom tags, now capped much higher and flagged rather than silent.
      for (const el of all.slice(0, CENSUS_LIMIT)) {
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag.indexOf('-') !== -1 && custom.indexOf(tag) === -1) {
          custom.push(tag);
          if (custom.length >= 300) { censusTruncated = true; break; }
        }
      }
    } catch (_) { /* ignore */ }
    report.customElementTags = custom;
    report.customElementTagsTruncated = censusTruncated;
    report.totalElementsInDocument = totalElements;

    // 6b. THE DECISIVE SCAN: any element whose tag name or class mentions "comment".
    //     This is independent of document order and of any assumed YouTube selector,
    //     so it cannot miss the comment section the way an early-capped census did.
    report.commentRelatedTagNames = commentRelatedTags;
    report.commentRelatedClassNames = commentRelatedClasses;

    // 6c. Is the comments panel still loading? YouTube shows a spinner in the
    //     engagement panel until the comment section has been fetched.
    try {
      report.commentsStillLoading = {
        contentLoadingRenderer: document.querySelectorAll('yt-content-loading-renderer').length,
        spinner: document.querySelectorAll('tp-yt-paper-spinner').length,
        commentsPanel: document.querySelectorAll('ytd-engagement-panel-section-list-renderer').length,
        commentsSection: document.querySelectorAll('[target-id="engagement-panel-comments-section"]').length
      };
    } catch (_) { report.commentsStillLoading = 'unavailable'; }

    // 7. State the most likely explanation explicitly.
    // A frame counts as holding the comments if our selectors match inside it, OR if
    // it shows comment UI that our own document does not have at all.
    const inIframe = iframeFindings.some((f) => {
      if (!f.reachable) return false;
      if (f.selectorHits && Object.keys(f.selectorHits).length > 0) return true;
      return landmarks.length === 0 &&
        Array.isArray(f.frameCommentUiLandmarks) && f.frameCommentUiLandmarks.length > 0;
    });
    const inShadow = shadowFindings.some((s) => s.hits && Object.keys(s.hits).length > 0);
    // Did YouTube actually build any comment UI or custom elements at all?
    // Used only to phrase the verdict, never for detection.
    const looksRendered = landmarks.length > 0 ||
      custom.some((tag) => tag.indexOf('ytd-') === 0 || tag.indexOf('yt-') === 0);

    // A visible spinner in the engagement panel means the comments have not arrived yet,
    // which fully explains every selector returning zero.
    let commentsLoading = false;
    try {
      const loading = report.commentsStillLoading;
      commentsLoading = !!(
        loading &&
        loading.contentLoadingRenderer > 0 &&
        commentRelatedTags.length === 0
      );
    } catch (_) { commentsLoading = false; }

    let diagnosis;
    if (inIframe) {
      diagnosis = 'COMMENTS ARE INSIDE AN IFRAME — document-level selectors cannot see them. ' +
        'Look at iframes[].frameCustomElementTags and iframes[].frameAncestorChain. ' +
        'The content script is not injected into frames unless the manifest sets all_frames.';
    } else if (inShadow) {
      diagnosis = 'COMMENTS ARE INSIDE AN OPEN SHADOW ROOT — document-level selectors cannot cross it.';
    } else if (landmarks.length > 0 || commentRelatedTags.length > 0) {
      diagnosis = 'COMMENTS EXIST BUT OUR SELECTORS DO NOT MATCH them. ' +
        'See commentRelatedTagNames and ancestorChainsFromCommentUi for the real structure.';
    } else if (commentsLoading) {
      diagnosis = 'THE COMMENTS PANEL IS STILL LOADING — YouTube has not rendered the comments yet. ' +
        'Wait for the comment count to appear, then dispatch the diagnose event again.';
    } else if (!looksRendered) {
      // No comment UI and no YouTube custom elements at all means the comment section
      // genuinely has not been built yet, so any selector would come back empty.
      diagnosis = 'COMMENTS HAVE NOT BEEN RENDERED YET — no comment UI and no YouTube ' +
        'custom elements were present. Scroll to the comments, then force a re-run with: ' +
        'new YouTubeSiteAdapter()._logNoCommentsDiagnostic(true)';
    } else {
      diagnosis = 'COMMENTS ARE PRESENT IN THE DOM BUT NOT DISCOVERABLE by the current search, ' +
        'and no comment UI landmark was recognised. Inspect customElementTags.';
    }

    console.warn(
      '[YouTube Auto Reply] DIAGNOSTIC (debug only): ' +
      'diagnosis=' + diagnosis + ' report=' + JSON.stringify(report, null, 1)
    );
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

  // The inner renderer that holds the author and body. Present whenever a comment
  // exists, so it is the safe second choice if threads are wrapped unexpectedly.
  COMMENT_RENDERER: 'ytd-comment-renderer',

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

// Guards the one-shot "no comments found" diagnostic so it can only log once per
// page load, and only when detection genuinely came up empty.
YouTubeSiteAdapter._diagnosticLogged = false;

// Export as globalThis so content.js can use it without ES modules
if (typeof window !== 'undefined') {
  window.YouTubeSiteAdapter = YouTubeSiteAdapter;
}
