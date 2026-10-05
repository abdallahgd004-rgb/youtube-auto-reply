/**
 * Reply Deduplicator — Phase 7.5
 *
 * Prevents generating the same (or near-identical) reply twice within a single cycle:
 *   1. Identical to a previous reply for the SAME comment (case/whitespace/punctuation).
 *   2. Near-duplicate for the SAME comment — no second LM Studio call on one comment.
 *   3. Too-similar to a reply generated for a DIFFERENT comment in the same cycle.
 *
 * Similarity metric: character bigram Jaccard similarity (threshold 0.9).
 * Chosen because it works well with Arabic text where word boundaries are ambiguous,
 * and it catches near-duplicates without requiring an external library or heavy algorithm.
 */

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
  // commentId → Set of normalized replies already generated for this comment
  const commentReplies = new Map();
  // All normalized replies seen in this cycle (for cross-comment similarity)
  const allNormalizedReplies = new Set();

  /**
   * Check whether a reply is a duplicate within the current cycle.
   *
   * @param {Object} params
   * @param {string|undefined|null} params.reply          — The generated reply text (guarded).
   * @param {string|undefined|null} params.commentId      — Unique comment identifier (guarded).
   * @returns {boolean} true if the reply should be rejected as a duplicate.
   */
  function isDuplicate({ reply, commentId }) {
    const norm = normalizeReply(reply);

    // Guard: empty / null / undefined → treat as duplicate (nothing to publish)
    if (!norm || norm.length === 0) return true;

    // ── Rule 1 & 3: same comment — reject ALL second generations ───────────
    const existing = commentReplies.get(commentId);
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
    if (!commentReplies.has(commentId)) commentReplies.set(commentId, new Set());
    commentReplies.get(commentId).add(norm);
    allNormalizedReplies.add(norm);

    return false; // first time — accept
  }

  /**
   * Clear all cycle state. Call at the start of each processing cycle.
   */
  function reset() {
    commentReplies.clear();
    allNormalizedReplies.clear();
  }

  return { isDuplicate, reset };
}
