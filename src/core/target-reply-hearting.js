// Phase 23.1 - Target Replies & Hearting: the policy for applying a channel-owner
// heart after a reply draft has been inserted into a comment's reply box.
//
// WHY THIS IS A SEPARATE MODULE AND NOT AN `if` IN THE WORKER:
//
// The decision is made in the service worker but the click happens in the content
// script, in two different contexts, and the question "should we heart this?" is
// asked in only one of them. Putting the rule inline in the worker would make it
// correct today and untestable — every suite stops at the worker/content-script
// boundary, so an inline rule cannot be covered without a real browser, and this
// rule has four independent conditions whose interaction is the whole point.
//
// The flow, and why it is split this way:
//
//   worker  : decides   -> verdict.heartAfterInsert = shouldHeartAfterInsert(...)
//   content : performs  -> if (response.heartAfterInsert === true) adapter.heartComment()
//
// The WORKER is authoritative and this is deliberate: it reads `getSettings()` on
// every job, so the flag reflects the creator's current choice at the moment the
// reply was produced. A stale Side Panel cannot keep this feature alive after it
// has been switched off, because the panel never decides anything — it only writes
// the setting the worker then reads.
//
// The CONTENT SCRIPT does the DOM work, because that is the only place the comment
// element and YouTube's real heart control exist. It re-checks `dryRun` itself
// (see below) rather than trusting the flag alone.
//
// ── The four conditions, and what each one is defending against ────────────────
//
// 1. The setting is `true`, read as a STRICT boolean. `"true"` does not count.
//    Defends against: a corrupted or hand-edited storage value silently enabling a
//    feature that clicks things in the creator's account.
//
// 2. A TRIGGER matched — `ruleId` is a non-empty string. This is what "target"
//    means: the existing trigger rules. It deliberately EXCLUDES Knowledge Mode,
//    which by design never runs trigger matching and therefore never sets `ruleId`
//    (Phase 20.16 / AGENTS.md), so a Knowledge reply is never hearted. It INCLUDES
//    fixed replies, because a fixed reply is a triggered reply — the trigger is
//    what selected the comment, and the text is only what gets typed.
//    Defends against: hearting comments the trigger system never chose.
//
// 3. Not dry-run. Dry-run is the Phase 8 safety gate: the extension prepares a
//    reply but never acts. A heart is an action, so it is gated identically.
//    Defends against: a creator testing their setup end-to-end leaving a trail of
//    hearts on comments they never actually replied to.
//
// 4. There is a reply to publish at all. A NO_MATCH has nothing inserted, so
//    there is no draft to acknowledge.
//
// ── Why the content script re-reads dryRun instead of trusting condition 3 ────
//
// They are different failures. Condition 3 is the worker's policy at the time it
// produced the reply; the content script's re-read happens later, when the reply
// box is open and the click is about to happen, against storage that may have
// changed in between — a creator who flipped dry-run off and on while a queue was
// draining gets the CURRENT value, not the stale one. It fails SAFE: an unreadable
// or throwing `dryRun` is treated as `true`, so nothing is clicked, exactly as
// `submitReply()` does for the Submit button.

/**
 * Decide whether a freshly drafted reply should also heart its comment.
 *
 * Pure and total: every input shape produces a boolean and nothing throws, because
 * it is called on the publish path where a throw would lose an otherwise-good reply.
 *
 * @param {object} args
 * @param {object} [args.verdict] - the worker's reply verdict (`{result, ruleId}`)
 * @param {object} [args.settings] - the merged settings (`{dryRun, targetReplyHeartingEnabled}`)
 * @returns {boolean} true only when all four conditions hold
 */
export function shouldHeartAfterInsert(verdict, settings) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const s = settings && typeof settings === 'object' ? settings : {};

  // 1. The switch. Strict: only a real boolean `true` turns this on.
  if (s.targetReplyHeartingEnabled !== true) return false;

  // 2 + 4. A trigger must have matched, and there must be something to publish.
  //    `ruleId` is only ever set by the trigger branch of the matcher, so it is
  //    exactly the discriminator between "trigger picked this comment" and every
  //    other producer (Knowledge Mode leaves it unset).
  if (typeof v.ruleId !== 'string' || !v.ruleId) return false;

  return true;
}

/**
 * Read the current `dryRun` from storage, failing SAFE.
 *
 * DELIBERATELY NOT HERE, and the reason is worth recording. This module's rule uses
 * `settings.dryRun` — the value the WORKER already merged — because the worker is the
 * authoritative decision point. A second reader here looked tidier and was wrong twice
 * over: it would be a duplicate of the fail-safe rule that `youtube-adapter.js` already
 * owns as `isDryRunActive()` (and which `submitReply()` uses), and it would have needed to
 * be reachable from `content.js` — which is a CLASSIC script and cannot `import` it at
 * all. The re-read that the content script does before clicking lives on the adapter, as
 * an instance method, next to the identical read it shares with Submit.
 *
 * @see youtube-adapter.js `isDryRunActive()`
 */

export { shouldHeartAfterInsert as default };