/**
 * Fixed Reply Tests
 *
 * Phase 19.6 — the "Fixed reply" reply type for triggers.
 *
 * The claim under test is narrow and absolute: a trigger in fixed mode publishes the
 * user's text EXACTLY as written, and LM Studio is not asked to write it. Everything else
 * about the pipeline — matching, validation, queueing, delays, rate limits, dry-run and
 * publishing — must behave as it did before, which is why several cases here assert that
 * the surrounding steps still ran rather than only that the reply came out right.
 *
 * Three layers, mirroring how the feature is actually built:
 *
 *  1. core/fixed-reply.js — the resolver. Pure, no storage, no DOM.
 *  2. trigger CRUD + storage — what is persisted, and what is refused.
 *  3. sw-processing-harness.js — the background flow, with the real semantic matcher and
 *     the real reply-mode resolver underneath it.
 *
 * Runs in the browser from fixed-reply-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before storage.js is
 * evaluated.
 */

import { resetStorage, readStore } from './chrome-storage-stub.js';
import {
  REPLY_MODES,
  VALID_REPLY_MODES,
  resolveReplyMode,
  getFixedReplyText,
  hasUsableFixedReply,
  resolveReplySource,
  validateFixedReply,
  validateReplyFields
} from '../fixed-reply.js';
import { addTrigger, updateTrigger, getTriggers } from '../trigger-crud.js';
import { DEFAULT_TRIGGER_RULE } from '../trigger-schema.js';
import { resetProcessingStats, getProcessingState, hasHandoff, OUTCOME } from '../processing-stats.js';
import {
  configure,
  deps,
  processJob,
  publishReply,
  getDiagEvents,
  resetDiagEvents,
  resetPendingHandled
} from './sw-processing-harness.js';
import { handleAddTrigger, readTriggerReplyMode, setTriggerReplyMode } from '../../options/options.js';

const results = { total: 0, passed: 0, failed: 0 };

/**
 * Run one async test case. Returns true for a pass, or a string explaining the failure.
 */
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

/**
 * A fixed reply with the awkward characters the feature promises to preserve: Arabic
 * punctuation, an emoji, a percent sign, a colon, and an internal line break.
 */
const AWKWARD_REPLY = 'السعر 100 جنيه، والرابط موجود في الوصف.\nشحن مجاني 🚀  ٢٠%خصم: Expires soon.';

/** Reset storage and the processing-state model between cases. */
function fresh() {
  resetStorage();
  resetProcessingStats();
  resetDiagEvents();
  // In-flight handoffs are cleared too: an entry left by an earlier case would be consumed
  // by this one's publish and write a handled record it never earned.
  resetPendingHandled();
  // `useRealValidator` and `recentReplies` reset too: they are set per-case by the Phase
  // 19.7 group, and leaking either into a later case would change what it is testing.
  configure({
    enabled: true,
    dryRun: false,
    triggers: [],
    // Phase 19.8 — the handled store is a fingerprint-keyed Map, like the real
    // handled-comments.js. It was a Set, which cannot carry the fingerprint that gets
    // marked on a real publish.
    handled: new Map(),
    markHandledCalls: [],
    hasGeneration: () => false,
    onGenerate: null,
    validate: { valid: true, reply: 'reply' },
    useRealValidator: false,
    recentReplies: [],
    blacklist: null
  });
}

/** A trigger that matches everything, so only the surrounding flow is under test. */
function matchAllRule(overrides = {}) {
  return {
    id: 'rule-fixed',
    enabled: true,
    phrases: ['بكام'],
    matchMode: 'contains',
    caseSensitive: false,
    ...overrides
  };
}

/**
 * A rule with NO replyMode at all — the exact shape of every trigger stored before
 * Phase 19.6. Used to prove backward compatibility rather than to prove the new fields
 * work.
 */
function legacyRule(overrides = {}) {
  return {
    id: 'rule-legacy',
    enabled: true,
    phrases: ['السعر'],
    matchMode: 'contains',
    caseSensitive: false,
    ...overrides
  };
}

// ── 1. backward compatibility: no replyMode means AI ──────────────────────────

/**
 * A rule carrying no replyMode resolves to AI, so every pre-19.6 trigger keeps asking
 * LM Studio for a reply.
 */
