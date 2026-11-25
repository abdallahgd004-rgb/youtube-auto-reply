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
    return [S.COMMENT_THREAD, S.COMMENT_VIEW_MODEL, S.COMMENT_RENDERER, S.COMMENT_LEGACY, S.COMMENT_SIMPLE];
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
   * Whether this comment was written by the CHANNEL OWNER — i.e. by us.
   *
   * THE LOOP THIS PREVENTS. Every reply the extension posts renders in the page as an
   * ordinary comment. Without this check the MutationObserver reports it as a new customer
   * comment, the pipeline answers it, and the extension replies to its own reply — observed
   * in real Chrome on 2026-10-09, three replies deep on a single thread.
   *
   * TWO MARKERS, because a markup change must not silently restore the loop:
   *   - `owner-text` on the author element — the class YouTube applies to the channel
   *     owner's own comments.
   *   - an owner badge anywhere in the comment's metadata.
   *
   * FAILING OPEN IS DELIBERATE AND IS THE DANGEROUS DIRECTION, so it is called out: an
   * unreadable markup means we DO NOT skip, and the loop is back. That is why content.js
   * also keeps a markup-independent backstop — the text of every reply we posted this
   * session — and why a comment skipped for either reason is counted and logged rather than
   * dropped in silence.
   *
   * @param {HTMLElement} node - a comment element
   * @returns {boolean} true when the node is the channel owner's own comment
   */
  isOwnComment(node) {
    if (!node || typeof node.querySelector !== 'function') return false;
    try {
      const S = YouTubeSiteAdapter.SELECTORS;
      const root = YouTubeSiteAdapter._ownCommentRoot(node, S) || node;
      const author = root.querySelector('#author-text, .author-name');
      if (author && author.classList.contains(S.OWNER_AUTHOR_CLASS)) {
        return true;
      }
      // Check author badge in this comment's metadata (excluding nested replies)
      const meta = root.querySelector('#meta, #header-author, .author-line') || root;
      return !!meta.querySelector(
        '#author-badge, .owner-badge, ytd-author-comment-badge-renderer, ytd-author-badge-renderer, [class*="owner-badge"]'
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether the CHANNEL OWNER has hearted ("liked by creator") THIS comment.
   *
   * WHAT A HEART IS, AND WHY IT IS AN ELEMENT RATHER THAN AN ATTRIBUTE. YouTube renders the
   * creator heart as a Polymer element, `ytd-creator-heart-renderer`, whose state is carried
   * by which child icon it renders: `#hearted` (the filled red heart, over the creator's
   * `#hearted-thumbnail` avatar) when hearted, `#unhearted` (a plain outline) when not.
   *
   * THE CONTAINER'S PRESENCE IS NOT THE STATE, and getting that wrong mutes the whole
   * channel rather than one comment. In the owner's own session YouTube renders the
   * container for EVERY comment they can heart, so a presence check reports hearted on all of
   * them and the extension excludes every comment on the page — with no error, no log line
   * and a side panel reading zero of everything. This was live: the feature shipped matching
   * the container, and the only reason external evidence looked clean is that a LOGGED-OUT
   * session renders no containers at all. See SELECTORS.CREATOR_HEART_ON.
   *
   * The attribute that is widely believed to exist — `ytd-comment-renderer[creator-heart]` —
   * DOES NOT. So do `data-is-owner` and `author-is-channel-owner`: both were 2016-era markup.
   * Searching public code indexes for each of those returns nothing, while the same search
   * for `ytd-creator-heart-renderer` returns several actively-maintained userscripts and
   * userstyles that colour it red. There is no `creator-heart=""` to test for, and the
   * hearted state is not an attribute either — it is a `dom-if` on Polymer data, so it can
   * only be read from the DOM.
   *
   * WHAT IS DELIBERATELY NOT USED:
   *   - the tooltip text, which is "❤ by <channel>" and is LOCALISED, so string-matching it
   *     would fail outright on an Arabic or German page;
   *   - `#creator-heart-button`. An earlier draft ruled this out on the belief that it belongs
   *     to a different surface entirely, and that was wrong: it is the button WRAPPER inside
   *     `ytd-creator-heart-renderer`, and it is present on every comment the owner can heart
   *     whether or not it is hearted. A visibility test on it therefore means "the owner is
   *     logged in", not "hearted" — which is exactly the mistake this method already made once;
   *   - the parent toolbar, which is mid-migration: `ytd-comment-action-buttons-renderer` is
   *     being replaced by `ytd-comment-engagement-bar` (this file's own real-Chrome notes at
   *     parseComment already record the new bar). Matching the heart by its own tag never
   *     names the parent, so it survives that swap.
   *
   * THE SCOPING IS THE PART THAT IS EASY TO GET WRONG. The node handed to us is a
   * `ytd-comment-thread-renderer`, which CONTAINS its replies, so the obvious
   * `thread.querySelector('ytd-creator-heart-renderer')` is the thread-level `:has()` trap: it
   * answers "is anything in this thread hearted", which is true when a REPLY — often the
   * creator's own hearted reply to someone else — is hearted, and that would silence the parent
   * for a mark the parent never received. Two wrong ways in, both tried and rejected:
   *
   *   - searching the thread, which blames the parent for a reply's heart;
   *   - resolving the parent's view model and searching inside it, which is NOT sufficient,
   *     because the replies renderer is a CHILD of the view model — a reply's heart is still
   *     a descendant, and a search of the parent finds it. That correction is easy to get
   *     wrong in the other direction too, by rejecting anything inside the replies wrapper,
   *     which re-breaks the moment YouTube renames that wrapper.
   *
   * WHAT IS ACTUALLY ASKED IS "WHOSE HEART IS THIS", not "is this inside something called
   * replies": a heart is accepted only when the NEAREST comment enclosing it is this comment.
   * That is one `closest()` call, it is immune to every wrapper name, and it is the version
   * the mutation tests in creator-heart-tests.js pin — a toolbar-scoped variant was written
   * first and deleted, because mutating its removal changed nothing.
   *
   * FAILING OPEN IS DELIBERATE, and the direction matters: if the markup cannot be read we do
   * NOT skip, and the comment is processed normally. That is correct here even though it is
   * the opposite of `isOwnComment`'s trade-off — a missed heart costs a reply to a comment the
   * creator liked, whereas a false positive silently mutes comments the creator never saw.
   * The cost of the feature silently not working is covered by counting and logging the skip.
   *
   * @param {HTMLElement} node - a comment element (thread, view model, or legacy root)
   * @returns {boolean} true only when this comment's own heart is CONFIRMED ON. A container
   *   that is present but shows `#unhearted`, or whose state cannot be read, is false.
   */
  /**
   * Heart a comment by clicking YouTube's OWN heart control, in the creator's session.
   *
   * Phase 23.1. This is the only method in the adapter that acts on the page on the
   * creator's behalf without publishing anything, and it is deliberately as narrow as
   * that allows: one click, on the real control, scoped to the one comment.
   *
   * WHY A REAL `.click()` AND NOT A SYNTHETIC EVENT: the same reason `expandReplies()`
   * does it (Phase 22). YouTube's Polymer components respond to a real trusted click;
   * a `dispatchEvent(new MouseEvent(...))` does not drive the component's tap handler,
   * so the heart would appear to succeed and change nothing. Verified by clicking.
   *
   * WHY `#creator-heart-button`: it is the button wrapper YouTube renders INSIDE
   * `ytd-creator-heart-renderer`, and it is present in BOTH states — it is not the
   * signal that something is hearted, but it IS the thing to press. The state is read
   * separately (see below), which is why this method cannot use it as an answer to
   * "is this already hearted".
   *
   * THE ALREADY-HEARTED CASE IS A NO-OP, NOT A TOGGLE-OFF. `#creator-heart-button` is
   * the same control in both states, so clicking it on an already-hearted comment would
   * REMOVE the creator's heart. That is the single most damaging thing this method could
   * do — silently undoing a deliberate act by the user — so it is checked first and
   * returns without clicking. In practice the Phase 23 filter already skipped these
   * comments before any reply was drafted; this guard is what makes that filter's
   * correctness load-bearing rather than merely convenient.
   *
   * FAIL OPEN, consistently with `isHeartedComment()`: a missing container, a missing
   * button, or a thrown click returns false and leaves the page untouched. A failed
   * heart costs a cosmetic detail on a comment the creator is looking at; a wrong one
   * acts on their account. This method NEVER throws for the same reason.
   *
   * @param {HTMLElement} node - a comment element (thread, view model, or legacy root)
   * @returns {boolean} true only when the control was found and clicked
   */
  heartComment(node) {
    const root = (node && node.element && typeof node.element.querySelector === 'function')
      ? node.element
      : node;
    if (!root || typeof root.querySelector !== 'function') return false;
    try {
      const S = YouTubeSiteAdapter.SELECTORS;

      // Never un-heart. See above — this guard is the difference between an idempotent
      // method and one that can undo the user.
      if (this.isHeartedComment(root)) return false;

      const viewModel = YouTubeSiteAdapter._ownCommentRoot(root, S);
      if (!viewModel) return false;

      const hearts = viewModel.querySelectorAll(S.CREATOR_HEART);
      for (const heart of hearts) {
        // Same ownership rule as `isHeartedComment()`: a reply's heart sits under the
        // PARENT comment too, so pressing the wrong one is possible if this is skipped.
        // One `closest()`, identical to the read path, so the two can never disagree
        // about whose heart is whose.
        const owner = heart.closest && (heart.closest(S.COMMENT_VIEW_MODEL) || heart.closest(S.COMMENT_RENDERER));
        if (owner && owner !== viewModel) continue;

        let button = heart.querySelector(S.CREATOR_HEART_BUTTON);
        if (!button) {
          button = heart.querySelector('button, [role="button"], yt-icon-button');
        }
        if (!button) return false;

        const targetBtn = (button.querySelector && button.querySelector('button')) ||
          (button.shadowRoot && button.shadowRoot.querySelector('button')) ||
          button;
        targetBtn.click();
        __YTAR_DEBUG.debugLog('heartComment: clicked the creator heart control');
        return true;
      }
      return false;
    } catch (error) {
      // Deliberately swallowed: this runs after a reply draft was already inserted, and
      // throwing here would discard that draft and report the whole comment as failed.
      __YTAR_DEBUG.debugWarn('heartComment: could not heart the comment:', error && error.message);
      return false;
    }
  }

  isHeartedComment(node) {
    const root = (node && node.element && typeof node.element.querySelector === 'function')
      ? node.element
      : node;
    if (!root || typeof root.querySelector !== 'function') return false;
    try {
      const S = YouTubeSiteAdapter.SELECTORS;
      const viewModel = YouTubeSiteAdapter._ownCommentRoot(root, S);
      if (!viewModel) return false;

      const hearts = viewModel.querySelectorAll(S.CREATOR_HEART);
      for (const heart of hearts) {
        // WHOSE heart is this — identity, not ancestry by name. A reply's heart sits under
        // the PARENT comment too, so "is it inside us" is the wrong question; "is the nearest
        // comment enclosing it us" cannot be answered wrongly by a sibling or a renamed
        // wrapper. One `closest()` call, immune to every wrapper name.
        const owner = heart.closest && (heart.closest(S.COMMENT_VIEW_MODEL) || heart.closest(S.COMMENT_RENDERER));
        if (owner && owner !== viewModel) continue;

        // THE ACTUAL STATE, which the container's presence does not carry. The outline is the
        // positive proof of NOT being hearted, so it is checked first: a comment the owner can
        // heart but has not hearted renders the container with `#unhearted` inside it, and
        // treating that container as a heart is what muted this whole channel.
        if (heart.querySelector(S.CREATOR_HEART_OFF)) continue;
        if (heart.querySelector(S.CREATOR_HEART_ON)) return true;

        // A container with neither child is an UNREADABLE state, not a heart. Fail open: an
        // unknown must be processed normally, and this is the direction that costs the least.
        return false;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether this comment thread already carries a reply from the channel owner.
   *
   * Handles both expanded threads and COLLAPSED threads:
   * 1. In collapsed threads, YouTube renders a teaser thumbnail/avatar of the creator
   *    (`ytd-comment-replies-renderer #creator-thumbnail`, `#teaser-avatar`, or an avatar
   *    element inside the expander button) or an aria-label indicating a creator reply.
   * 2. In expanded threads, checks author badges, owner classes, creator indicators, and
   *    `isOwnComment` across all reply models (`ytd-comment-view-model` and `ytd-comment-renderer`).
   *
   * @param {HTMLElement} node - a comment element (thread, view model, or renderer)
   * @returns {boolean} true only when an owner reply is confirmed present in the thread
   */
  hasCreatorReply(node) {
    const root = (node && node.element && typeof node.element.querySelector === 'function')
      ? node.element
      : node;
    if (!root || typeof root.querySelector !== 'function') return false;
    try {
      const S = YouTubeSiteAdapter.SELECTORS;
      const thread = (root.closest && root.closest(S.COMMENT_THREAD)) ||
        (root.closest && root.closest(S.COMMENT_RENDERER)) ||
        root.parentElement ||
        root;
      if (!thread || typeof thread.querySelector !== 'function') return false;

      let repliesRoot = thread.querySelector(S.REPLIES_RENDERER);
      if (!repliesRoot && thread.parentElement) {
        repliesRoot = thread.parentElement.querySelector(S.REPLIES_RENDERER);
      }
      if (!repliesRoot) return false;

      // 1. Direct creator thumbnail / teaser in repliesRoot (standard on collapsed threads)
      const creatorThumbnailSelector = [
        '#creator-thumbnail',
        '[id*="creator-thumbnail"]',
        '.creator-thumbnail',
        '[class*="creator-thumbnail"]',
        '#teaser-avatar',
        '[id*="teaser-avatar"]',
        '[creator]',
        '[is-creator]',
        '#author-comment-badge.creator',
        '[class*="author-comment-badge"][class*="creator"]',
        'ytd-author-comment-badge-renderer'
      ].join(', ');

      if (repliesRoot.querySelector(creatorThumbnailSelector)) return true;

      // 2. Avatar element inside the expander button (e.g. "#expander", "#more-replies")
      // In YouTube's design, the collapsed expander button ("• 1 reply") ONLY renders an avatar
      // thumbnail when the creator has replied in that thread.
      const expander = repliesRoot.querySelector(
        '#expander, #more-replies, ytd-button-renderer, yt-button-shape, button'
      );
      if (expander) {
        const expanderAvatar = expander.querySelector(
          'yt-img-shadow, yt-avatar-shape, img, [class*="avatar"], [id*="avatar"], [class*="thumbnail"], [id*="thumbnail"]'
        );
        if (expanderAvatar) return true;

        const label = (
          (expander.getAttribute && (expander.getAttribute('aria-label') || expander.getAttribute('title'))) ||
          expander.textContent ||
          ''
        ).toLowerCase();
        if (
          label.includes('reply from') ||
          label.includes('replies from') ||
          label.includes('رد من') ||
          label.includes('ردود من') ||
          label.includes('creator') ||
          label.includes('owner') ||
          label.includes('المالك') ||
          label.includes('منشئ المحتوى') ||
          label.includes('صاحب القناة')
        ) {
          return true;
        }
      }

      // 3. Direct owner author class / badge check inside repliesRoot
      const ownerSelector = [
        '.' + S.OWNER_AUTHOR_CLASS,
        '#author-badge',
        '.owner-badge',
        'ytd-author-badge-renderer',
        'ytd-author-comment-badge-renderer',
        '[class*="owner-badge"]',
        'ytd-comment-renderer[creator]',
        'ytd-comment-view-model[creator]'
      ].join(', ');

      const ownerBadge = repliesRoot.querySelector(ownerSelector);
      if (ownerBadge) return true;

      // 4. Check all reply nodes inside repliesRoot (both view-models and comment-renderers)
      const replyNodes = repliesRoot.querySelectorAll(
        S.COMMENT_VIEW_MODEL + ', ' +
        S.COMMENT_RENDERER + ', ' +
        '.ytd-comment, #comment'
      );
      for (const replyNode of replyNodes) {
        if (this.isOwnComment(replyNode)) return true;
      }

      // 5. Read thread replies using existing readThreadReplies method
      const replies = this.readThreadReplies(thread);
      if (Array.isArray(replies) && replies.some((r) => r && r.isOwner === true)) {
        return true;
      }

      return false;
    } catch (_) {
      return false;
    }
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
      __YTAR_DEBUG.debugLog('No comment nodes matched the known selectors');
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
      let id = (node.getAttribute && node.getAttribute('data-id')) || '';
      if (!id && typeof node.querySelector === 'function') {
        try {
          const S = YouTubeSiteAdapter.SELECTORS;
          const vm = (node.matches && node.matches(S.COMMENT_VIEW_MODEL))
            ? node
            : node.querySelector(S.COMMENT_VIEW_MODEL);
          if (vm && vm.getAttribute) {
            id = vm.getAttribute('data-id') || '';
          }
        } catch (_) {}
      }

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
      //
      // Real-Chrome evidence (comments fully rendered on youtube.com): the old
      // `ytd-comment-text-renderer` element no longer exists. A rendered comment is:
      //
      //   ytd-comment-thread-renderer
      //     └─ ytd-comment-view-model#comment
      //          ├─ #meta                     (author + timestamp)
      //          ├─ div#body                  ← the comment body text lives here
      //          ├─ ytd-comment-engagement-bar#action-buttons
      //          └─ ytd-comment-replies-renderer
      //
      // Because the body lives in `div#body`, which is a sibling of #meta and the
      // engagement bar / replies, scoping to it naturally excludes the author line,
      // like counts and the Reply button.
      let text = '';
      const S = YouTubeSiteAdapter.SELECTORS;

      // The comment node is normally the thread, but the adapter can also be handed
      // the view model itself (the '#comment' fallback selector targets it directly),
      // so accept either as the view model root.
      let viewModel = null;
      try {
        viewModel = (node.matches && node.matches(S.COMMENT_VIEW_MODEL))
          ? node
          : node.querySelector(S.COMMENT_VIEW_MODEL);
      } catch (_) {
        viewModel = null;
      }

      if (viewModel) {
        const body = viewModel.querySelector(S.COMMENT_BODY);
        if (body) {
          // Prefer the innermost text element so the body is isolated from any
          // sibling control that might sit inside #body (e.g. a translate button).
          for (const holderSelector of [S.TEXT_HOLDER_ATTRIBUTED, S.TEXT_HOLDER_FORMATTED]) {
            const holder = body.querySelector(holderSelector);
            if (!holder) continue;
            const holderText = (holder.textContent || '').trim();
            if (holderText && !holderText.startsWith('[')) {
              text = holderText;
              break;
            }
          }
          // Fall back to the body's own text when no inner text element is present.
          if (!text) {
            const bodyText = (body.textContent || '').trim();
            if (bodyText && !bodyText.startsWith('[')) {
              text = bodyText;
            }
          }
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
        // The creator heart, stamped from the SAME predicate the gate consults.
        //
        // Stamping it here rather than threading a second value out of `acceptNode()` is what
        // keeps there being one answer to "is this comment hearted": the gate and the wire
        // flag are two reads of one function, so they cannot disagree. The gate already
        // dropped hearted comments, so this is `false` on everything that reaches it — it
        // travels to the worker purely so a page that somehow got past the gate cannot make
        // the pipeline spend a model call on a comment the creator hearted.
        hearted: this.isHeartedComment(node),
        creatorReplied: this.hasCreatorReply(node),
        element: node
      };
    } catch (error) {
      __YTAR_DEBUG.logError('Error parsing comment:', error.message);
      return null;
    }
  }

  /**
   * Whether a comment's DOM element is still attached to the live document (Task 13.5).
   *
   * YouTube is a single-page app: navigating, collapsing the comments panel or a soft
   * re-render replaces comment nodes without a page load. A `comment.element` captured
   * earlier can therefore point at a detached node, and every query on it silently
   * returns nothing — which used to look like "no reply button found".
   *
   * @param {Object} comment - A parsed comment (needs .element)
   * @returns {boolean} true when the element is gone (or was never usable)
   */
  isCommentDetached(comment) {
    const el = comment && comment.element;
    if (!el || typeof el.isConnected !== 'boolean') return true;
    return !el.isConnected;
  }

  /**
   * Re-find a comment's live DOM element after YouTube replaced it (Task 13.5).
   *
   * Tried in order:
   *   1. `data-id` — the identifier parseComment used, when one exists.
   *   2. `content-id` — read from the ORIGINAL element. A detached node still carries
   *      its attributes, so this works even though the node is no longer in the page.
   *      This matters because real YouTube threads usually have no `data-id`, so the
   *      ids this project generates are the fallback `comment-N` form.
   *   3. author + text — a last resort that needs no attribute at all.
   *
   * Returns a NEW comment object with the refreshed element and re-parsed fields, or
   * null when the comment is no longer on the page. It never throws.
   *
   * @param {Object} comment - The original parsed comment
   * @returns {Object|null} refreshed comment, or null when it cannot be found
   */
  reacquireComment(comment) {
    if (!comment) return null;

    const wantedId = String(comment.id || '');
    let element = null;

    // 1. Exact `data-id` match (skipped for generated fallback ids, which never exist
    //    in the DOM and would select nothing).
    if (wantedId && wantedId.indexOf('comment-') !== 0) {
      element = this._queryByAttr('ytd-comment-thread-renderer', 'data-id', wantedId);
      if (!element) element = this._queryByAttr('ytd-comment-view-model', 'data-id', wantedId);
    }

    // 2. `content-id` carried by the original (possibly detached) element.
    if (!element && comment.element) {
      let contentId = '';
      try {
        contentId = comment.element.getAttribute('content-id') || '';
      } catch (_) {
        contentId = '';
      }
      if (contentId) {
        element = this._queryByAttr('ytd-comment-view-model', 'content-id', contentId);
        if (!element) element = this._queryByAttr('ytd-comment-thread-renderer', 'content-id', contentId);
      }
    }

    // 3. Author + text match across every live comment node.
    if (!element && (comment.author || comment.text)) {
      try {
        const selectors = [
          YouTubeSiteAdapter.SELECTORS.COMMENT_THREAD,
          YouTubeSiteAdapter.SELECTORS.COMMENT_VIEW_MODEL,
          YouTubeSiteAdapter.SELECTORS.COMMENT_RENDERER
        ].filter(Boolean).join(', ');
        const live = Array.from(document.querySelectorAll(selectors));
        for (const candidate of live) {
          const parsed = this.parseComment(candidate);
          if (!parsed) continue;
          const sameAuthor = Boolean(comment.author && String(parsed.author || '').trim() === String(comment.author).trim());
          const rawEqual = this._collapse(parsed.text) === this._collapse(comment.text);
          let normEqual = false;
          if (!rawEqual && typeof normalizeArabic === 'function') {
            try {
              const norm1 = normalizeArabic(parsed.text);
              const norm2 = normalizeArabic(comment.text);
              normEqual = Boolean(norm1 && norm2 && norm1 === norm2);
            } catch (_) {}
          }
          if (sameAuthor && (rawEqual || normEqual)) {
            element = candidate;
            break;
          }
        }
      } catch (_) {
        element = null;
      }
    }

    if (!element) {
      __YTAR_DEBUG.debugWarn('reacquireComment: comment ' + wantedId + ' is no longer on the page');
      return null;
    }

    // Re-parse from the live node so id/author/text reflect what is on screen now.
    const reparsed = this.parseComment(element);
    if (!reparsed) {
      __YTAR_DEBUG.debugWarn('reacquireComment: found the element for ' + wantedId + ' but could not parse it');
      return null;
    }
    return reparsed;
  }

  /**
   * Query one tag by one attribute value, tolerating quotes and missing CSS.escape.
   * @param {string} tag
   * @param {string} attr
   * @param {string} value
   * @returns {Element|null}
   */
  _queryByAttr(tag, attr, value) {
    const raw = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let selector = `${tag}[${attr}="${raw}"]`;
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        selector = `${tag}[${attr}="${CSS.escape(String(value))}"]`;
      }
      return document.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  /**
   * Whitespace-insensitive text compare used when re-finding a comment by content.
   * @param {*} value
   * @returns {string}
   */
  _collapse(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Find the reply button for a given comment.
   *
   * @param {Object} comment - Parsed comment object with element property
   * @returns {HTMLElement|null} The reply button element or null
   */
  findReplyButton(comment) {
    if (!comment || !comment.element) {
      __YTAR_DEBUG.debugLog('findReplyButton: no valid comment');
      return null;
    }

    const el = comment.element;
    let btn = null;

    // Strategy 1: button with aria-label "Reply" or Arabic "رد" inside the comment thread
    try {
      btn = el.querySelector('button[aria-label="Reply"], button[aria-label="رد"], button[aria-label="ردّ"]');
    } catch (_) {}
    if (btn) return btn;

    // Helper: match "Reply" / "رد" / "ردّ" without matching "replies" / "ردود" (View replies).
    const isReplyLabel = (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s) return false;
      if (s === 'reply' || s === 'رد' || s === 'ردّ') return true;
      if (s.includes('replies') || s.includes('ردود')) return false;
      return /\breply\b/.test(s) || /(?:^|\s)ردّ?(?:\s|$)/.test(s);
    };

    // Strategy 1b: button with aria-label containing "Reply" or "رد" (e.g. "Reply to @...", "رد على التعليق")
    try {
      const candidates = el.querySelectorAll('button[aria-label*="Reply" i], button[aria-label*="رد" i]');
      for (const b of candidates) {
        if (isReplyLabel(b.getAttribute && b.getAttribute('aria-label'))) {
          return b;
        }
      }
    } catch (_) {}

    // Strategy 2: element with data-command="reply"
    try {
      btn = el.querySelector('[data-command="reply"]');
    } catch (_) {}
    if (btn) return btn;

    // Strategy 3: yt-touch-button wrapper containing a tp-yt-paper-icon-button
    try {
      const touchBtns = el.querySelectorAll('yt-touch-button[aria-label="Reply"], yt-touch-button[aria-label*="رد"]');
      for (const touchBtn of touchBtns) {
        if (isReplyLabel(touchBtn.getAttribute && touchBtn.getAttribute('aria-label'))) {
          return touchBtn;
        }
      }
    } catch (_) {}

    // Strategy 4: any button whose textContent or aria-label is "reply", "رد", or "ردّ"
    try {
      const buttons = el.querySelectorAll('button, [role="button"], ytd-button-renderer');
      for (const b of buttons) {
        const text = (b.textContent || '').trim();
        const aria = (b.getAttribute && b.getAttribute('aria-label')) || '';
        if (isReplyLabel(text) || isReplyLabel(aria)) {
          return (b.querySelector && b.querySelector('button')) || b;
        }
      }
    } catch (_) {}

    // Strategy 5: check wider thread container if el was a child node
    try {
      const thread = (el.closest && (el.closest('ytd-comment-thread-renderer') || el.closest('ytd-comment-view-model'))) || el.parentElement;
      if (thread && thread !== el) {
        const actionButtons = thread.querySelector('#action-buttons, ytd-comment-engagement-bar');
        if (actionButtons) {
          const threadBtns = actionButtons.querySelectorAll('button, [role="button"]');
          for (const b of threadBtns) {
            const text = (b.textContent || '').trim();
            const aria = (b.getAttribute && b.getAttribute('aria-label')) || '';
            if (isReplyLabel(text) || isReplyLabel(aria)) {
              return (b.querySelector && b.querySelector('button')) || b;
            }
          }
        }
      }
    } catch (_) {}

    __YTAR_DEBUG.debugLog('findReplyButton: no reply button found');
    return null;
  }

  /**
   * The element openReplyBox() should search for the reply box inside.
   *
   * WHY THIS EXISTS (real-Chrome evidence, second failure after the re-acquire fix):
   * the reply box was visibly open in the thread — editable area + Cancel + Reply on
   * screen — and openReplyBox() still returned null after the full 3000 ms.
   *
   * The cause is that `comment.element` is not reliably the THREAD. parseComment()
   * hands over whatever matched, and reacquireComment() step 2 deliberately prefers
   * `ytd-comment-view-model` over `ytd-comment-thread-renderer` (both carry
   * content-id, and the view model is tried first). Real threads carry no data-id, so
   * the ids in play are generated `comment-N` fallbacks, step 1 is skipped, and step 2
   * is what decides. The result is the NARROW view model.
   *
   * The reply box is a SIBLING of the view model, sitting directly under the thread —
   * so a query scoped to the view model cannot see it, no matter how long it polls.
   * Strategy 1 looks for `ytd-comment-reply-box-renderer` inside that dead scope, and
   * Strategies 2/3 are gated on the same scope, so all three fail at once while the UI
   * is plainly on screen.
   *
   * So the fix is to widen the scope back up to the enclosing thread renderer. Nothing
   * else about the strategies changes.
   *
   * @param {Object} comment - parsed comment (needs .element)
   * @returns {HTMLElement|null} the widest usable container for the reply box
   */
  _replySearchScope(comment) {
    const el = comment && comment.element;
    if (!el) return null;

    // Widest case: we already hold the thread, or something above it.
    let node = el;
    try {
      while (node && node.parentElement) {
        const parent = node.parentElement;
        if (
          parent.tagName === 'YTD-COMMENT-THREAD-RENDERER' ||
          parent.tagName === 'YTD-COMMENT-RENDERER' ||
          parent.tagName === 'YTD-COMMENT-VIEW-MODEL'
        ) {
          // Keep climbing: the thread is the outermost of these three.
          node = parent;
          continue;
        }
        break;
      }
    } catch (_) {
      return el;
    }

    // If we ended up on a view model / comment renderer, step out to its thread.
    try {
      if (node.tagName === 'YTD-COMMENT-VIEW-MODEL' || node.tagName === 'YTD-COMMENT-RENDERER') {
        const thread = node.closest && node.closest('ytd-comment-thread-renderer');
        if (thread) return thread;
      }
    } catch (_) {
      return node;
    }

    return node;
  }

  /**
   * TEMPORARY DIAGNOSTIC — dump the real DOM of the open reply box.
   *
   * WHY: two successive openReplyBox fixes were written from INFERRED YouTube markup
   * and both failed in real Chrome, where the reply box is visibly open on screen. No
   * captured DOM of the real reply box exists in this repo. This records what is
   * actually there, so the next fix is based on evidence rather than a guess.
   *
   * Called ONLY on the timeout path, immediately before resolve(null). It is strictly
   * read-only: it observes and logs, never mutates the DOM and never returns a value
   * into the detection logic. Safe to delete in one edit once the structure is known.
   *
   * Assumes NO YouTube selector. It anchors on what the screenshot proves is on
   * screen — a visible editable area plus Reply/Cancel controls — and walks outward
   * from there, so it stays useful even if every tag name we guessed is wrong.
   *
   * @param {Object} comment - the comment being replied to
   * @param {HTMLElement} scope - the element openReplyBox was searching
   * @returns {void}
   */
  _logReplyBoxDiagnostic(comment, scope) {
    // One-shot per page load so a queue of replies does not flood the console.
    if (YouTubeSiteAdapter._replyDiagLogged) return;
    YouTubeSiteAdapter._replyDiagLogged = true;

    const report = {};
    const MAX_DESCENDANTS = 40;
    const MAX_ANCESTORS = 25;
    const MAX_TEXT = 80;

    /** Compact one-line description of a node, for at-a-glance reading. */
    const describe = (node) => {
      if (!node) return 'null';
      let out = node.tagName ? String(node.tagName).toLowerCase() : String(node.nodeName || '?');
      try {
        if (node.id) out += '#' + node.id;
        const cls = typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
          : [];
        if (cls.length) out += '.' + cls.join('.');
      } catch (_) { /* ignore */ }
      try {
        if (node.getAttribute('contenteditable') !== null) {
          out += '[contenteditable=' + node.getAttribute('contenteditable') + ']';
        }
        if (node.getAttribute('role')) out += '[role=' + node.getAttribute('role') + ']';
      } catch (_) { /* ignore */ }
      return out;
    };

    /** id / class / data-* attributes, for identifying the element precisely. */
    const attrsOf = (node) => {
      const out = {};
      if (!node) return out;
      try {
        out.id = node.id || '';
        out.class = typeof node.className === 'string' ? node.className.trim().slice(0, 160) : '';
        const data = [];
        for (const attr of Array.from(node.attributes || [])) {
          if (attr.name.indexOf('data-') === 0) data.push(attr.name + '=' + String(attr.value).slice(0, 60));
          if (data.length >= 8) break;
        }
        if (data.length) out['data-*'] = data;
      } catch (_) { /* ignore */ }
      return out;
    };

    /** Ancestor chain from `node` upward, stopping at the comment thread. */
    const ancestorChain = (node) => {
      const chain = [];
      let cur = node;
      for (let i = 0; i < MAX_ANCESTORS && cur; i++) {
        chain.push(describe(cur));
        if (cur.tagName === 'YTD-COMMENT-THREAD-RENDERER') break;
        cur = cur.parentElement;
      }
      return chain;
    };

    /** Whether the node is actually on screen (not hidden / display:none). */
    const isVisible = (node) => {
      try {
        if (node.isConnected === false) return false;
        const rects = node.getClientRects ? node.getClientRects() : [];
        if (rects && rects.length) return true;
        // jsdom / stub / not-yet-laid-out: fall back to offsetParent.
        return node.offsetParent !== null || node.offsetWidth > 0 || node.offsetHeight > 0;
      } catch (_) {
        return false;
      }
    };

    try {
      report.comment = {
        id: comment && comment.id,
        author: comment && comment.author,
        text: comment && comment.text ? String(comment.text).slice(0, MAX_TEXT) : ''
      };
      report.searchScope = describe(scope);
      report.searchScopeAttrs = attrsOf(scope);

      // ── Anchor on the visible EDITOR. This is the element the user sees as the
      // reply area, and it is the one thing we can be certain is on screen. ──
      const editorCandidates = [];
      const EDITOR_SELECTORS = [
        '[contenteditable="true"]',
        '[contenteditable=""]',
        'textarea',
        '[role="textbox"]'
      ];
      for (const sel of EDITOR_SELECTORS) {
        let found = [];
        // Scope first: prefer an editor inside the comment we are replying to.
        try {
          found = scope ? Array.from(scope.querySelectorAll(sel)) : [];
        } catch (_) {
          found = [];
        }
        // Then document-wide, because the whole bug is that the box is NOT inside the
        // scope we searched. Only visible ones, so a hidden template is never reported.
        try {
          found = found.concat(Array.from(document.querySelectorAll(sel)));
        } catch (_) { /* ignore */ }

        for (const el of found) {
          if (editorCandidates.indexOf(el) !== -1) continue;
          if (!isVisible(el)) continue;
          editorCandidates.push(el);
          if (editorCandidates.length >= 6) break;
        }
        if (editorCandidates.length >= 6) break;
      }

      report.visibleEditors = editorCandidates.map((el) => ({
        node: describe(el),
        attrs: attrsOf(el),
        insideSearchScope: !!(scope && scope.contains && scope.contains(el)),
        ancestorChain: ancestorChain(el),
        textSample: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
      }));

      // ── The reply box ROOT: walk up from the first visible editor until we hit a
      // node that also contains a Reply/Cancel control. That common ancestor is the
      // reply box, without assuming what it is called. ──
      let root = editorCandidates[0] || null;
      if (root) {
        for (let i = 0; i < MAX_ANCESTORS && root; i++) {
          let hasControls = false;
          try {
            for (const btn of Array.from(root.querySelectorAll('button, [role="button"], yt-touch-button'))) {
              const label = String(
                (btn.getAttribute && (btn.getAttribute('aria-label') || '')) || btn.textContent || ''
              ).trim().toLowerCase();
              if (/reply|cancel|send|post|comment|إلغاء|رد/.test(label)) { hasControls = true; break; }
            }
          } catch (_) { hasControls = false; }
          if (hasControls) break;
          if (root.tagName === 'YTD-COMMENT-THREAD-RENDERER') break;
          root = root.parentElement;
        }
      }

      report.replyBoxRoot = root ? describe(root) : 'NOT FOUND';
      report.replyBoxRootAttrs = root ? attrsOf(root) : {};

      if (root) {
        // The specific relationships asked for.
        let closestThread = null;
        let closestViewModel = null;
        let parentEl = null;
        try { parentEl = root.parentElement ? describe(root.parentElement) : null; } catch (_) { parentEl = null; }
        try { closestThread = root.closest ? root.closest('ytd-comment-thread-renderer') : null; } catch (_) {}
        try { closestViewModel = root.closest ? root.closest('ytd-comment-view-model') : null; } catch (_) {}

        report.replyBoxRootParent = parentEl;
        report.closestCommentThreadRenderer = closestThread ? describe(closestThread) : 'NONE';
        report.closestCommentViewModel = closestViewModel ? describe(closestViewModel) : 'NONE';
        report.ancestorChainToThread = ancestorChain(root);

        // Is the box inside the scope we were searching? This is the decisive bit.
        try {
          report.replyBoxInsideSearchScope = !!(scope && scope.contains && scope.contains(root));
        } catch (_) { report.replyBoxInsideSearchScope = 'unknown'; }

        // Descendants: a bounded tree walk, not the whole document.
        const descendants = [];
        try {
          for (const el of Array.from(root.querySelectorAll('*')).slice(0, MAX_DESCENDANTS)) {
            descendants.push(describe(el));
          }
        } catch (_) { /* ignore */ }
        report.descendants = descendants;
        report.descendantCountTotal = (() => {
          try { return root.querySelectorAll('*').length; } catch (_) { return -1; }
        })();

        // The Reply / Submit / Cancel controls, by label.
        const controls = [];
        try {
          for (const btn of Array.from(root.querySelectorAll('button, [role="button"], yt-touch-button'))) {
            const label = String(
              (btn.getAttribute && (btn.getAttribute('aria-label') || '')) || btn.textContent || ''
            ).replace(/\s+/g, ' ').trim();
            if (label) controls.push({ label: label.slice(0, 60), node: describe(btn) });
            if (controls.length >= 10) break;
          }
        } catch (_) { /* ignore */ }
        report.replyControls = controls;

        // A shallow HTML excerpt — the single most useful artifact for a real fix.
        try {
          report.htmlExcerpt = String(root.outerHTML || '').slice(0, 4000);
        } catch (_) { report.htmlExcerpt = 'unavailable'; }
      }

      // Did the selectors we rely on match anything ANYWHERE on the page? This
      // distinguishes "wrong tag name" from "element exists under another name".
      const probe = {};
      for (const sel of ['ytd-comment-reply-dialog-renderer#replybox', 'ytd-comment-reply-box-renderer', 'ytd-textbox', 'ytd-simple-textbox', '#reply-container', '#textbox', '#contenteditable-root']) {
        try { probe[sel] = document.querySelectorAll(sel).length; } catch (_) { probe[sel] = 'invalid'; }
      }
      report.selectorCountsAnywhereInDocument = probe;
    } catch (error) {
      report.diagnosticError = error && error.message;
    }

    __YTAR_DEBUG.debugWarn(
      'REPLY-BOX DIAGNOSTIC (temporary, read-only): ' +
      JSON.stringify(report, null, 1)
    );
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
      __YTAR_DEBUG.debugLog('openReplyBox: no reply button found');
      // No timer yet, so this is logged directly: "there was no Reply button" is a
      // different diagnosis from "the button was there and the box never appeared".
      __YTAR_DEBUG.devLog({
        component: 'YOUTUBE_ADAPTER',
        event: 'OPEN_REPLY_BOX_ERROR',
        level: 'WARN',
        commentId: comment && comment.id,
        message: 'no reply button found in the comment',
        data: { replyBoxFound: false, reason: 'findReplyButton returned null' }
      });
      return Promise.resolve(null);
    }

    // Click the reply button to trigger YouTube's reply UI
    try {
      btn.click();
    } catch (e) {
      __YTAR_DEBUG.debugWarn('openReplyBox: click failed:', e.message);
      __YTAR_DEBUG.devLog({
        component: 'YOUTUBE_ADAPTER',
        event: 'OPEN_REPLY_BOX_ERROR',
        level: 'ERROR',
        commentId: comment && comment.id,
        message: 'clicking the reply button threw: ' + e.message,
        error: e
      });
      return Promise.resolve(null);
    }

    // Wait for the reply editor to appear in the DOM.
    // YouTube renders asynchronously; an immediate querySelector after click
    // usually finds nothing. Poll with a bounded timeout.
    const POLL_INTERVAL = 150;
    const MAX_TIMEOUT_MS = 3000;
    let elapsed = 0;
    const adapter = this;

    // One timed span for the whole search, so "the box took 2.4s to appear" and "the box
    // never appeared" are both attributable to this comment.
    const openTimer = __YTAR_DEBUG.startTimer({
      component: 'YOUTUBE_ADAPTER',
      event: 'OPEN_REPLY_BOX',
      endEvent: 'OPEN_REPLY_BOX_SUCCESS',
      errorEvent: 'OPEN_REPLY_BOX_TIMEOUT',
      commentId: comment && comment.id,
      data: {
        searchScope: 'pending',
        selectorStrategy: 'reply-dialog-renderer',
        selectorsChecked: [
          'ytd-comment-reply-dialog-renderer#replybox',
          'ytd-comment-reply-box-renderer',
          '#reply-container ytd-textbox',
          '#text-box-container ytd-textbox',
          '#reply-container .yt-formatted-string.content'
        ],
        timeoutMs: MAX_TIMEOUT_MS
      }
    });

    return new Promise(function (resolve) {
      function poll() {
        if (!comment || !comment.element) {
          resolve(null);
          return;
        }

        // ── Task 15.8 fix: the click can replace the comment node itself ──
        // Clicking Reply makes YouTube re-render the thread, so the node captured
        // before btn.click() can be detached by the time poll() runs. A detached node
        // answers every querySelector with null (see isCommentDetached). Re-acquire it
        // here, reusing the machinery content.js already applies before this call.
        if (adapter.isCommentDetached(comment)) {
          const refreshed = adapter.reacquireComment(comment);
          if (refreshed) {
            comment = refreshed;
          }
        }

        // Search inside the THREAD, not `comment.element`. The re-acquired element can
        // be the narrower ytd-comment-view-model, and the reply box is a SIBLING of
        // that view model under the thread — see _replySearchScope() for the full
        // explanation. Without this widening, all three strategies below poll a scope
        // that structurally cannot contain the box.
        const scope = adapter._replySearchScope(comment) || comment.element;

        // Strategy 1: the real YouTube reply box root, inside the comment thread.
        //
        // Selector taken from a REAL live-DOM capture (not inferred):
        //   ytd-comment-thread-renderer
        //     -> ytd-comment-view-model#comment
        //       -> ytd-comment-engagement-bar#action-buttons
        //         -> div#reply-dialog
        //           -> ytd-comment-reply-dialog-renderer#replybox   <-- the root
        //             -> ytd-commentbox#commentbox
        //               -> div#main
        //                 -> div#contenteditable-root[contenteditable=true]
        //
        // Previous revisions searched for `ytd-comment-reply-box-renderer`, a tag that
        // does not exist on YouTube — so this strategy could never match, strategies 2
        // and 3 targeted markup that is also absent, and all three failed together
        // while the box was plainly open. The dialog is nested INSIDE the view model,
        // so the existing thread scope already contains it and the scope behaviour
        // above is unchanged.
        //
        // Returns the CONTAINER; _resolveEditable() then finds the real editor
        // (`#contenteditable-root[contenteditable=true]`) inside it.
        let editor = null;
        try {
          editor = scope.querySelector('ytd-comment-reply-dialog-renderer#replybox');
        } catch (_) {}
        if (editor) {
          openTimer.done({
            replyBoxFound: true,
            matchedSelector: 'ytd-comment-reply-dialog-renderer#replybox',
            commentStillConnected: adapter.isCommentDetached(comment) === false,
            searchScopeStillConnected: scope ? scope.isConnected !== false : false
          });
          resolve(editor);
          return;
        }

        // Strategy 1b: legacy/alternate tag name, kept as a fallback so nothing that
        // relied on the old shape regresses.
        try {
          editor = scope.querySelector('ytd-comment-reply-box-renderer');
        } catch (_) {}
        if (editor) {
          openTimer.done({
            replyBoxFound: true,
            matchedSelector: 'ytd-comment-reply-box-renderer',
            commentStillConnected: adapter.isCommentDetached(comment) === false,
            searchScopeStillConnected: scope ? scope.isConnected !== false : false
          });
          resolve(editor);
          return;
        }

        // Strategy 1c: modern/alternate replybox renderer (ytd-comment-reply-dialog-renderer or ytd-commentbox)
        try {
          editor = scope.querySelector('ytd-comment-reply-dialog-renderer, ytd-commentbox#commentbox, ytd-commentbox, #reply-dialog ytd-commentbox');
        } catch (_) {}
        if (editor) {
          openTimer.done({
            replyBoxFound: true,
            matchedSelector: 'ytd-comment-reply-dialog-renderer/ytd-commentbox',
            commentStillConnected: adapter.isCommentDetached(comment) === false,
            searchScopeStillConnected: scope ? scope.isConnected !== false : false
          });
          resolve(editor);
          return;
        }

        // Strategy 1d: contenteditable root directly inside scope
        try {
          const directEditable = scope.querySelector('#contenteditable-root[contenteditable="true"], div#contenteditable-root');
          if (directEditable) {
            openTimer.done({
              replyBoxFound: true,
              matchedSelector: '#contenteditable-root (scoped)',
              commentStillConnected: adapter.isCommentDetached(comment) === false,
              searchScopeStillConnected: scope ? scope.isConnected !== false : false
            });
            resolve(directEditable);
            return;
          }
        } catch (_) {}

        // Strategy 2: textbox with id="textbox" inside the reply box.
        // Scoped to the thread first: a document-wide query returns the first match
        // anywhere on the page, which may belong to a different comment.
        try {
          const scoped = scope.querySelector('#reply-container ytd-textbox, #text-box-container ytd-textbox');
          if (scoped) { openTimer.done({ replyBoxFound: true, matchedSelector: '#reply-container ytd-textbox (scoped)' }); resolve(scoped); return; }
          const tb = document.querySelector('#reply-container ytd-textbox, #text-box-container ytd-textbox');
          if (tb && scope.contains(tb)) { openTimer.done({ replyBoxFound: true, matchedSelector: '#text-box-container ytd-textbox (document)' }); resolve(tb); return; }
        } catch (_) {}

        // Strategy 3: any yt-formatted-string with class "content" inside the reply area
        try {
          const scopedContent = scope.querySelector('#reply-container .yt-formatted-string.content');
          if (scopedContent) { openTimer.done({ replyBoxFound: true, matchedSelector: '#reply-container .yt-formatted-string.content (scoped)' }); resolve(scopedContent); return; }
          const content = document.querySelector('#reply-container .yt-formatted-string.content');
          if (content && scope.contains(content)) { openTimer.done({ replyBoxFound: true, matchedSelector: '#reply-container .yt-formatted-string.content (document)' }); resolve(content); return; }
        } catch (_) {}

        elapsed += POLL_INTERVAL;
        if (elapsed >= MAX_TIMEOUT_MS) {
          __YTAR_DEBUG.debugLog('openReplyBox: timed out after ' + elapsed + 'ms');

          // Every fact needed to tell "the box never opened" apart from "the box opened
          // where we were not looking" or "the comment node was replaced underneath us".
          // This is the entry that answers a future YouTube DOM change.
          let visibleEditors = 0;
          try {
            visibleEditors = Array.from(document.querySelectorAll('[contenteditable="true"]')).length;
          } catch (_) { /* the count is a hint, never a control path */ }

          let scopeTag = null;
          let scopeConnected = null;
          try {
            scopeTag = scope ? String(scope.tagName || '').toLowerCase() : null;
            scopeConnected = scope ? scope.isConnected !== false : false;
          } catch (_) {}

          openTimer.fail(null, {
            replyBoxFound: false,
            reason: 'no selector matched within the timeout',
            searchScope: scopeTag,
            visibleEditors,
            commentStillConnected: comment && comment.element ? comment.element.isConnected !== false : false,
            searchScopeStillConnected: scopeConnected,
            // Cheap signals only. The full DOM dump stays behind the existing
            // one-shot _logReplyBoxDiagnostic, which runs on the timeout path.
            polledAttempts: Math.round(elapsed / POLL_INTERVAL)
          });

          // TEMPORARY DIAGNOSTIC — remove once the real reply-box structure is known.
          // Read-only: observes the DOM, changes nothing, never throws.
          adapter._logReplyBoxDiagnostic(comment, scope);
          resolve(null);
          return;
        }
        setTimeout(poll, POLL_INTERVAL);
      }

      poll();
    });
  }

  /**
   * Resolve the element that actually accepts text, given whatever openReplyBox returned.
   *
   * openReplyBox has two strategies that return DIFFERENT kinds of element: strategy 1
   * returns the `ytd-comment-reply-box-renderer` CONTAINER, while strategy 2 returns the
   * `ytd-textbox` editor itself. setReplyText() needs the editor. Writing to the
   * container is destructive — `element.textContent = ''` deletes every child, which
   * removes the textbox AND the Cancel/Submit buttons, after which submitReply() can no
   * longer find a submit button and the reply is never posted.
   *
   * So the editable target is resolved explicitly rather than assumed.
   *
   * Falls back to the element passed in, which preserves the previous behaviour for a
   * container that contains no recognisable editor.
   *
   * @param {HTMLElement} replyBox - element returned by openReplyBox
   * @returns {HTMLElement} the element to type into
   */
  _resolveEditable(replyBox) {
    if (!replyBox) return replyBox;

    const tag = (replyBox.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return replyBox;

    try {
      if (replyBox.getAttribute) {
        const ce = replyBox.getAttribute('contenteditable');
        if (ce === 'true' || ce === '') return replyBox;
        if (replyBox.getAttribute('role') === 'textbox') return replyBox;
      }
    } catch (_) {}

    const candidates = [
      '[contenteditable="true"]',
      'yt-formatted-string.content',
      '#textbox',
      'textarea',
      '#actual-text'
    ];
    for (const sel of candidates) {
      try {
        const inner = replyBox.querySelector(sel);
        if (inner) return inner;
      } catch (_) {}
    }

    return replyBox;
  }

  /**
   * Set the reply text in the reply box.
   *
   * YouTube's editor is a contenteditable / yt-formatted-string — setting .value
   * does nothing. We must focus, clear, insert via execCommand (which fires the
   * input/change events React listens to), and fall back to direct DOM + manual
   * event dispatch if execCommand is unavailable.
   *
   * @param {HTMLElement} replyBox - The reply editor element (or the box containing it)
   * @param {string} text  - Text to insert
   * @returns {boolean} True on success, false on failure (never throws)
   */
  setReplyText(replyBox, text) {
    // Timed because this is the step where a silent React/textContent mismatch shows
    // up: it returns a boolean and nothing else, so without a log line a failure here
    // is indistinguishable from "the reply box was empty".
    const insertTimer = __YTAR_DEBUG.startTimer({
      component: 'YOUTUBE_ADAPTER',
      event: 'SET_REPLY_TEXT',
      endEvent: 'SET_REPLY_TEXT_SUCCESS',
      errorEvent: 'SET_REPLY_TEXT_ERROR',
      data: {
        boxTag: replyBox ? String(replyBox.tagName || '').toLowerCase() : null,
        boxId: replyBox && replyBox.id ? replyBox.id : null,
        textChars: typeof text === 'string' ? text.length : null
        // The reply itself is never logged; only its length.
      }
    });

    if (!replyBox || typeof text !== 'string') {
      __YTAR_DEBUG.debugLog('setReplyText: invalid arguments');
      insertTimer.fail(null, { reason: 'invalid arguments', replyBoxPresent: !!replyBox, textIsString: typeof text === 'string' });
      return false;
    }

    try {
      // Type into the EDITABLE element, never into the box container — see
      // _resolveEditable(). Clearing the container would delete the submit button.
      const editor = this._resolveEditable(replyBox);

      // Focus the editor so YouTube's React layer knows it is active.
      editor.focus();

      // Clear any existing content.
      editor.textContent = '';

      // Preferred path: document.execCommand('insertText') fires the native
      // input / composition events that React actually listens to.
      if (typeof document.execCommand === 'function') {
        const ok = document.execCommand('insertText', false, text);
        if (ok) { insertTimer.done({ method: 'execCommand' }); return true; }
        // execCommand returned false — fall through to manual fallback.
      }

      // Fallback: set textContent and manually dispatch the events React expects.
      editor.textContent = text;

      const inputEvent  = new Event('input',  { bubbles: true });
      const changeEvent = new Event('change', { bubbles: true });
      editor.dispatchEvent(inputEvent);
      editor.dispatchEvent(changeEvent);
    } catch (err) {
      __YTAR_DEBUG.debugWarn('setReplyText failed:', err.message);
      insertTimer.fail(err, { method: 'threw' });
      return false;
    }

    insertTimer.done({ method: 'textContent + manual events' });
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
  /**
   * Read `dryRun` from storage, FAILING SAFE to `true`.
   *
   * Shared by `submitReply()` (Phase 8) and `heartComment`'s caller (Phase 23.1) because
   * both are irreversible actions in the creator's account, and two copies of "unreadable
   * means don't act" is exactly the pair that drifts — one gets a `!== false` loosened
   * into `!== true` later and nothing notices until the extension publishes a dry run.
   *
   * `true` is returned for a missing key, a non-boolean value, or a thrown read. The only
   * input that returns `false` is an explicit boolean `false`.
   *
   * @param {string} [label] - call site, for the warning message only
   * @returns {Promise<boolean>}
   */
  async isDryRunActive(label) {
    try {
      const result = await chrome.storage.local.get(['dryRun']);
      if (result && typeof result.dryRun === 'boolean') return result.dryRun;
      __YTAR_DEBUG.debugWarn(
        (label || 'isDryRunActive') + ': dryRun was not a boolean; defaulting to dry-run'
      );
      return true;
    } catch (_error) {
      __YTAR_DEBUG.debugWarn(
        (label || 'isDryRunActive') + ': could not read dryRun setting, defaulting to dry-run'
      );
      return true;
    }
  }

  async submitReply(replyBox) {
    // --- dry-run gate ----------------------------------------------------------
    // One shared read: `isDryRunActive()` is the single definition of "is this a dry run"
    // for every action this adapter takes on the page.
    const dryRun = await this.isDryRunActive('submitReply');

    if (dryRun) {
      const textContent = replyBox ? replyBox.textContent : null;
      const hasContent = !!(textContent && textContent.trim());
      // The one remaining stray console.info in the codebase is replaced by the
      // central system, so every diagnostic line now shares one format and one gate.
      __YTAR_DEBUG.devLog({
        component: 'YOUTUBE_ADAPTER',
        event: 'SUBMIT_REPLY_DRY_RUN',
        level: hasContent ? 'INFO' : 'WARN',
        message: 'dry-run mode — the submit button was not clicked'
        // The draft itself is NOT logged. Its length is the diagnostic signal: a
        // non-empty box proves the insert worked, without printing a pending reply.
        ,
        data: { dryRun: true, boxTextChars: textContent ? textContent.length : 0, boxNonEmpty: hasContent, clicked: false }
      });
      if (!hasContent) {
        __YTAR_DEBUG.debugWarn(
          'submitReply: DRY-RUN — reply box appears empty; '
            + 'posting an empty reply would be a bug'
        );
      }
      return false;
    }

    // --- find the Submit button (multi-fallback, same style as existing code) --
    const submitTimer = __YTAR_DEBUG.startTimer({
      component: 'YOUTUBE_ADAPTER',
      event: 'SUBMIT_REPLY',
      endEvent: 'SUBMIT_REPLY_SUCCESS',
      errorEvent: 'SUBMIT_REPLY_ERROR'
    });
    let submitBtn = null;

    try {
      submitBtn = replyBox.querySelector('button[aria-label*="Comment"]');
    } catch (_) {}
    if (!submitBtn) {
      try {
        submitBtn = replyBox.querySelector('button[aria-label*="Reply"]');
      } catch (_) {}
    }
    if (!submitBtn) {
      try {
        const candidate = replyBox.querySelector('#submit-button');
        if (candidate) {
          submitBtn = candidate.querySelector('button') || candidate;
        }
      } catch (_) {}
    }
    if (!submitBtn) {
      try {
        // Last resort: any button whose aria-label or textContent contains "send" / "post" / "reply" / "رد" / "تعليق"
        const buttons = replyBox.querySelectorAll('button, [role="button"]');
        for (const b of buttons) {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const text  = (b.textContent || '').toLowerCase();
          if (label.includes('send') || label.includes('post') || label.includes('reply') ||
              text.includes('send') || text.includes('post') || text.includes('reply') ||
              label.includes('رد') || text.includes('رد') ||
              label.includes('تعليق') || text.includes('تعليق')) {
            submitBtn = b;
            break;
          }
        }
      } catch (_) {}
    }

    if (!submitBtn) {
      __YTAR_DEBUG.debugLog('submitReply: no submit button found');
      submitTimer.fail(null, {
        reason: 'no submit button found',
        dryRun: false,
        selectorsTried: ['button[aria-label*="Comment"]', 'button[aria-label*="Reply"]', '#submit-button', 'button text/label containing send/post/reply/رد/تعليق']
      });
      return false;
    }

    try {
      const clickTarget = (submitBtn.querySelector && submitBtn.querySelector('button')) || submitBtn;
      clickTarget.click();
      submitTimer.done({ dryRun: false, clicked: true, submitButtonAriaLabel: submitBtn.getAttribute ? submitBtn.getAttribute('aria-label') : null });
      return true;
    } catch (err) {
      __YTAR_DEBUG.debugWarn('submitReply: click failed:', err.message);
      submitTimer.fail(err, { reason: 'click threw', dryRun: false, clicked: false });
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

  /**
   * The class YouTube puts on the author element of the CHANNEL OWNER's own comments and
   * replies. It is the only reliable way to tell "a customer wrote this" from "we wrote
   * this" without asking the network, and getting it wrong is a feedback loop: we post a
   * reply, the reply appears in the DOM as a comment, the observer reports it as a new
   * customer comment, and we reply to our own reply. Real Chrome, 2026-10-09, three replies
   * deep before it was noticed.
   *
   * Phase 20.23 adds a markup-independent second layer in content.js, so a YouTube markup
   * change here degrades to "we skip fewer own-comments" rather than to "the loop is back".
   */
  OWNER_AUTHOR_CLASS: 'owner-text',

  /**
   * The channel owner's "liked by creator" heart on ONE comment.
   *
   * This is the Polymer ELEMENT, and matching it by tag is deliberate: the attribute people
   * expect (`creator-heart` on the comment renderer) does not exist in YouTube's DOM, and the
   * empty `<div id="creator-heart">` it is often confused with is only the legacy
   * `ytd-comment-action-buttons-renderer` mount point — absent under the newer
   * `ytd-comment-engagement-bar` toolbar. Naming the element matches under both.
   */
  CREATOR_HEART: 'ytd-creator-heart-renderer',

  /**
   * The STATE inside the heart container — and this pair is the whole point of the feature.
   *
   * `ytd-creator-heart-renderer` is only the CONTAINER. In the channel owner's own session
   * YouTube stamps it into the `#creator-heart` slot of EVERY comment the owner can heart,
   * hearted or not, so its PRESENCE proves only that the control was rendered — never that
   * the heart is on. A filter written on presence alone excludes the entire channel and
   * reads as a silent, total mute with no error anywhere.
   *
   * YouTube's own Polymer template, verbatim:
   *
   *   <yt-icon-button id="creator-heart-button" class="style-scope ytd-creator-heart-renderer">
   *     <template is="dom-if" if="[[data.isHearted]]">
   *       <yt-img-shadow id="hearted-thumbnail" thumbnail="[[data.creatorThumbnail]]"></yt-img-shadow>
   *       <yt-icon id="hearted-border" ...></yt-icon>
   *       <yt-icon id="hearted" ...></yt-icon>
   *     </template>
   *     <template is="dom-if" if="[[!data.isHearted]]">
   *       <yt-icon id="unhearted" ...></yt-icon>
   *     </template>
   *   </yt-icon-button>
   *
   * So the state is DOM PRESENCE, not an attribute: no `aria-pressed`, no `is-hearted`,
   * nothing to test for. `#hearted` is the filled red heart (YouTube ships it at
   * `color: rgb(255,0,51)`, absolutely positioned over the creator's thumbnail, which is
   * `#hearted-thumbnail`, a 24px circle) and `#unhearted` is the plain grey outline.
   *
   * `#creator-heart-button` is NOT the signal either: it is the button wrapper and is present
   * on every heartable comment regardless of state, so a visibility test on it means "the
   * owner is logged in", not "hearted".
   */
  CREATOR_HEART_ON: '#hearted',
  CREATOR_HEART_OFF: '#unhearted',
  // Phase 23.1 — the control to PRESS, which is a different question from the state to
  // READ. It is present in both states, so it is never used as evidence of anything; it
  // is only ever used as the click target.
  CREATOR_HEART_BUTTON: '#creator-heart-button',

  // --- Comment body text, based on real-Chrome DOM evidence ---------------------
  // A rendered comment is:
  //   ytd-comment-thread-renderer > ytd-comment-view-model#comment > div#body
  // The body text sits inside div#body. The old `ytd-comment-text-renderer` element
  // is no longer present in current YouTube markup, which made every real comment
  // parse to null (empty text).
  COMMENT_VIEW_MODEL: 'ytd-comment-view-model',
  COMMENT_BODY: '#body',
  // Innermost text elements inside #body, checked in order. yt-attributed-string is
  // what current YouTube uses; yt-formatted-string is kept as a secondary holder.
  TEXT_HOLDER_ATTRIBUTED: 'yt-attributed-string',
  TEXT_HOLDER_FORMATTED: 'yt-formatted-string',

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

  // --- Phase 22: the replies INSIDE a thread -----------------------------------
  //
  // Until Phase 22 the adapter read only the top-level comment: `findCommentNodes()`
  // returns threads, and `parseComment()` takes the FIRST view model inside one, which is
  // the parent. Replies live under `ytd-comment-replies-renderer`, so they were never seen
  // — which is why nothing could tell "the creator already answered this" from "nobody
  // answered this".
  REPLIES_RENDERER: 'ytd-comment-replies-renderer',
  // The button that expands a collapsed thread. Current markup wraps it in a yt-button-shape
  // whose label reads "View N replies"; older markup used a bare button. Both are listed
  // because this is the one place where clicking is REQUIRED, and a missed selector means
  // the feature silently finds nothing.
  REPLIES_EXPANDER: '#expander, [aria-label*="replies" i], [aria-label*="رد"], #button',
};

/**
 * Whether this thread's replies are collapsed and the expander is waiting to be clicked.
 *
 * YouTube renders the reply COUNT in the collapsed button but the reply BODIES only after
 * a click. That is the trap in this whole feature: an unexpanded thread looks exactly like
 * a thread nobody answered, and a feature built on "no owner reply found" would report every
 * collapsed thread as unanswered — the precise opposite of the truth.
 *
 * @param {HTMLElement} thread
 * @returns {HTMLElement|null} the expander to click, or null when there is nothing to expand
 */
YouTubeSiteAdapter.prototype.getRepliesExpander = function (thread) {
  if (!thread || typeof thread.querySelector !== 'function') return null;
  let replies;
  try {
    replies = thread.querySelector(YouTubeSiteAdapter.SELECTORS.REPLIES_RENDERER);
  } catch (_) {
    return null;
  }
  if (!replies) return null;

  // Already expanded: reply bodies are present, so there is nothing to click.
  let bodies;
  try {
    bodies = replies.querySelectorAll(
      YouTubeSiteAdapter.SELECTORS.COMMENT_VIEW_MODEL + ' ' +
      YouTubeSiteAdapter.SELECTORS.COMMENT_BODY
    );
  } catch (_) {
    bodies = null;
  }
  if (bodies && bodies.length > 0) return null;

  // Collapsed. The expander is inside the replies renderer, not the thread, and the reply
  // count lives in its label — so a thread with zero replies has no expander at all, which
  // is a second, independent signal that nobody replied.
  let expander;
  try {
    expander = replies.querySelector('#expander') ||
      replies.querySelector('button') ||
      replies.querySelector('[aria-label]');
  } catch (_) {
    expander = null;
  }
  if (!expander) return null;

  // Only a control that looks like an expander. A bare `button` fallback is filtered by
  // label so a stray control inside the replies container cannot be clicked.
  const label = this._collapse(
    (expander.getAttribute && (expander.getAttribute('aria-label') || expander.getAttribute('title'))) ||
    expander.textContent ||
    ''
  ).toLowerCase();
  const looksLikeExpander =
    label.indexOf('repl') !== -1 ||
    label.indexOf('رد') !== -1 ||
    label.indexOf('view') !== -1 ||
    label.indexOf('عرض') !== -1 ||
    label.indexOf('hide') !== -1 ||
    label.indexOf('إخفاء') !== -1;
  return looksLikeExpander ? expander : null;
};

/**
 * Expand a collapsed thread so its replies exist in the DOM.
 *
 * A user-visible click on the page YouTube itself provides — not a synthetic dispatch and
 * not a direct API call. Anything else would either be ignored by YouTube's own handlers or
 * would leave the page in a state the creator did not create.
 *
 * @param {HTMLElement} expander
 * @returns {boolean} whether a click was dispatched
 */
YouTubeSiteAdapter.prototype.expandReplies = function (expander) {
  if (!expander || typeof expander.click !== 'function') return false;
  try {
    expander.click();
    return true;
  } catch (_) {
    return false;
  }
};

/**
 * Read the replies inside a thread.
 *
 * Each entry is `{ author, text, isOwner }`. `isOwner` comes from the SAME `isOwnComment`
 * predicate that stops the extension replying to itself — two answers to "who wrote this"
 * would drift, and the wrong one puts a creator's own reply back in front of them.
 *
 * Returns `[]` for a thread with no replies, and `[]` for a COLLAPSED thread the caller did
 * not expand. Callers must read `getRepliesExpander()` first; treating "collapsed" as "no
 * replies" is the bug this function's own comment exists to prevent.
 *
 * @param {HTMLElement} thread
 * @returns {Array<{author: string, text: string, isOwner: boolean}>}
 */
YouTubeSiteAdapter.prototype.readThreadReplies = function (thread) {
  if (!thread || typeof thread.querySelector !== 'function') return [];

  let repliesRoot;
  try {
    repliesRoot = thread.querySelector(YouTubeSiteAdapter.SELECTORS.REPLIES_RENDERER);
  } catch (_) {
    return [];
  }
  if (!repliesRoot) return [];

  const S = YouTubeSiteAdapter.SELECTORS;
  let models;
  try {
    models = repliesRoot.querySelectorAll(S.COMMENT_VIEW_MODEL + ', ' + S.COMMENT_RENDERER);
  } catch (_) {
    return [];
  }

  const out = [];
  for (const model of models) {
    let text = '';
    try {
      const body = model.querySelector(S.COMMENT_BODY) || model.querySelector('#content-text, #comment-content');
      if (!body) continue;
      for (const holderSelector of [S.TEXT_HOLDER_ATTRIBUTED, S.TEXT_HOLDER_FORMATTED]) {
        const holder = body.querySelector(holderSelector);
        const holderText = holder && this._collapse(holder.textContent);
        if (holderText && !holderText.startsWith('[')) {
          text = holderText;
          break;
        }
      }
      if (!text) {
        const bodyText = this._collapse(body.textContent);
        if (bodyText && !bodyText.startsWith('[')) text = bodyText;
      }
    } catch (_) {
      continue;
    }
    if (!text) continue;

    let author = '';
    try {
      const authorEl = model.querySelector(S.AUTHOR_LINK) || model.querySelector(S.AUTHOR_LINE);
      const authorText = authorEl && this._collapse(authorEl.textContent);
      if (authorText && !authorText.startsWith('[')) author = authorText;
    } catch (_) {
      author = '';
    }

    out.push({ author: author, text: text, isOwner: this.isOwnComment(model) });
  }

  return out;
};

/**
 * Resolve the element that holds ONE comment, excluding the thread's replies.
 *
 * THE ORDER IS THE GUARANTEE, and it is the same one `parseComment()` already depends on:
 * in
 *   ytd-comment-thread-renderer
 *     └─ ytd-comment-view-model#comment     ← the comment itself
 *          └─ ytd-comment-replies-renderer
 *               └─ ytd-comment-view-model   ← every reply, including the creator's own
 * the parent view model comes FIRST in document order, so `querySelector` (not
 * `querySelectorAll`) returns the comment and never a reply. This is asserted in the tests,
 * because a future change to "search more thoroughly" would silently start reading replies.
 *
 * Kept as one static helper rather than duplicated in `isHeartedComment()` because a second
 * copy of the scoping rule is a second answer to "whose comment is this" — and the two would
 * drift in exactly the direction that matters, reading a reply's heart as the parent's.
 *
 * @param {HTMLElement} node - a comment element (thread, view model, or legacy root)
 * @param {Object} S - YouTubeSiteAdapter.SELECTORS
 * @returns {Element|null} this comment's own view model, or null when it cannot be resolved
 */
YouTubeSiteAdapter._ownCommentRoot = function (node, S) {
  try {
    if (!node) return null;
    if (node.matches) {
      if (node.matches(S.COMMENT_VIEW_MODEL)) return node;
      if (node.matches(S.COMMENT_RENDERER)) return node;
    }
    return node.querySelector(S.COMMENT_VIEW_MODEL) || node.querySelector(S.COMMENT_RENDERER) || node;
  } catch (_) {
    return null;
  }
};

// WeakMap for stable fallback IDs when data-id is missing.
// This ensures the same element always gets the same ID across multiple parse calls,
// enabling proper deduplication via seenIds in content.js.
YouTubeSiteAdapter._fallbackIds = new WeakMap();

// Counter to generate unique fallback IDs (incremented once per new element).
YouTubeSiteAdapter._fallbackCounter = 0;

// TEMPORARY DIAGNOSTIC: one reply-box DOM dump per page load (debug only).
YouTubeSiteAdapter._replyDiagLogged = false;

// Export as globalThis so content.js can use it without ES modules
if (typeof window !== 'undefined') {
  window.YouTubeSiteAdapter = YouTubeSiteAdapter;
}
