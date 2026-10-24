/**
 * Answered Follow-up tests — Phase 22
 *
 * The pure module. No chrome, no DOM, no network — which is why it is a module at all:
 * the qualification rule and the prompt are the parts that must not be wrong, and they are
 * the parts that can be tested exhaustively.
 */

import {
  classifyAnsweredComment,
  buildFollowupMessages,
  parseFollowupResult,
  isNearDuplicateDraft,
  MAX_COMMENT_CHARS,
  MAX_QUOTED_REPLIES
} from '../answered-followups.js';

const results = { total: 0, passed: 0, failed: 0 };
const failures = [];

async function runTest(name, fn) {
  results.total++;
  try {
    const outcome = await fn();
    if (outcome === true) {
      results.passed++;
      console.log('  ✓', name);
    } else {
      results.failed++;
      failures.push({ name, reason: String(outcome) });
      console.log('  ✗', name, '—', outcome);
    }
  } catch (error) {
    results.failed++;
    failures.push({ name, reason: error.message });
    console.log('  ✗', name, '— threw:', error.message);
  }
}

function section(title) {
  console.log('\n' + title);
}

// ── 1. who wrote in the thread ────────────────────────────────────────────────

/**
 * The rule the whole feature is built on, and the one that is easiest to get backwards.
 *
 * "A thread with replies" is NOT the feature. "A thread with a reply FROM THE CREATOR" is.
 * A thread where three viewers argued with each other has replies and must not appear.
 */
async function testAThreadWithOnlyViewerRepliesDoesNotQualify() {
  const verdict = classifyAnsweredComment({
    replies: [
      { text: 'agree', isOwner: false },
      { text: 'not agree', isOwner: false }
    ]
  });
  if (verdict.qualified) return 'a thread nobody owned was treated as answered';
  if (!verdict.reason) return 'no reason given — the panel would show a blank';
  return true;
}

async function testAnEmptyThreadDoesNotQualify() {
  const verdict = classifyAnsweredComment({ replies: [] });
  if (verdict.qualified) return 'a thread with no replies qualified';
  if (verdict.replyCount !== 0) return `replyCount was ${verdict.replyCount}`;
  return true;
}

async function testOneOwnerReplyQualifies() {
  const verdict = classifyAnsweredComment({
    replies: [
      { text: 'what is the price?', isOwner: false },
      { text: '350 EGP', isOwner: true }
    ]
  });
  if (!verdict.qualified) return 'a replied-to comment did not qualify';
  if (verdict.ownerReplies !== 1) return `ownerReplies was ${verdict.ownerReplies}`;
  return true;
}

async function testSeveralOwnerRepliesAreCounted() {
  const verdict = classifyAnsweredComment({
    replies: [
      { text: 'a', isOwner: true },
      { text: 'b', isOwner: false },
      { text: 'c', isOwner: true }
    ]
  });
  if (!verdict.qualified) return 'did not qualify';
  if (verdict.ownerReplies !== 2) return `ownerReplies was ${verdict.ownerReplies}`;
  return true;
}

/**
 * A caller that counted owner replies without keeping the bodies must still work — the
 * content script sends both, but the store is also written on paths that only have a count.
 */
async function testAnExplicitOwnerCountIsHonoured() {
  const verdict = classifyAnsweredComment({ replies: [], ownerReplies: 1 });
  if (!verdict.qualified) return 'an explicit count of 1 did not qualify';
  return true;
}

async function testANegativeOrJunkOwnerCountDoesNotQualify() {
  for (const value of [-3, NaN, Infinity, 'yes', null]) {
    const verdict = classifyAnsweredComment({ replies: [], ownerReplies: value });
    if (verdict.qualified) return `ownerReplies=${String(value)} qualified`;
  }
  return true;
}

async function testMissingInputIsNotAThrow() {
  for (const input of [null, undefined, {}, { replies: 'nope' }, { replies: [null, {}] }]) {
    const verdict = classifyAnsweredComment(input);
    if (verdict.qualified) return `${JSON.stringify(input)} qualified`;
  }
  return true;
}

// ── 2. the prompt ─────────────────────────────────────────────────────────────