function testLegacyRuleDefaultsToAi() {
  const mode = resolveReplyMode(legacyRule());
  if (mode !== REPLY_MODES.AI) {
    return `Expected "${REPLY_MODES.AI}", got "${mode}"`;
  }

  const source = resolveReplySource(legacyRule());
  if (source.mode !== REPLY_MODES.AI) {
    return `Expected an AI source, got "${source.mode}"`;
  }
  if (source.text !== '') {
    return 'An AI source must carry no text';
  }
  return true;
}

/**
 * The schema default agrees, and the stored value of an untouched rule is unchanged in
 * every field that existed before Phase 19.6.
 */
function testLegacyFieldsUntouched() {
  if (DEFAULT_TRIGGER_RULE.replyMode !== REPLY_MODES.AI) {
    return `Schema default replyMode is "${DEFAULT_TRIGGER_RULE.replyMode}"`;
  }
  if (DEFAULT_TRIGGER_RULE.fixedReply !== '') {
    return 'Schema default fixedReply is not empty';
  }
  if (resolveReplyMode(undefined) !== REPLY_MODES.AI) return 'undefined rule should resolve to AI';
  if (resolveReplyMode(null) !== REPLY_MODES.AI) return 'null rule should resolve to AI';
  if (resolveReplyMode({ replyMode: 'nonsense' }) !== REPLY_MODES.AI) {
    return 'an unknown replyMode must fall back to AI, not disable generation';
  }
  if (resolveReplyMode({ replyMode: 42 }) !== REPLY_MODES.AI) {
    return 'a non-string replyMode must fall back to AI';
  }
  return true;
}

/** A trigger saved before this feature exists keeps its old behaviour end to end. */
async function testLegacyTriggerStillCallsLmStudio() {
  fresh();
  let generateCalls = 0;
  configure({
    triggers: [legacyRule()],
    onGenerate: () => { generateCalls += 1; },
    generate: async () => ({ text: 'رد الموديل' }),
    validate: { valid: true, reply: 'رد الموديل' }
  });

  const verdict = await processJob({ id: 'c1', text: 'بكام ده؟', fingerprint: 'fp1' });

  if (generateCalls !== 1) {
    return `Expected exactly 1 LM Studio generation call, got ${generateCalls}`;
  }
  if (verdict.reply !== 'رد الموديل') {
    return `Expected the model's reply, got "${verdict.reply}"`;
  }
  return true;
}

// ── 2. saving: valid fixed reply, and defaults ────────────────────────────────

/** A fixed trigger with text saves, and stores that text unchanged. */
async function testFixedReplySaves() {
  resetStorage();
  const created = await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY });

  if (created.replyMode !== REPLY_MODES.FIXED) {
    return `Saved replyMode is "${created.replyMode}"`;
  }
  if (created.fixedReply !== AWKWARD_REPLY) {
    return 'The saved fixedReply differs from what was passed in';
  }

  const stored = await getTriggers();
  if (stored.length !== 1 || stored[0].fixedReply !== AWKWARD_REPLY) {
    return 'The stored trigger does not hold the fixed reply verbatim';
  }
  return true;
}

/** Adding a trigger without a reply mode stores the AI default. */
async function testAddWithoutReplyModeStoresAi() {
  resetStorage();
  const created = await addTrigger({ phrases: ['بكام'] });

  if (created.replyMode !== REPLY_MODES.AI) {
    return `Expected "${REPLY_MODES.AI}", got "${created.replyMode}"`;
  }
  if (created.fixedReply !== '') {
    return `Expected an empty fixedReply, got "${created.fixedReply}"`;
  }
  return true;
}

/** Editing phrases only leaves the saved fixed reply alone. */
async function testUpdatePreservesFixedReply() {
  resetStorage();
  const created = await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY });

  const updated = await updateTrigger(created.id, { phrases: ['بكام', 'السعر'] });

  if (updated.fixedReply !== AWKWARD_REPLY) {
    return 'Editing the phrases cleared the fixed reply';
  }
  if (updated.replyMode !== REPLY_MODES.FIXED) {
    return 'Editing the phrases reset the reply mode';
  }
  return true;
}

/** Switching a rule back to AI keeps the text, so re-enabling it is one click. */
async function testSwitchBackToAiKeepsText() {
  resetStorage();
  const created = await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY });

  const updated = await updateTrigger(created.id, { replyMode: REPLY_MODES.AI });

  if (updated.replyMode !== REPLY_MODES.AI) {
    return 'The reply mode was not switched back to AI';
  }
  if (updated.fixedReply !== AWKWARD_REPLY) {
    return 'Switching to AI discarded the saved fixed reply';
  }
  return true;
}

