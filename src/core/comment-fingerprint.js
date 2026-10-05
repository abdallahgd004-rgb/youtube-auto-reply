// Phase 9.1 - Comment Fingerprint

import { normalizeArabic } from './matchers/arabic-normalizer.js';

/**
 * Create a stable fingerprint for a comment to prevent duplicate replies across page loads.
 *
 * Preferred path: `site + page + commentId` — uses the real YouTube comment ID when available.
 * Fallback path:  `author + normalizedText + approximateTimestamp` — used when no usable id exists.
 *
 * @param {Object|null|undefined} comment   — The comment object (guarded).
 * @param {Object|null|undefined} pageInfo  — Page context with site, url, and optional timestamp.
 * @returns {string} A stable fingerprint string.
 */
export function createFingerprint(comment, pageInfo) {
  // Guard: null/undefined/nullish → return a deterministic empty-string fingerprint
  if (!comment && !pageInfo) {
    return 'f:null';
  }

  const site = safeString(pageInfo?.site);
  const pageUrl = safeString(pageInfo?.url);
  const commentId = safeString(comment?.id);
  const author = safeString(comment?.author);
  const text = safeString(comment?.text);
  const timestamp = pageInfo?.timestamp;

  // ── Preferred path: real comment id ────────────────────────────────────────
  if (commentId && commentId.length > 0) {
    // Sanitize page URL so that tracking/session parameters (e.g. ?feature=share
    // vs ?feature=comment, ?utm_source=...) do NOT produce two different
    // fingerprints for the same comment — while keeping essential params like
    // v= (video ID), t= (timestamp) that identify the actual page.
    let cleanPage = site;
    if (pageUrl) {
      try {
        const parsed = new URL(pageUrl);
        // Keep origin + pathname, then rebuild query with only "essential" params
        // while dropping known noise parameters.
        const noiseParams = new Set([
          'feature', 'utm_source', 'utm_medium', 'utm_campaign',
          'utm_term', 'utm_content', 'referrer', 'share', 'si',
          't', // timestamp anchor — not stable across reloads
        ]);
        const essentialParams = new URLSearchParams();
        for (const [key, val] of parsed.searchParams) {
          if (!noiseParams.has(key)) {
            essentialParams.append(key, val);
          }
        }
        const qs = essentialParams.toString();
        cleanPage = `${parsed.origin}${parsed.pathname}${qs ? '?' + qs : ''}`;
      } catch (_) {
        // Fallback: raw string if URL parsing fails (malformed URL).
        // Strip everything after '?' or '#'.
        const stripped = pageUrl.split(/[?#]/)[0];
        cleanPage = site ? `${site}:${stripped}` : stripped;
      }
    }

    // Join with a delimiter that cannot appear in any component.
    return `fp:id:${site}|${cleanPage}|${commentId}`;
  }

  // ── Fallback path: author + normalizedText + approximateTimestamp ──────────
  const normText = normalizeArabic(text);

  if (!author && !normText) {
    // Neither author nor text available — return a minimal fingerprint.
    return `f:fb-empty`;
  }

  let parts = [];
  if (author) parts.push(`a:${author}`);
  if (normText) parts.push(`t:${normText}`);
  if (timestamp !== undefined && timestamp !== null) {
    // Append the timestamp as a string so it is included in the fingerprint.
    parts.push(`ts:${String(timestamp)}`);
  }

  return `fp:fb:${parts.join('|')}`;
}

/**
 * Safely extract a non-empty string from any value. Returns '' for null/undefined/non-string.
 */
function safeString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  // Coerce other primitives; objects become '[object Type]'.
  const s = String(val);
  return s.trim() || '';
}
