/**
 * Reply Deduplicator — Phase 7.5, page-session-scoped in Phase 19.8
 *
 * Prevents generating the same (or near-identical) reply twice within a single cycle:
 *   1. Identical to a previous reply for the SAME comment (case/whitespace/punctuation).
 *   2. Near-duplicate for the SAME comment — no second LM Studio call on one comment.
 *   3. Too-similar to a reply generated for a DIFFERENT comment in the same cycle.
 *
 * Similarity metric: character bigram Jaccard similarity (threshold 0.9).
 * Chosen because it works well with Arabic text where word boundaries are ambiguous,
 * and it catches near-duplicates without requiring an external library or heavy algorithm.
 *
 * PAGE SESSIONS (Phase 19.8)
 * Rules 1–3 are keyed by a PAGE SESSION, not by the bare comment id. A comment is
 * "already generated" only within the page session that generated it, because the memory
 * below lives in the service worker — which outlives any single YouTube tab. Keying on the
 * comment id alone made a page reload re-detect an unhandled comment and then skip it as a
 * duplicate generation, with no error anywhere.
 *
 * Rule 4 stays cross-session on purpose: near-identical answers to different comments is
 * what makes a channel look automated, and that judgement does not expire on reload.
 */

/**
 * Compose the map key for a comment within a page session.
 *
 * A missing session id falls back to the bare comment id, which is the pre-19.8
 * behaviour. Callers in the extension always supply one; the fallback only matters for a
 * direct caller that does not, and for the tests that exercise the bare-key path.
 *
 * @param {string|undefined|null} pageSessionId
 * @param {string|undefined|null} commentId
 * @returns {string}
 */
function scopedKey(pageSessionId, commentId) {
  const id = commentId == null ? '' : String(commentId);
  if (pageSessionId == null || pageSessionId === '') return id;
  return `${pageSessionId} ${id}`;
}

// ── Normalization ──────────────────────────────────────────────────────────────
// Lowercase + strip trailing punctuation + Arabic numeral unification.
// "الكتاب بـ 50 جنيه" == "الكتاب بـ 50 جنيه." == "الكتاب بـ ٥٠ جنيه"

function normalizeReply(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim().toLowerCase();
  // Unify Arabic-Indic digits (٠-٩) to Latin digits (0-9)
  const arabicDigits = ['\u0660', '\u0661', '\u0662', '\u0663', '\u0664',
                        '\u0665', '\u0666', '\u0667', '\u0668', '\u0669'];
  const latinDigits = '0123456789';
  for (let i = 0; i < 10; i++) {
    s = s.split(arabicDigits[i]).join(latinDigits[i]);
  }
  // Strip one or more trailing Arabic/English full stops, commas, question marks, exclamation marks
  s = s.replace(/[.،؟!]+$/, '');
  // Collapse internal whitespace to single space
  s = s.replace(/\s+/g, ' ');
  return s;
}

// ── Similarity (character bigram Jaccard) ──────────────────────────────────────
// Returns a value in [0, 1]. 0.9 means "essentially the same reply".

function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const bigrams = (str) => {
    const out = new Set();
    for (let i = 0; i < str.length - 1; i++) out.add(str.slice(i, i + 2));
    return out;
  };

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);

  let intersection = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++;
  }

  const union = aBigrams.size + bBigrams.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createReplyDeduplicator() {
  // `${pageSessionId} ${commentId}` → Set of normalized replies already generated for it.
  // Scoped per page session since Phase 19.8; see the header note.
  const commentReplies = new Map();
  // All normalized replies seen in this cycle (for cross-comment similarity)
  const allNormalizedReplies = new Set();

  /**
   * Check whether a reply is a duplicate within the current cycle.
   *
* @param {Object} params
    * @param {string|undefined|null} params.reply          — The generated reply text (guarded).
    * @param {string|undefined|null} params.commentId      — Unique comment identifier (guarded).
    * @param {string|undefined|null} [params.pageSessionId] — The page session this reply
    *   belongs to (Phase 19.8). Scopes the per-comment rule so "already generated" means
    *   "already generated during THIS page session", not "since the worker booted". See the
    *   header note on page sessions.
    * @returns {boolean} true if the reply should be rejected as a duplicate.
    */
    function isDuplicate({ reply, commentId, pageSessionId }) {
      const norm = normalizeReply(reply);

      // Guard: empty / null / undefined → treat as duplicate (nothing to publish)
      if (!norm || norm.length === 0) return true;

      const key = scopedKey(pageSessionId, commentId);

      // ── Rule 1 & 3: same comment — reject ALL second generations ───────────
      const existing = commentReplies.get(key);
    if (existing && existing.has(norm)) {
      return true; // identical reply for this exact comment
    }
    if (existing) {
      // Rule 3: no second LM Studio call on the same comment — reject outright.
      return true;
    }

    // ── Rule 4: different comment but too similar to any reply in this cycle ─
    for (const seenReply of allNormalizedReplies) {
      if (similarity(norm, seenReply) >= 0.9) return true;
    }

// ── Register the new reply ─────────────────────────────────────────────
      if (!commentReplies.has(key)) commentReplies.set(key, new Set());
      commentReplies.get(key).add(norm);
      allNormalizedReplies.add(norm);

      return false; // first time — accept
    }

    /**
     * Whether a reply has already been generated for this comment in this cycle.
     *
     * This is the PRE-GENERATION half of Rule 3 ("no second LM Studio call on one
     * comment"). `isDuplicate()` needs the reply text, so it can only be consulted once
     * the model has already answered — by which point the wasted call has happened. A
     * caller that wants to actually avoid the second generation must ask this first.
     *
     * Phase 19.8 — `pageSessionId` scopes the lookup. Without it this answers "since the
     * worker booted", which is what made a YouTube page reload look like an already-
     * answered comment: the guard outlived the page that created it.
     *
     * Read-only: it does not register anything, so calling it and then finding `false`
     * does not affect a later `isDuplicate()` verdict.
     *
     * @param {string} commentId — the comment identifier
     * @param {string} [pageSessionId] — the page session
     * @returns {boolean} true when this comment already has a reply in this page session
     */
    function hasGeneration(commentId, pageSessionId) {
      return commentReplies.has(scopedKey(pageSessionId, commentId));
    }

  /**
   * Clear all cycle state. Call at the start of each processing cycle.
   */
  function reset() {
    commentReplies.clear();
    allNormalizedReplies.clear();
  }

  return { isDuplicate, hasGeneration, reset };
}