// ── 3. validation: an empty fixed reply is refused ─────────────────────────────

/** The validator's own contract, including whitespace-only text. */
function testFixedReplyValidation() {
  if (!validateFixedReply(AWKWARD_REPLY).valid) return 'A real reply was rejected';
  if (validateFixedReply('').valid) return 'An empty reply was accepted';
  if (validateFixedReply('   \n\t  ').valid) return 'A whitespace-only reply was accepted';
  if (!validateFixedReply('   نص محاط بمسافات   ').valid) {
    return 'A reply with surrounding spaces was rejected — only emptiness may be judged';
  }
  if (validateFixedReply(null).valid) return 'null was accepted as a reply';
  if (validateFixedReply(42).valid) return 'a number was accepted as a reply';

  if (!validateReplyFields({ replyMode: REPLY_MODES.AI }).valid) {
    return 'AI mode must not require a fixed reply';
  }
  if (validateReplyFields({ replyMode: REPLY_MODES.FIXED, fixedReply: '' }).valid) {
    return 'Fixed mode with no text passed validation';
  }
  return true;
}

/** addTrigger() refuses an empty fixed reply and stores nothing. */
async function testAddRejectsEmptyFixedReply() {
  resetStorage();
  let message = '';
  try {
    await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.FIXED, fixedReply: '' });
  } catch (error) {
    message = error.message;
  }

  if (!message) return 'An empty fixed reply was accepted';
  const stored = readStore().triggers || [];
  if (stored.length !== 0) {
    return `A rejected trigger was still stored (${stored.length} in the store)`;
  }
  return true;
}

/** Whitespace-only is empty too — the box was not really filled in. */
async function testAddRejectsWhitespaceFixedReply() {
  resetStorage();
  let threw = false;
  try {
    await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.FIXED, fixedReply: '  \n ' });
  } catch (_) {
    threw = true;
  }
  if (!threw) return 'A whitespace-only fixed reply was accepted';
  return true;
}

/** updateTrigger() refuses it too, and leaves the stored rule as it was. */
async function testUpdateRejectsEmptyFixedReply() {
  resetStorage();
  const created = await addTrigger({ phrases: ['بكام'], replyMode: REPLY_MODES.AI, fixedReply: AWKWARD_REPLY });

  let threw = false;
  try {
    await updateTrigger(created.id, { replyMode: REPLY_MODES.FIXED, fixedReply: '   ' });
  } catch (_) {
    threw = true;
  }

  if (!threw) return 'An empty fixed reply was accepted on update';
  const stored = await getTriggers();
  if (stored[0].replyMode !== REPLY_MODES.AI) {
    return 'A rejected update still changed the stored reply mode';
  }
  return true;
}

/** The Options form blocks the save and says why, without inventing a default. */
async function testOptionsFormRejectsEmptyFixedReply() {
  resetStorage();
  document.getElementById('trigger-phrase').value = 'بكام';
  document.getElementById('trigger-fixed-reply').value = '   ';
  setTriggerReplyMode(REPLY_MODES.FIXED);

  const errorEl = document.getElementById('trigger-error');
  await handleAddTrigger();

  if (errorEl.style.display !== 'block' || !errorEl.textContent) {
    return 'Expected a visible validation message';
  }
  const stored = readStore().triggers || [];
  if (stored.length !== 0) return 'The trigger was saved despite the empty fixed reply';
  if (document.getElementById('trigger-fixed-reply').value !== '   ') {
    return 'The rejected form lost what the user had typed';
  }
  return true;
}

// ── 4 + 5. the fixed reply is returned exactly, and is never modified ──────────

/** The resolver hands back the configured string byte for byte. */
function testFixedReplyIsReturnedExactly() {
  const source = resolveReplySource({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY });

  if (source.mode !== REPLY_MODES.FIXED) {
    return `Expected fixed mode, got "${source.mode}"`;
  }
  if (source.text !== AWKWARD_REPLY) {
    return 'The resolver altered the fixed reply';
  }
  if (source.text.length !== AWKWARD_REPLY.length) {
    return `Length changed: ${AWKWARD_REPLY.length} → ${source.text.length}`;
  }
  return true;
}

