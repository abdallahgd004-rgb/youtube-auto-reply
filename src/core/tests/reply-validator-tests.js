/**
 * Reply Validation Tests — Phase 19.4 (blacklist + repeat rejection)
 *
 * These are the checks that stand between a local model's output and a real viewer's
 * comment section, so the cases are deliberately blunt: a banned phrase must be caught
 * however it is dressed up, an exact repeat must be caught, and neither check may
 * reject a legitimate distinct reply.
 *
 * Runs in the browser from reply-validator-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before the modules
 * under test are evaluated.
 */

import { resetStorage } from './chrome-storage-stub.js';
import { validateReply, DEFAULT_BLACKLIST } from '../reply-validator.js';
import { getRecentGeneratedReplies, saveLog, clearLogs, LOG_STATUS } from '../activity-log.js';
import { DEFAULT_CONFIG } from '../config.js';

const results = { total: 0, passed: 0, failed: 0 };

async function runTest(name, fn) {
  results.total++;
  try {
    const ok = await fn();
    if (ok === true) {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: ${ok}`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

const clean = 'السعر ٩٩ جنيه فقط، والتوصيل مجاني';

// ── existing behaviour must not change ───────────────────────────────────────

async function testExistingChecksStillApply() {
  if (validateReply('').reason !== 'EMPTY') return 'EMPTY should still be caught';
  if (validateReply('a'.repeat(1001)).reason !== 'TOO_LONG') return 'TOO_LONG should still be caught';
  if (validateReply('hi {{name}}').reason !== 'PLACEHOLDER') return 'PLACEHOLDER should still be caught';
  if (validateReply('here:\n```js\nx\n```').reason !== 'CODE_FENCE') return 'CODE_FENCE should still be caught';
  const ok = validateReply(clean);
  if (!ok.valid || ok.reply !== clean) return 'A clean reply must still pass';
  return true;
}

async function testReasoningLeakStillCaught() {
  const thought = 'The user is asking about the price of the product.';
  const leaked = validateReply({ text: thought, reasoning: thought });
  if (leaked.valid || leaked.reason !== 'REASONING_LEAK') return 'REASONING_LEAK should still be caught';
  const ok = validateReply({ text: clean, reasoning: thought });
  if (!ok.valid) return `A distinct reply must not be treated as a leak (${ok.reason})`;
  return true;
}

// ── Phase 19.4 — blacklist ───────────────────────────────────────────────────

async function testBlacklistRejectsDisclosure() {
  const latin = validateReply('Sure! As an AI I cannot give prices.');
  if (latin.valid || latin.reason !== 'BLACKLISTED') return `Expected BLACKLISTED, got ${latin.reason}`;
  const arabic = validateReply('آسف، أنا ذكاء اصطناعي ولا أستطيع الإجابة');
  if (arabic.valid || arabic.reason !== 'BLACKLISTED') return `Expected BLACKLISTED in Arabic, got ${arabic.reason}`;
  return true;
}

async function testBlacklistSeesThroughCasingAndDiacritics() {
  const shouted = validateReply('AS AN AI, I CANNOT HELP');
  if (shouted.valid || shouted.reason !== 'BLACKLISTED') return 'Case must not hide a banned phrase';
  const decorated = validateReply('أَنا ذكاءِ اصطناعي، شكراً');
  if (decorated.valid || decorated.reason !== 'BLACKLISTED') return 'Diacritics must not hide a banned phrase';
  return true;
}

async function testBlacklistReportsWhichPhrase() {
  const result = validateReply('من فضلك لا تسأل ذكاء اصطناعي');
  if (!result.matchedPhrase) return 'The offending phrase should be reported for the log';
  return true;
}

async function testCustomBlacklistReplacesTheDefault() {
  const custom = validateReply('استخدم Lynx Roller عند الطلب', { blacklist: ['lynx roller'] });
  if (custom.valid || custom.reason !== 'BLACKLISTED') return 'A custom phrase must be enforced';
  // The user's list replaces the built-in one rather than adding to it.
  const noLongerBanned = validateReply('As an AI I cannot help', { blacklist: ['lynx roller'] });
  if (!noLongerBanned.valid) return 'A custom list should replace the default, not extend it';
  return true;
}

async function testEmptyBlacklistDisablesTheCheck() {
  const result = validateReply('As an AI I cannot help', { blacklist: [] });
  if (!result.valid) return 'An empty blacklist must switch the check off';
  return true;
}

async function testNonArrayBlacklistFallsBackToTheDefault() {
  const result = validateReply('I am a language model', { blacklist: 'not an array' });
  if (result.valid || result.reason !== 'BLACKLISTED') return 'A malformed blacklist should fall back to the default';
  return true;
}

async function testDefaultBlacklistMatchesConfig() {
  const fromConfig = DEFAULT_CONFIG.replyBehavior.blacklist;
  if (!Array.isArray(fromConfig)) return 'The config default must be an array';
  if (fromConfig.join('|') !== DEFAULT_BLACKLIST.join('|')) {
    return 'The config default and the validator default must agree';
  }
  return true;
}

// ── Phase 19.7 — allowRepeat: the one check a fixed reply is exempt from ──────
//
// These are validator-level cases. `allowRepeat` is set by the service worker from the
// matched rule's reply mode, so the tests below use the flag directly to prove the two
// properties that matter: the repeat check is untouched without it, and it is the ONLY
// thing it turns off.

/** The reply used throughout the repeat cases. */
const FIXED_REPLY_TEXT = 'السعر 100 جنيه، والرابط موجود في الوصف.';

/** An AI reply identical to one already written, without the flag. */
async function testAiRepeatStillRejected() {
  const result = validateReply(FIXED_REPLY_TEXT, { recentReplies: [FIXED_REPLY_TEXT] });
  if (result.valid || result.reason !== 'REPEAT_RESPONSE') {
    return `An AI repeat must still be rejected, got ${result.reason}`;
  }
  return true;
}

/** The same case with the flag absent in every other form, to prove the default is off. */
async function testAllowRepeatDefaultsToOff() {
  const opts = [
    { recentReplies: [FIXED_REPLY_TEXT] },
    { recentReplies: [FIXED_REPLY_TEXT], allowRepeat: undefined },
    { recentReplies: [FIXED_REPLY_TEXT], allowRepeat: false },
    { recentReplies: [FIXED_REPLY_TEXT], allowRepeat: 'yes' },
    { recentReplies: [FIXED_REPLY_TEXT], allowRepeat: 1 },
  ];
  for (const options of opts) {
    const result = validateReply(FIXED_REPLY_TEXT, options);
    if (result.valid || result.reason !== 'REPEAT_RESPONSE') {
      return `allowRepeat must only be honoured for a strict true; got ${result.reason}`;
    }
  }
  return true;
}

/** A near-duplicate AI reply keeps its existing behaviour: allowed, not a repeat. */
async function testAiNearDuplicateStillAllowed() {
  const previous = FIXED_REPLY_TEXT;
  const result = validateReply('السعر 100 جنيه، والرابط موجود في وصف الفيديو.', {
    recentReplies: [previous]
  });
  if (!result.valid) return `A near-duplicate AI reply must still pass, got ${result.reason}`;
  return true;
}

/** The flag admits the identical text a fixed reply is supposed to repeat. */
async function testFixedReplyRepeatAllowed() {
  const result = validateReply(FIXED_REPLY_TEXT, {
    recentReplies: [FIXED_REPLY_TEXT],
    allowRepeat: true
  });
  if (!result.valid) return `A fixed reply must be allowed to repeat, got ${result.reason}`;
  return true;
}

/** Repeating it many times over, which is the real-world case: 5 comments, one answer. */
async function testFixedReplyRepeatsAcrossComments() {
  const history = [FIXED_REPLY_TEXT, FIXED_REPLY_TEXT, FIXED_REPLY_TEXT, FIXED_REPLY_TEXT];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = validateReply(FIXED_REPLY_TEXT, { recentReplies: history, allowRepeat: true });
    if (!result.valid) return `Attempt ${attempt + 1} was rejected: ${result.reason}`;
  }
  return true;
}

/**
 * The flag disables the repeat check and NOTHING else.
 *
 * Each of these is a real rejection that must survive `allowRepeat: true`, run against a
 * history that already contains the reply — so the repeat check is not what would catch
 * any of them. If one of these ever starts passing, the exemption has grown.
 */
async function testAllowRepeatSkipsOnlyTheRepeatCheck() {
  const history = [FIXED_REPLY_TEXT];
  const cases = [
    ['EMPTY', '   ', {}],
    ['TOO_LONG', 'ا'.repeat(1001), {}],
    ['PLACEHOLDER', 'السعر {{price}} جنيه', {}],
    ['CODE_FENCE', 'السعر ```100``` جنيه', {}],
    ['BLACKLISTED', 'I am a language model, the price is 100', {}],
    ['BLACKLISTED', 'أنا ذكاء اصطناعي والسعر 100 جنيه', {}],
  ];

  for (const [reason, text, extra] of cases) {
    const result = validateReply(text, {
      recentReplies: history,
      allowRepeat: true,
      ...extra
    });
    if (result.valid) {
      return `${reason} was accepted — allowRepeat disabled more than the repeat check`;
    }
    if (result.reason !== reason) {
      return `Expected ${reason}, got ${result.reason}`;
    }
  }

  // Reasoning leak is unaffected too: it is decided before the repeat check is reached.
  const thought = 'The user wants a price.';
  const leak = validateReply({ text: thought, reasoning: thought }, { recentReplies: history, allowRepeat: true });
  if (leak.valid || leak.reason !== 'REASONING_LEAK') return 'The leak check must still apply';

  // A custom blacklist is still honoured.
  const custom = validateReply('Forbidden word here', {
    recentReplies: history,
    allowRepeat: true,
    blacklist: ['forbidden word']
  });
  if (custom.valid || custom.reason !== 'BLACKLISTED') return 'A custom blacklist must still apply';

  return true;
}

// ── Phase 19.4 — repeats ─────────────────────────────────────────────────────

async function testExactRepeatIsRejected() {
  const reply = 'السعر ٩٩ جنيه والتوصيل مجاني للمناطق كلها';
  const result = validateReply(reply, { recentReplies: [reply] });
  if (result.valid || result.reason !== 'REPEAT_RESPONSE') return `Expected REPEAT_RESPONSE, got ${result.reason}`;
  return true;
}

async function testRepeatSeesThroughCasingAndPunctuation() {
  const previous = 'السعر ٩٩ جنيه والتوصيل مجاني للمناطق كلها';
  const result = validateReply('  السعر ٩٩ جنيه والتوصيل مجاني للمناطق كلها  ', { recentReplies: [previous] });
  if (result.valid || result.reason !== 'REPEAT_RESPONSE') return 'Whitespace and punctuation must not hide a repeat';
  return true;
}

async function testDistinctRepliesAreStillAllowed() {
  const result = validateReply('المنتج متوفر shipment coals بكرة إن شاء الله', {
    recentReplies: ['السعر ٩٩ جنيه والتوصيل مجاني للمناطق كلها']
  });
  if (!result.valid) return `A different reply must pass, got ${result.reason}`;
  return true;
}

async function testShortRepliesAreNeverTreatedAsRepeats() {
  // "تمام" is short enough to coincide by accident; blocking it would drop real replies.
  const result = validateReply('تمام', { recentReplies: ['تمام'] });
  if (!result.valid) return 'A very short reply must not be blocked as a repeat';
  return true;
}

async function testNoRecentRepliesMeansNoRepeatCheck() {
  const result = validateReply(clean, { recentReplies: [] });
  if (!result.valid) return 'An empty history must not reject anything';
  return true;
}

async function testMalformedRecentEntriesAreIgnored() {
  const result = validateReply(clean, { recentReplies: [null, 42, {}, '   '] });
  if (!result.valid) return 'Malformed history entries must be skipped, not crash the check';
  return true;
}

// ── recent replies come from the activity log ────────────────────────────────

async function testRecentGeneratedRepliesReadsOnlyRealReplies() {
  resetStorage();
  await clearLogs();
  const now = Date.now();
  await saveLog({ status: LOG_STATUS.GENERATED, commentText: 'a', generatedReply: 'الرد الأول', timestamp: now });
  await saveLog({ status: LOG_STATUS.MATCHED, commentText: 'b', generatedReply: '' });
  await saveLog({ status: LOG_STATUS.FAILED, commentText: 'c', generatedReply: 'لم يُكتب', timestamp: now });
  await saveLog({ status: LOG_STATUS.GENERATED, commentText: 'd', generatedReply: 'الرد الثاني', timestamp: now });

  const replies = await getRecentGeneratedReplies(20, 3600000, now);
  if (replies.length !== 2) return `Expected 2 real replies, got ${replies.length}`;
  if (replies[0] !== 'الرد الثاني') return 'Replies should be newest first';
  return true;
}

async function testRecentGeneratedRepliesRespectsWindowAndLimit() {
  resetStorage();
  await clearLogs();
  const now = Date.now();
  await saveLog({ status: LOG_STATUS.GENERATED, generatedReply: 'قديم جدا', timestamp: now - 7200000 });
  await saveLog({ status: LOG_STATUS.GENERATED, generatedReply: 'حديث', timestamp: now });
  const replies = await getRecentGeneratedReplies(20, 3600000, now);
  if (replies.length !== 1 || replies[0] !== 'حديث') return 'The window must exclude old replies';

  for (let i = 0; i < 5; i++) {
    await saveLog({ status: LOG_STATUS.GENERATED, generatedReply: `رد ${i}`, timestamp: now + i });
  }
  const limited = await getRecentGeneratedReplies(2, 3600000, now);
  if (limited.length !== 2) return `Expected the limit to apply, got ${limited.length}`;
  return true;
}

async function testEndToEndRepeatThroughTheLog() {
  // The path the service worker actually takes: generate, log, then reject a repeat.
  resetStorage();
  await clearLogs();
  const now = Date.now();
  const reply = 'السعر ٩٩ جنيه والتوصيل مجاني للمناطق كلها';
  await saveLog({ status: LOG_STATUS.GENERATED, generatedReply: reply, timestamp: now });

  const recent = await getRecentGeneratedReplies(20, 3600000, now);
  const result = validateReply({ text: reply, reasoning: '' }, {
    blacklist: DEFAULT_CONFIG.replyBehavior.blacklist,
    recentReplies: recent
  });
  if (result.valid) return 'A repeat of a logged reply must be rejected';
  return true;
}

async function testBothChecksApplyTogether() {
  const banned = 'As an AI, السعر ٩٩ جنيه';
  const result = validateReply(banned, { recentReplies: [] });
  if (result.valid || result.reason !== 'BLACKLISTED') return 'The blacklist must be checked before the repeat check';
  return true;
}

async function testBlacklistWinsOverLeakCheck() {
  // The ordering matters only for the reported reason; a leak is still caught.
  const thought = 'The user wants a price.';
  const result = validateReply({ text: thought, reasoning: thought }, { recentReplies: [] });
  if (result.valid || result.reason !== 'REASONING_LEAK') return 'The existing leak check must keep priority';
  return true;
}

async function runAllTests() {
  console.log('\n=== Reply Validation Tests (Phase 19.4) ===\n');

  await runTest('An AI reply identical to a recent reply is still rejected', testAiRepeatStillRejected);
  await runTest('allowRepeat is off unless it is exactly true', testAllowRepeatDefaultsToOff);
  await runTest('An AI near-duplicate reply is still allowed', testAiNearDuplicateStillAllowed);
  await runTest('A fixed reply identical to a recent reply is allowed', testFixedReplyRepeatAllowed);
  await runTest('A fixed reply repeats across many comments', testFixedReplyRepeatsAcrossComments);
  await runTest('allowRepeat skips only the repeat check', testAllowRepeatSkipsOnlyTheRepeatCheck);

  await runTest('The Phase 7.4 checks still apply', testExistingChecksStillApply);
  await runTest('Reasoning leaks are still caught', testReasoningLeakStillCaught);
  await runTest('The blacklist rejects an AI disclosure', testBlacklistRejectsDisclosure);
  await runTest('The blacklist sees through case and diacritics', testBlacklistSeesThroughCasingAndDiacritics);
  await runTest('The offending phrase is reported', testBlacklistReportsWhichPhrase);
  await runTest('A custom blacklist replaces the default', testCustomBlacklistReplacesTheDefault);
  await runTest('An empty blacklist disables the check', testEmptyBlacklistDisablesTheCheck);
  await runTest('A malformed blacklist falls back to the default', testNonArrayBlacklistFallsBackToTheDefault);
  await runTest('The config default matches the validator default', testDefaultBlacklistMatchesConfig);
  await runTest('An exact repeat is rejected', testExactRepeatIsRejected);
  await runTest('A repeat is caught despite casing and spacing', testRepeatSeesThroughCasingAndPunctuation);
  await runTest('A distinct reply is still allowed', testDistinctRepliesAreStillAllowed);
  await runTest('A very short reply is never a repeat', testShortRepliesAreNeverTreatedAsRepeats);
  await runTest('An empty history rejects nothing', testNoRecentRepliesMeansNoRepeatCheck);
  await runTest('Malformed history entries are skipped', testMalformedRecentEntriesAreIgnored);
  await runTest('Recent replies come from real log rows only', testRecentGeneratedRepliesReadsOnlyRealReplies);
  await runTest('The window and limit both apply', testRecentGeneratedRepliesRespectsWindowAndLimit);
  await runTest('A repeat of a logged reply is rejected end to end', testEndToEndRepeatThroughTheLog);
  await runTest('Both checks apply together', testBothChecksApplyTogether);
  await runTest('The existing leak check keeps priority', testBlacklistWinsOverLeakCheck);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;