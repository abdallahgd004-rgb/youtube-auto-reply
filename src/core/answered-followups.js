/**
 * Answered Follow-ups — Phase 22
 *
 * A comment the creator has ALREADY replied to, offered back to them so they can decide
 * whether to follow up. Nothing here publishes anything.
 *
 * ── Why this is its own module and not a trigger ────────────────────────────────
 *
 * The obvious implementation is "add the phrase to a trigger rule". That is wrong in three
 * ways, and each of them is silent:
 *
 *   1. A trigger fires on the TEXT. This feature fires on the THREAD — the comment text
 *      can be identical, and only one copy of it has a reply from the channel owner. A
 *      trigger cannot see that difference, so it would fire on both.
 *   2. A trigger's reply goes down the auto-publish path. This one must never publish: the
 *      creator answers these by hand, and an automated second reply under their name is
 *      exactly the outcome they did not ask for.
 *   3. A trigger has no idea what the channel owner already said. The whole point is to
 *      read that reply, and to decide against it.
 *
 * ── The rule this module owns ───────────────────────────────────────────────────
 *
 * A comment qualifies when it carries a reply from the channel owner. It is a claim about
 * the THREAD, not about the words, so it is decided deterministically here and never by the
 * model. The model is asked a different question — "does this reply leave something worth
 * following up on?" — which is a judgement, and belongs in the model.
 */

import { normalizeArabic } from './matchers/arabic-normalizer.js';

/** Longest comment text read into a draft prompt. */
export const MAX_COMMENT_CHARS = 2000;

/** How many existing replies are quoted into the prompt. */
export const MAX_QUOTED_REPLIES = 5;

/** Longest single quoted reply. */
export const MAX_REPLY_CHARS = 600;

/**
 * Whether a comment is one the creator has already answered.
 *
 * DETERMINISTIC, and it must stay that way. "Did the channel owner reply?" is a fact about
 * the DOM that can be checked exactly; putting it to a model would mean an unreachable
 * LM Studio silently empties the list, and a model that says "no" to a thread the creator
 * plainly answered is indistinguishable from a working feature.
 *
 * `ownerReplies` is counted by the caller using the adapter's `isOwnComment`, which is the
 * same predicate that keeps the extension from replying to itself.
 *
 * @param {{replies?: Array<{text?: string, isOwner?: boolean}>, ownerReplies?: number}} input
 * @returns {{qualified: boolean, reason: string, ownerReplies: number, replyCount: number}}
 */
export function classifyAnsweredComment(input) {
  const replies = Array.isArray(input?.replies) ? input.replies : [];
  const replyCount = replies.length;
  // Prefer the explicit count so a caller that counted owner replies without keeping the
  // bodies still works; fall back to counting them here.
  const counted = replies.filter((r) => r && r.isOwner === true).length;
  const ownerReplies =
    typeof input?.ownerReplies === 'number' && Number.isFinite(input.ownerReplies)
      ? Math.max(0, Math.trunc(input.ownerReplies))
      : counted;

  if (ownerReplies <= 0) {
    return {
      qualified: false,
      reason: replyCount > 0
        ? 'the thread has replies, but none from the channel owner'
        : 'the thread has no replies at all',
      ownerReplies,
      replyCount
    };
  }

  return {
    qualified: true,
    reason: `the channel owner has replied ${ownerReplies === 1 ? 'once' : `${ownerReplies} times`}`,
    ownerReplies,
    replyCount
  };
}

/**
 * Collapse whitespace and bound a length, without ever cutting mid-word silently.
 *
 * The truncation marker is load-bearing: a comment cut at 2000 chars with no marker reads
 * as a complete sentence, and the model drafts a reply to a question that was never asked.
 */
function bound(text, max) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '…';
}

/**
 * Build the prompt that asks the model whether a follow-up is worth writing.
 *
 * TWO BLOCKS, and the split is the point. The viewer's question and the creator's existing
 * reply are separate, labelled sections rather than one blob, because the model has to be
 * able to tell "what was asked" from "what was already said" — and that is the whole
 * decision. Concatenating them produces a draft that repeats the channel owner.
 *
 * The creator's reply is quoted EXPLICITLY as something that must not be restated, which is
 * the one instruction that stops the most common failure (a follow-up that is a paraphrase
 * of the reply already on screen).
 *
 * @param {Object} input
 * @param {Object} input.comment - the viewer's comment
 * @param {string} input.comment.text
 * @param {string} [input.comment.author]
 * @param {Array<{text?: string, isOwner?: boolean}>} input.replies - existing replies, oldest first
 * @param {string} [instruction] - the user's own instruction, passed VERBATIM
 * @returns {Array<{role: string, content: string}>}
 */