/** Surrounding whitespace, a trailing newline and an emoji all survive resolution. */
function testFixedReplyIsNotModified() {
  const cases = [
    '  مسافة قبل وبعد  ',
    'سطر أول\nسطر ثانٍ',
    'نهاية بنقطة.',
    'خصم ٥٠٪ اليوم!',
    'Reply with 😀 and "quotes" and \'apostrophes\'',
    'MiXeD CaSe Is Preserved'
  ];

  for (const original of cases) {
    const { text } = resolveReplySource({ replyMode: REPLY_MODES.FIXED, fixedReply: original });
    if (text !== original) {
      return `"${original}" came back as "${text}"`;
    }
    if (getFixedReplyText({ replyMode: REPLY_MODES.FIXED, fixedReply: original }) !== original) {
      return `getFixedReplyText altered "${original}"`;
    }
  }

  // A fixed rule with nothing in it is not usable text, and must not masquerade as one.
  if (hasUsableFixedReply({ replyMode: REPLY_MODES.FIXED, fixedReply: '   ' })) {
    return 'Whitespace-only text was reported as usable';
  }
  if (!hasUsableFixedReply({ replyMode: REPLY_MODES.FIXED, fixedReply: 'ن' })) {
    return 'A real reply was reported as unusable';
  }
  // …and it falls back to AI rather than producing an empty reply.
  if (resolveReplySource({ replyMode: REPLY_MODES.FIXED, fixedReply: '' }).mode !== REPLY_MODES.AI) {
    return 'An empty fixed rule must fall back to AI, not publish nothing';
  }
  return true;
}

/** The reply handed to the content script is the configured text, unmodified. */
async function testPipelinePublishesFixedReplyVerbatim() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'SOMETHING ELSE ENTIRELY' }
  });

  const verdict = await processJob({ id: 'c2', text: 'بكام؟', fingerprint: 'fp2' });

  // The stub validator deliberately returns a different string, so this case also proves
  // the fixed text does not come from the validator's normalized value.
  if (verdict.reply !== AWKWARD_REPLY) {
    return `The pipeline reply differs from the configured text: "${verdict.reply}"`;
  }
  return true;
}

// ── Phase 19.7: the repeat exemption, end to end ─────────────────────────────
//
// Confirmed in real Chrome: 9 comments detected, 5 matched, 0 replies generated, 0
// submitted, 5 failed — every one of them "Invalid reply: REPEAT_RESPONSE". A fixed reply
// is not a model running out of things to say; repeating it is the feature. These cases
// run the REAL validator through the harness, not a stub, because the whole point is what
// the real rules do.

/** Reset the harness with the real validator and a chosen recent-reply history. */
function freshWithHistory(recentReplies, overrides = {}) {
  fresh();
  configure({
    useRealValidator: true,
    recentReplies,
    ...overrides
  });
}

/** An AI reply identical to one already written is still rejected as a repeat. */
async function testAiRepeatStillRejected() {
  freshWithHistory([AWKWARD_REPLY], {
    triggers: [matchAllRule({ replyMode: REPLY_MODES.AI })],
    generate: async () => ({ text: AWKWARD_REPLY })
  });

  const verdict = await processJob({ id: 'r1', text: 'بكام؟', fingerprint: 'fp-r1' });

  if (verdict.success !== false) return 'A repeated AI reply was accepted';
  if (!/REPEAT_RESPONSE/.test(verdict.error || '')) {
    return `Expected REPEAT_RESPONSE, got "${verdict.error}"`;
  }
  if (getProcessingState().repliesGenerated !== 0) return 'A rejected AI reply was counted as generated';
  return true;
}

/** A near-duplicate AI reply keeps its existing behaviour: still allowed. */
async function testAiNearDuplicateStillAllowed() {
  const distinct = 'السعر 100 جنيه، والرابط موجود في وصف الفيديو.';
  freshWithHistory([AWKWARD_REPLY], {
    triggers: [matchAllRule({ replyMode: REPLY_MODES.AI })],
    generate: async () => ({ text: distinct })
  });

  const verdict = await processJob({ id: 'r2', text: 'بكام؟', fingerprint: 'fp-r2' });

  if (!verdict.success || verdict.reply !== distinct) {
    return `A near-duplicate AI reply must still pass; got success=${verdict.success} reply="${verdict.reply}"`;
  }
  return true;
}

/** A fixed reply identical to a recent reply is accepted. */
async function testFixedReplyRepeatAccepted() {
  freshWithHistory([AWKWARD_REPLY], {
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })]
  });

  const verdict = await processJob({ id: 'r3', text: 'بكام؟', fingerprint: 'fp-r3' });

  if (!verdict.success) {
    return `A fixed reply was rejected as a repeat: ${verdict.error}`;
  }
  if (verdict.reply !== AWKWARD_REPLY) return 'The fixed reply did not come through unchanged';
  return true;
}