async function testThePromptSeparatesTheQuestionFromTheExistingReply() {
  const messages = buildFollowupMessages({
    comment: { text: 'بكام الكتاب؟', author: 'أحمد' },
    replies: [{ text: 'السعر 350 جنيه', isOwner: true }]
  });

  const user = messages[messages.length - 1].content;
  // Two labelled blocks, not one blob. The model has to be able to tell what was asked from
  // what was already said — that IS the decision.
  if (!/تعليق المشاهد/.test(user)) return 'no viewer-comment block';
  if (!/الردود الموجودة/.test(user)) return 'no existing-replies block';

  // And the two must not run together, or the model cannot tell them apart at all.
  const viewerAt = user.indexOf('بكام الكتاب؟');
  const replyAt = user.indexOf('السعر 350 جنيه');
  if (viewerAt === -1 || replyAt === -1) return 'text missing from the prompt';
  if (Math.abs(viewerAt - replyAt) < 5) return 'the comment and the reply are glued together';
  return true;
}

async function testTheCreatorReplyIsLabelledAsTheCreators() {
  const messages = buildFollowupMessages({
    comment: { text: 'سؤال' },
    replies: [
      { text: 'رد المذيع', isOwner: true },
      { text: 'رد مشاهد تاني', isOwner: false }
    ]
  });
  const user = messages[messages.length - 1].content;
  if (!/\[صاحب القناة\]/.test(user)) return 'the creator reply is not labelled';
  if (!/\[مشاهد\]/.test(user)) return 'a viewer reply is not labelled';
  return true;
}

/**
 * The instruction is the feature for anyone who uses it. A prompt that summarizes it is a
 * different feature that fails silently — the user asked for something specific and gets a
 * generic draft with nothing saying it was dropped.
 */
async function testTheInstructionReachesTheModelWordForWord() {
  const instruction = 'جاوب بسعر الشحن وخلاص، ومن غير كلام زيادة';
  const messages = buildFollowupMessages({
    comment: { text: 'سؤال' },
    replies: [],
    instruction
  });
  const user = messages[messages.length - 1].content;
  if (user.indexOf(instruction) === -1) return 'the instruction was not passed through';
  return true;
}

async function testAnEmptyInstructionAddsNothing() {
  for (const instruction of ['', '   ', null, undefined]) {
    const messages = buildFollowupMessages({
      comment: { text: 'سؤال' },
      replies: [],
      instruction
    });
    const user = messages[messages.length - 1].content;
    if (/تعليمات إضافية/.test(user)) return `an empty instruction (${JSON.stringify(instruction)} added a block`;
  }
  return true;
}

async function testAnEmptyCommentIsRefused() {
  for (const text of ['', '   ', null, undefined]) {
    let threw = false;
    try {
      buildFollowupMessages({ comment: { text }, replies: [] });
    } catch (_) {
      threw = true;
    }
    if (!threw) return `an empty comment (${JSON.stringify(text)}) built a prompt`;
  }
  return true;
}

/**
 * A comment cut mid-sentence with no marker reads as a complete question, and the model
 * drafts a reply to something nobody asked.
 */
async function testALongCommentIsMarkedAsTruncated() {
  const long = 'س '.repeat(Math.ceil(MAX_COMMENT_CHARS / 2) + 50);
  const messages = buildFollowupMessages({ comment: { text: long }, replies: [] });
  const user = messages[messages.length - 1].content;
  if (user.indexOf('…') === -1) return 'a truncated comment carried no truncation marker';
  return true;
}

async function testOnlyABoundedNumberOfRepliesAreQuoted() {
  const replies = Array.from({ length: 20 }, (_, i) => ({ text: `reply ${i}`, isOwner: i === 0 }));
  const messages = buildFollowupMessages({ comment: { text: 'سؤال' }, replies });
  const user = messages[messages.length - 1].content;
  const quoted = (user.match(/reply \d+/g) || []).length;
  if (quoted > MAX_QUOTED_REPLIES) return `${quoted} replies were quoted, bound is ${MAX_QUOTED_REPLIES}`;
  return true;
}

async function testAThreadWithNoRepliesStillBuilds() {
  const messages = buildFollowupMessages({ comment: { text: 'سؤال' }, replies: [] });
  const user = messages[messages.length - 1].content;
  if (!/لا يوجد رد ظاهر/.test(user)) return 'an unreplied thread did not say so';
  return true;
}

// ── 3. reading the answer ─────────────────────────────────────────────────────