export function buildFollowupMessages(input) {
  const commentText = bound(input?.comment?.text, MAX_COMMENT_CHARS);
  if (!commentText) {
    throw new Error('A follow-up needs the viewer comment text');
  }

  const replies = (Array.isArray(input?.replies) ? input.replies : [])
    .filter((r) => r && String(r.text || '').trim().length > 0)
    .slice(0, MAX_QUOTED_REPLIES)
    .map((r) => ({
      text: bound(r.text, MAX_REPLY_CHARS),
      isOwner: r.isOwner === true
    }));

  const system = [
    'أنت تساعد صاحب قناة يوتيوب على الرد على تعليقاته مرة ثانية.',
    'سيقرأ تعليق مشاهد، ثم الرد الذي كتبه صاحب القناة على نفس التعليق.',
    'مهمتك: تقرر هل الرد الموجود على التعليق يترك شيئًا يستحق الرد مرة ثانية، وتكتب الرد الإضافي لو يستحق.',
    '',
    'قواعد أساسية:',
    '١. لا تعِد ما قاله صاحب القناة في رده. الرد الجديد يجب أن يضيف معلومة جديدة، لا أن يعيد صياغة الرد القديم.',
    '٢. لا تخترع أسعارًا أو مواعيد أو روابط أو معلومات غير موجودة في نص التعليق أو في رد صاحب القناة.',
    '٣. لو الرد القديم كان كاملًا وجاهزًا، أجب بأن لا حاجة لرد إضافي ولا تكتب أي رد.',
    '٤. اكتب الرد بنفس لغة تعليق المشاهد.',
    '٥. لا تذكر أنك نموذج ذكاء اصطناعي، ولا تستخدم Markdown ولا النقاط ولا الإيموجي.',
    '٦. الرد جملة واحدة إلى ثلاث جمل قصيرة، لأنه تعليق وليس مقالًا.'
  ].join('\n');

  const parts = [];
  parts.push('تعليق المشاهد:\n<<< ' + commentText + ' >>>');
  parts.push(
    'الردود الموجودة على التعليق (لا تعِد أيًا منها):\n' +
    (replies.length > 0
      ? replies
          .map((r, i) => `${i + 1}. [${r.isOwner ? 'صاحب القناة' : 'مشاهد'}]: ${r.text}`)
          .join('\n')
      : '(لا يوجد رد ظاهر)')
  );

  const instruction = String(input?.instruction || '').trim();
  if (instruction) {
    // VERBATIM. This feature is partly "send an instruction to the model"; summarizing what
    // the user wrote is a different feature that fails silently.
    parts.push('تعليمات إضافية من صاحب القناة (اتبعها حرفيًا):\n<<< ' + bound(instruction, 500) + ' >>>');
  }

  parts.push(
    'أجب بكائن JSON فقط:\n' +
    '{"needsFollowup": true|false, "reason": "سبب قصير بالعربية", "draft": "نص الرد الإضافي أو سلسلة فارغة"}\n' +
    'اكتب "draft" فقط عندما تكون needsFollowup هي true.'
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') }
  ];
}

/**
 * Read the model's answer.
 *
 * `needsFollowup` is a STRICT BOOLEAN, read exactly as 20.7 reads `canAnswer`. This field
 * decides whether the creator is shown work to do, so a truthy `1` or the string `"true"`
 * must never be accepted: a model that emits a string where a boolean belongs would
 * otherwise surface every thread in the list.
 *
 * A missing or unusable draft is treated as "no follow-up", not as an empty one. That is the
 * safe direction — an empty draft would show the creator a button that opens an empty reply
 * box.
 *
 * @param {string} raw - the model's raw text
 * @returns {{ok: boolean, needsFollowup: boolean, reason: string, draft: string, error: string}}
 */
export function parseFollowupResult(raw) {
  const empty = {
    ok: false,
    needsFollowup: false,
    reason: '',
    draft: '',
    error: 'FOLLOWUP_PARSE_FAILED'
  };

  if (typeof raw !== 'string' || raw.trim().length === 0) return empty;

  let payload;
  try {
    const text = raw.trim();
    // A top-level ARRAY is rejected, not unwrapped. First-`{`-to-last-`}` would slice
    // `[{...}]` down to its single inner object, which parses and looks entirely valid —
    // and an array is the model offering several candidate replies, of which silently
    // taking the first is a coin flip presented to the creator as its own suggestion.
    // Checked on the trimmed text BEFORE the slice, because after the slice the array's
    // brackets are gone and there is nothing left to notice.
    if (text.startsWith('[')) return empty;

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return empty;
    payload = JSON.parse(text.slice(first, last + 1));
  } catch (_) {
    return empty;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return empty;
  if (payload.needsFollowup !== true) {
    return {
      ok: true,
      needsFollowup: false,
      reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : '',
      draft: '',
      error: ''
    };
  }

  const draft = typeof payload.draft === 'string' ? payload.draft.trim() : '';
  if (!draft) {
    // The model said yes and then wrote nothing. Treat it as no rather than offering an
    // empty reply box.
    return { ok: true, needsFollowup: false, reason: '', draft: '', error: '' };
  }

  return {
    ok: true,
    needsFollowup: true,
    reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 200) : '',
    draft,
    error: ''
  };
}

/**
 * Two follow-up drafts that say the same thing are one follow-up.
 *
 * Offered, not suppressed: the same popular question genuinely deserves one reply, and the
 * creator is the one who knows whether the second viewer is asking about the same thing.
 */
export function isNearDuplicateDraft(a, b, threshold = 0.9) {
  const left = normalizeArabic(String(a || ''));
  const right = normalizeArabic(String(b || ''));
  if (!left || !right) return false;
  if (left === right) return true;

  const leftWords = new Set(left.split(' ').filter(Boolean));
  const rightWords = new Set(right.split(' ').filter(Boolean));
  if (leftWords.size === 0 || rightWords.size === 0) return false;

  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) shared++;
  }
  return shared / Math.min(leftWords.size, rightWords.size) >= threshold;
}