/**
 * The real-world case: the same fixed trigger matching several different comments, with the
 * answer already in the history each time. This is what used to produce 5 matches, 0
 * replies, 5 failures.
 */
async function testFixedReplyRepeatsAcrossComments() {
  fresh();
  configure({
    useRealValidator: true,
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    generate: async () => {
      throw new Error('LM Studio was asked to generate a fixed reply');
    }
  });

  for (let index = 0; index < 5; index += 1) {
    // The history grows exactly as the real activity log would: every published answer.
    const verdict = await processJob({
      id: `rep-${index}`,
      text: `بكام؟ (${index})`,
      fingerprint: `fp-rep-${index}`
    });

    if (!verdict.success) {
      return `Comment ${index + 1} of 5 was rejected: ${verdict.error}`;
    }
    if (verdict.reply !== AWKWARD_REPLY) {
      return `Comment ${index + 1} of 5 published something else: "${verdict.reply}"`;
    }

    // Publish it, so the next iteration really does face an identical reply in history.
    await publishReply({ id: `rep-${index}` });
    configure({ recentReplies: [...(deps.recentReplies || []), AWKWARD_REPLY] });
  }

  const state = getProcessingState();
  if (state.matched !== 5) return `Expected 5 matched, got ${state.matched}`;
  if (state.repliesGenerated !== 5) return `Expected 5 generated, got ${state.repliesGenerated}`;
  if (state.repliesSubmitted !== 5) return `Expected 5 submitted, got ${state.repliesSubmitted}`;
  if (state.failedSkipped !== 0) return `Expected no failures, got ${state.failedSkipped}`;
  return true;
}

/** The exemption is scoped to the repeat check: a blacklisted fixed reply is still refused. */
async function testFixedReplyStillValidatedAfterRepeatExemption() {
  // A fixed reply that trips the blacklist must be rejected even with the repeat
  // exemption, and must still read as the same user-visible failure as an AI reply.
  const banned = 'I am a language model';
  freshWithHistory([banned], {
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: banned })]
  });

  const verdict = await processJob({ id: 'r4', text: 'بكام؟', fingerprint: 'fp-r4' });

  if (verdict.success !== false) return 'A blacklisted fixed reply was published';
  if (!/BLACKLISTED/.test(verdict.error || '')) {
    return `Expected BLACKLISTED, got "${verdict.error}"`;
  }
  return true;
}

/** dry-run is untouched by the exemption: still prepared, still not submitted. */
async function testFixedReplyStillRespectsDryRunAfterRepeatExemption() {
  freshWithHistory([AWKWARD_REPLY], {
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })]
  });

  const verdict = await processJob({ id: 'r5', text: 'بكام؟', fingerprint: 'fp-r5' });
  await publishReply({ id: 'r5', dryRun: true });

  if (verdict.reply !== AWKWARD_REPLY) return 'Dry run did not prepare the fixed reply';
  const state = getProcessingState();
  if (state.repliesSubmitted !== 0) return 'Dry run submitted a reply';
  if (state.failedSkipped !== 1) return `Dry run should be an intentional skip; got ${state.failedSkipped}`;
  return true;
}

// ── 6. LM Studio is not asked to write the reply ───────────────────────────────

/** No generation call happens, and the model stub is never reached. */
async function testFixedReplySkipsGeneration() {
  fresh();
  let generateCalls = 0;
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    onGenerate: () => { generateCalls += 1; },
    generate: async () => {
      // If this ever runs, the bypass has regressed and the reply would be the model's.
      throw new Error('LM Studio was asked to generate a fixed reply');
    }
  });

  const verdict = await processJob({ id: 'c3', text: 'بكام؟', fingerprint: 'fp3' });

  if (generateCalls !== 0) {
    return `Expected 0 generation calls, got ${generateCalls}`;
  }
  if (verdict.result !== 'MATCH') {
    return 'The comment should still have matched';
  }
  if (verdict.reply !== AWKWARD_REPLY) {
    return 'The fixed reply did not come through';
  }
  return true;
}