/**
 * STRICT BOOLEAN, exactly as 20.7 reads `canAnswer`.
 *
 * This field decides whether the creator is shown work to do. A model that emits `1` or
 * `"true"` where a boolean belongs would otherwise fill the panel with every thread on the
 * page, and the creator would learn to ignore it.
 */
async function testNeedsFollowupIsAStrictBoolean() {
  for (const value of [1, 'true', 'yes', 'no', 0, {}, []]) {
    const parsed = parseFollowupResult(
      JSON.stringify({ needsFollowup: value, reason: 'r', draft: 'x' })
    );
    if (parsed.needsFollowup) return `${JSON.stringify(value)} was accepted as true`;
  }
  return true;
}

async function testAFollowUpNeedsADraft() {
  const parsed = parseFollowupResult(JSON.stringify({ needsFollowup: true, reason: 'r' }));
  if (parsed.needsFollowup) return 'a follow-up with no draft was offered';
  if (!parsed.ok) return 'a well-formed answer was reported as a parse failure';
  return true;
}

async function testABlankDraftIsNotOffered() {
  for (const draft of ['', '   ', null, 42, {}]) {
    const parsed = parseFollowupResult(
      JSON.stringify({ needsFollowup: true, reason: 'r', draft })
    );
    if (parsed.needsFollowup) return `draft=${JSON.stringify(draft)} was offered`;
  }
  return true;
}

async function testNoFollowUpIsAValidAnswerNotAFailure() {
  const parsed = parseFollowupResult(
    JSON.stringify({ needsFollowup: false, reason: 'الرد كافٍ', draft: '' })
  );
  if (!parsed.ok) return `error=${parsed.error}`;
  if (parsed.needsFollowup) return 'a "no" was read as a "yes"';
  if (parsed.reason !== 'الرد كافٍ') return `the reason was lost: ${parsed.reason}`;
  return true;
}

async function testJsonInProseIsStillParsed() {
  const raw = 'تمام، هذا ردّي:\n```json\n{"needsFollowup": true, "reason": "r", "draft": "الجواب"}\n```';
  const parsed = parseFollowupResult(raw);
  if (!parsed.needsFollowup) return 'a fenced answer was not read';
  if (parsed.draft !== 'الجواب') return `the draft was wrong: ${parsed.draft}`;
  return true;
}

/**
 * A top-level array is REJECTED, not unwrapped. First-{ to last-} turns
 * `[{"needsFollowup":true,...}]` into the INNER object, which parses and looks valid — and
 * an array is the model offering several candidates, of which taking the first is a coin
 * flip.
 */
async function testATopLevelArrayIsRejected() {
  const parsed = parseFollowupResult('[{"needsFollowup": true, "draft": "x"}]');
  if (parsed.ok) return 'an array was unwrapped into its first element';
  return true;
}

async function testUnreadableAnswersAreRejectedNotGuessed() {
  for (const raw of ['', '   ', 'no json here', '{broken', null, undefined, 42, '{]']) {
    const parsed = parseFollowupResult(raw);
    if (parsed.ok) return `${JSON.stringify(raw)} parsed`;
    if (parsed.error !== 'FOLLOWUP_PARSE_FAILED') return `unexpected error ${parsed.error}`;
  }
  return true;
}

async function testAReasonIsBounded() {
  const parsed = parseFollowupResult(
    JSON.stringify({ needsFollowup: true, reason: 'x'.repeat(5000), draft: 'y' })
  );
  if (parsed.reason.length > 200) return `the reason ran to ${parsed.reason.length} chars`;
  return true;
}

// ── 4. similar drafts ─────────────────────────────────────────────────────────

/**
 * Offered, not suppressed. Two viewers asking the same popular question genuinely deserve
 * one reply, and only the creator knows whether it is the same person twice.
 *
 * Note what is NOT asserted: "ثلاثمائة وخمسون جنيه" against "350 جنيه". The normalizer
 * folds DIACRITICS and DIGIT FORMS, not number WORDS, so those two stay distinct here —
 * and that is the correct direction. This check warns; a false positive costs the creator a
 * glance, and a check tuned to catch every phrasing of a number would warn on everything.
 */