/** Semantic matching is a separate job and still happens — the model IS consulted. */
async function testSemanticMatchingStillRuns() {
  fresh();
  let matchCalls = 0;
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    complete: async () => {
      matchCalls += 1;
      return { text: JSON.stringify({ matched: true, trigger: 'بكام' }), reasoning: '' };
    },
    validate: { valid: true, reply: 'unused' }
  });

  await processJob({ id: 'c4', text: 'كام سعره؟', fingerprint: 'fp4' });

  if (matchCalls !== 1) {
    return `Expected the semantic matcher to still be called once, got ${matchCalls}`;
  }
  return true;
}

/** AI mode calls LM Studio exactly once, as before. */
async function testAiModeStillCallsGeneration() {
  fresh();
  let generateCalls = 0;
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.AI })],
    onGenerate: () => { generateCalls += 1; },
    generate: async () => ({ text: 'رد الموديل' }),
    validate: { valid: true, reply: 'رد الموديل' }
  });

  const verdict = await processJob({ id: 'c5', text: 'بكام؟', fingerprint: 'fp5' });

  if (generateCalls !== 1) {
    return `Expected exactly 1 generation call, got ${generateCalls}`;
  }
  if (verdict.reply !== 'رد الموديل') {
    return 'The AI reply did not come through unchanged';
  }
  return true;
}

/** The two diagnostic events are emitted, naming the run, comment and trigger. */
async function testFixedReplyLogsItsEvents() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'unused' }
  });

  await processJob({ id: 'c6', text: 'بكام؟', fingerprint: 'fp6' });
  const events = getDiagEvents();

  const fixed = events.find((e) => e.event === 'REPLY_MODE_FIXED');
  if (!fixed) return 'REPLY_MODE_FIXED was not logged';
  if (fixed.commentId !== 'c6') return 'REPLY_MODE_FIXED did not name the comment';
  if (fixed.data.replyMode !== REPLY_MODES.FIXED) return 'REPLY_MODE_FIXED did not record the mode';
  if (fixed.data.triggerId !== 'rule-fixed') return 'REPLY_MODE_FIXED did not record the trigger id';
  if (typeof fixed.data.replyLength !== 'number') return 'REPLY_MODE_FIXED did not record a length';

  const skipped = events.find((e) => e.event === 'AI_REPLY_GENERATION_SKIPPED');
  if (!skipped) return 'The AI-skip event was not logged';

  // The reply text itself must not be in the log — the user's content, not a diagnostic.
  const serialized = JSON.stringify(events);
  if (serialized.includes(AWKWARD_REPLY)) {
    return 'The fixed reply text leaked into the diagnostic event';
  }
  return true;
}

// ── 7. a fixed reply still goes through reply validation ───────────────────────

/** An invalid fixed reply is rejected exactly as an invalid AI reply is. */
async function testFixedReplyStillValidated() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: false, reason: 'BLACKLISTED' }
  });

  const verdict = await processJob({ id: 'c7', text: 'بكام؟', fingerprint: 'fp7' });

  if (verdict.success !== false || verdict.reply !== undefined) {
    return 'An invalid fixed reply was accepted';
  }
  if (!/Invalid reply/.test(verdict.error || '')) {
    return `Expected the validation error to be reported, got "${verdict.error}"`;
  }

  // Rejected means counted as failed, and NOT counted as generated.
  const state = getProcessingState();
  if (state.failedSkipped !== 1) return `Expected 1 failed/skipped, got ${state.failedSkipped}`;
  if (state.repliesGenerated !== 0) return 'A rejected fixed reply was counted as generated';
  return true;
}

/** A fixed reply with real text is counted as a prepared reply, like any other. */
async function testFixedReplyStillCounted() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'unused' }
  });

  await processJob({ id: 'c8', text: 'بكام؟', fingerprint: 'fp8' });
  const state = getProcessingState();

  if (state.matched !== 1) return `Expected 1 matched, got ${state.matched}`;
  if (state.repliesGenerated !== 1) {
    return `A prepared fixed reply must count as generated; got ${state.repliesGenerated}`;
  }
  // No separate counter was introduced for this mode.
  const keys = Object.keys(state);
  const extra = keys.filter((k) => /fixed/i.test(k));
  if (extra.length) return `A separate fixed-reply counter was added: ${extra.join(', ')}`;
  return true;
}

/** The in-session duplicate-generation guard still runs ahead of a fixed reply. */
async function testFixedReplyStillDeduplicated() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    hasGeneration: () => true,
    validate: { valid: true, reply: 'unused' }
  });

  const verdict = await processJob({ id: 'c9', text: 'بكام؟', fingerprint: 'fp9' });

  if (verdict.result !== 'SKIP_SESSION_DUPLICATE') {
    return `Expected the duplicate guard to skip, got "${verdict.result}"`;
  }
  if (verdict.reply !== undefined) return 'A skipped job still produced a reply';
  return true;
}

// ── 8 + 9. the rest of the pipeline is untouched ───────────────────────────────

/** A fixed reply is handed to the content script and posted through the same steps. */
async function testFixedReplyStillReachesPublisher() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'unused' }
  });

  const verdict = await processJob({ id: 'c10', text: 'بكام؟', fingerprint: 'fp10' });
  await publishReply({ id: 'c10' });

  if (verdict.reply !== AWKWARD_REPLY) return 'The publisher was handed something else';
  const state = getProcessingState();
  if (state.repliesSubmitted !== 1) {
    return `Expected the reply to be submitted once, got ${state.repliesSubmitted}`;
  }
  return true;
}

/** dry-run still stops the submit, whether the reply was fixed or generated. */
async function testFixedReplyStillRespectsDryRun() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'unused' }
  });

  const verdict = await processJob({ id: 'c11', text: 'بكام؟', fingerprint: 'fp11' });
  await publishReply({ id: 'c11', dryRun: true });

  // The reply is still prepared — that is what dry-run means — but nothing is submitted.
  if (verdict.reply !== AWKWARD_REPLY) return 'Dry run did not prepare the fixed reply';
  const state = getProcessingState();
  if (state.repliesSubmitted !== 0) return 'Dry run submitted a reply';
  if (state.failedSkipped !== 1) {
    return `Dry run should be recorded as an intentional skip; got ${state.failedSkipped}`;
  }
  return true;
}

/**
 * Queueing, delays and the rate limit live in the worker's drain loop, upstream of
 * processJob() — which is precisely why a fixed reply cannot skip them: this mode changes
 * what happens INSIDE one job, and nothing before it. The harness cannot drain a real
 * queue, so this case asserts the property that makes the claim true: a fixed job still
 * takes the normal path through the matcher, the duplicate guard and the publisher, so
 * every gate around it is still reached in order.
 */
async function testFixedReplyTakesTheNormalPath() {
  fresh();
  configure({
    triggers: [matchAllRule({ replyMode: REPLY_MODES.FIXED, fixedReply: AWKWARD_REPLY })],
    validate: { valid: true, reply: 'unused' }
  });

  const verdict = await processJob({ id: 'c12', text: 'بكام؟', fingerprint: 'fp12' });

  // Matched → prepared → handed off: the same sequence an AI reply follows. The handoff
  // lease is still held here, which is exactly the state between generation and
  // submission — the content script owns the reply now.
  if (verdict.result !== 'MATCH') return 'The job did not match';
  if (verdict.reply !== AWKWARD_REPLY) return 'The fixed reply did not reach the handoff';
  if (!hasHandoff()) {
    return 'The reply was not handed to the content script for publishing';
  }
  return true;
}

/** The service worker's own copy of the flow imports the shared resolver. */
function testValidReplyModesAreExported() {
  if (!VALID_REPLY_MODES.includes(REPLY_MODES.AI) || !VALID_REPLY_MODES.includes(REPLY_MODES.FIXED)) {
    return `VALID_REPLY_MODES is [${VALID_REPLY_MODES.join(', ')}]`;
  }
  return true;
}

// ── 10. the Options form wires the two controls together ──────────────────────

/** The fixed-reply box appears only in fixed mode. */
function testReplyModeTogglesTheFixedReplyBox() {
  const row = document.getElementById('trigger-fixed-reply-row');

  setTriggerReplyMode(REPLY_MODES.FIXED);
  if (row.style.display === 'none') return 'The fixed reply box stayed hidden in fixed mode';
  if (readTriggerReplyMode() !== REPLY_MODES.FIXED) return 'readTriggerReplyMode did not report fixed';

  setTriggerReplyMode(REPLY_MODES.AI);
  if (row.style.display !== 'none') return 'The fixed reply box stayed visible in AI mode';
  if (readTriggerReplyMode() !== REPLY_MODES.AI) return 'readTriggerReplyMode did not report AI';
  return true;
}