async function testSimilarDraftsAreFlagged() {
  const a = 'السعر ثلاثمائة وخمسون جنيه';
  if (!isNearDuplicateDraft(a, a)) return 'identical drafts were not flagged';
  if (!isNearDuplicateDraft(a, '  السعر   ثلاثمائة وخمسون جنيه  ')) {
    return 'a whitespace-only difference was not flagged';
  }
  // Arabic-Indic digits fold to ASCII, so this pair IS the same answer to a human reader.
  if (!isNearDuplicateDraft('السعر ٣٥٠ جنيه', 'السعر 350 جنيه')) {
    return 'Arabic-Indic digits were not folded';
  }
  return true;
}

async function testADifferentPhrasingIsNotFlagged() {
  if (isNearDuplicateDraft('السعر ثلاثمائة وخمسون جنيه', 'السعر 350 جنيه')) {
    return 'a number-word / digit pair was treated as identical';
  }
  return true;
}

async function testDifferentDraftsAreNotFlagged() {
  if (isNearDuplicateDraft('السعر ثلاثمائة وخمسون جنيه', 'الشحن بياخد يومين عمل')) {
    return 'two different answers were flagged';
  }
  return true;
}

async function testAnEmptyDraftIsNeverADuplicate() {
  if (isNearDuplicateDraft('', 'x')) return 'an empty draft was a duplicate';
  if (isNearDuplicateDraft('x', '')) return 'an empty target was a duplicate';
  if (isNearDuplicateDraft('', '')) return 'two empty drafts were duplicates';
  return true;
}

export default async function runAllTests() {
  console.log('=== Answered Follow-up Tests (Phase 22) ===');

  section('Who wrote in the thread');
  await runTest('A thread with only viewer replies does not qualify', testAThreadWithOnlyViewerRepliesDoesNotQualify);
  await runTest('An empty thread does not qualify', testAnEmptyThreadDoesNotQualify);
  await runTest('One owner reply qualifies', testOneOwnerReplyQualifies);
  await runTest('Several owner replies are counted', testSeveralOwnerRepliesAreCounted);
  await runTest('An explicit owner count is honoured', testAnExplicitOwnerCountIsHonoured);
  await runTest('A negative or junk owner count does not qualify', testANegativeOrJunkOwnerCountDoesNotQualify);
  await runTest('Missing input is not a throw', testMissingInputIsNotAThrow);

  section('The prompt');
  await runTest('The prompt separates the question from the existing reply', testThePromptSeparatesTheQuestionFromTheExistingReply);
  await runTest('The creator reply is labelled as the creator\'s', testTheCreatorReplyIsLabelledAsTheCreators);
  await runTest('The instruction reaches the model word for word', testTheInstructionReachesTheModelWordForWord);
  await runTest('An empty instruction adds nothing', testAnEmptyInstructionAddsNothing);
  await runTest('An empty comment is refused', testAnEmptyCommentIsRefused);
  await runTest('A long comment is marked as truncated', testALongCommentIsMarkedAsTruncated);
  await runTest('Only a bounded number of replies are quoted', testOnlyABoundedNumberOfRepliesAreQuoted);
  await runTest('A thread with no replies still builds', testAThreadWithNoRepliesStillBuilds);

  section('Reading the answer');
  await runTest('needsFollowup is a strict boolean', testNeedsFollowupIsAStrictBoolean);
  await runTest('A follow-up needs a draft', testAFollowUpNeedsADraft);
  await runTest('A blank draft is not offered', testABlankDraftIsNotOffered);
  await runTest('"No follow-up" is a valid answer, not a failure', testNoFollowUpIsAValidAnswerNotAFailure);
  await runTest('JSON in prose is still parsed', testJsonInProseIsStillParsed);
  await runTest('A top-level array is rejected', testATopLevelArrayIsRejected);
  await runTest('Unreadable answers are rejected, not guessed', testUnreadableAnswersAreRejectedNotGuessed);
  await runTest('A reason is bounded', testAReasonIsBounded);

  section('Similar drafts');
  await runTest('Similar drafts are flagged', testSimilarDraftsAreFlagged);
  await runTest('A different phrasing is not flagged', testADifferentPhrasingIsNotFlagged);
  await runTest('Different drafts are not flagged', testDifferentDraftsAreNotFlagged);
  await runTest('An empty draft is never a duplicate', testAnEmptyDraftIsNeverADuplicate);

  return results;
}