/** A valid fixed reply saved from the form is stored exactly as typed. */
async function testOptionsFormSavesFixedReply() {
  resetStorage();
  document.getElementById('trigger-phrase').value = 'بكام';
  document.getElementById('trigger-fixed-reply').value = AWKWARD_REPLY;
  setTriggerReplyMode(REPLY_MODES.FIXED);

  const errorEl = document.getElementById('trigger-error');
  await handleAddTrigger();

  if (errorEl.style.display === 'block') {
    return `Unexpected error: ${errorEl.textContent}`;
  }

  const stored = await getTriggers();
  if (stored.length !== 1) return `Expected 1 stored trigger, got ${stored.length}`;
  if (stored[0].replyMode !== REPLY_MODES.FIXED) return 'The form did not save fixed mode';
  if (stored[0].fixedReply !== AWKWARD_REPLY) {
    return 'The form altered the fixed reply text';
  }
  // The form resets to its defaults after a successful save.
  if (document.getElementById('trigger-fixed-reply').value !== '') {
    return 'The fixed reply box was not cleared after saving';
  }
  return true;
}

/** Run all tests and print a summary. */
async function runAllTests() {
  console.log('\n=== Fixed Reply Tests ===\n');

  await runTest('A rule with no replyMode defaults to AI', testLegacyRuleDefaultsToAi);
  await runTest('Pre-existing trigger fields and defaults are unchanged', testLegacyFieldsUntouched);
  await runTest('A pre-19.6 trigger still calls LM Studio', testLegacyTriggerStillCallsLmStudio);

  await runTest('A fixed reply with text saves correctly', testFixedReplySaves);
  await runTest('Adding without a reply mode stores the AI default', testAddWithoutReplyModeStoresAi);
  await runTest('Editing phrases preserves the fixed reply', testUpdatePreservesFixedReply);
  await runTest('Switching back to AI keeps the saved text', testSwitchBackToAiKeepsText);

  await runTest('An empty fixed reply is rejected', testFixedReplyValidation);
  await runTest('addTrigger refuses an empty fixed reply', testAddRejectsEmptyFixedReply);
  await runTest('addTrigger refuses a whitespace-only fixed reply', testAddRejectsWhitespaceFixedReply);
  await runTest('updateTrigger refuses an empty fixed reply', testUpdateRejectsEmptyFixedReply);
  await runTest('The Options form blocks an empty fixed reply', testOptionsFormRejectsEmptyFixedReply);

  await runTest('An AI reply identical to a recent reply is still rejected', testAiRepeatStillRejected);
  await runTest('An AI near-duplicate reply is still allowed', testAiNearDuplicateStillAllowed);
  await runTest('A fixed reply identical to a recent reply is accepted', testFixedReplyRepeatAccepted);
  await runTest('A fixed reply repeats across several comments', testFixedReplyRepeatsAcrossComments);
  await runTest('A blacklisted fixed reply is still rejected', testFixedReplyStillValidatedAfterRepeatExemption);
  await runTest('A fixed reply still respects dry run', testFixedReplyStillRespectsDryRunAfterRepeatExemption);

  await runTest('The fixed reply is returned exactly as configured', testFixedReplyIsReturnedExactly);
  await runTest('The fixed reply is never modified', testFixedReplyIsNotModified);
  await runTest('The pipeline publishes the fixed reply verbatim', testPipelinePublishesFixedReplyVerbatim);

  await runTest('A fixed reply skips LM Studio generation', testFixedReplySkipsGeneration);
  await runTest('Semantic matching still runs for a fixed trigger', testSemanticMatchingStillRuns);
  await runTest('AI mode still calls LM Studio exactly once', testAiModeStillCallsGeneration);
  await runTest('Fixed replies log their diagnostic events', testFixedReplyLogsItsEvents);

  await runTest('A fixed reply still goes through validation', testFixedReplyStillValidated);
  await runTest('A prepared fixed reply counts as generated', testFixedReplyStillCounted);
  await runTest('Duplicate-generation suppression still applies', testFixedReplyStillDeduplicated);

  await runTest('A fixed reply reaches the publisher', testFixedReplyStillReachesPublisher);
  await runTest('A fixed reply still respects dry run', testFixedReplyStillRespectsDryRun);
  await runTest('A fixed reply takes the normal pipeline path', testFixedReplyTakesTheNormalPath);
  await runTest('The supported reply modes are exported', testValidReplyModesAreExported);

  await runTest('The reply type selector toggles the fixed reply box', testReplyModeTogglesTheFixedReplyBox);
  await runTest('The Options form saves a fixed reply verbatim', testOptionsFormSavesFixedReply);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export { OUTCOME, deps };
export default runAllTests;
