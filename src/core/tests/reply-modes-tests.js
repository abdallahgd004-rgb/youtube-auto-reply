/**
 * Reply Modes Tests — Phase 20.14
 *
 * The mode setting is small, but it is the one control that decides which pipeline runs, so the
 * tests concentrate on the two ways picking wrong hurts:
 *
 *   1. **Changing a default.** Adding a mode must not change what anybody gets today. A user
 *      upgrading has no knowledge base yet, so a default of Knowledge would send every comment
 *      through retrieval and answerability against an empty base — every comment skipped, with
 *      no error anywhere. The same reasoning fixes the fallback for an UNRECOGNISED value.
 *   2. **Running the pipelines in the wrong order.** §25's Hybrid diagram is precise — trigger
 *      first, knowledge only after a non-match — and running both and preferring the trigger
 *      afterwards produces different answers, so the rule is encoded as a named field.
 *
 * Runs in the browser from reply-modes-tests.html. No chrome stub, no network: this milestone
 * adds a setting, and nothing calls a model.
 */

import {
  REPLY_MODE,
  DEFAULT_REPLY_MODE,
  listReplyModes,
  normalizeReplyMode,
  isValidReplyMode,
  describeReplyMode,
  modeUsesKnowledge,
  modeUsesTriggers
} from '../reply-modes.js';

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

// ── §25's three modes ─────────────────────────────────────────────────────────

async function testTheThreeModesExist() {
  const modes = listReplyModes();
  for (const expected of [REPLY_MODE.TRIGGER, REPLY_MODE.KNOWLEDGE, REPLY_MODE.HYBRID]) {
    if (!modes.includes(expected)) return `missing ${expected}`;
  }
  if (modes.length !== 3) return `${modes.length} modes`;
  return true;
}

async function testTriggerModeRunsTriggersOnly() {
  const described = describeReplyMode(REPLY_MODE.TRIGGER);
  if (!described.usesTriggers) return 'triggers are off';
  if (described.usesKnowledge) return 'the knowledge pipeline runs in Trigger Mode';
  // §25: "The existing trigger system should not be removed." Trigger Mode is that system,
  // unchanged — a knowledge pipeline running alongside it would answer comments the user
  // deliberately did not configure an answer for.
  if (described.knowledgeOnlyAfterNoMatch) return 'the after-no-match rule applies in Trigger Mode';
  return true;
}

async function testKnowledgeModeRunsTheFullPipeline() {
  const described = describeReplyMode(REPLY_MODE.KNOWLEDGE);
  if (!described.usesKnowledge) return 'the knowledge pipeline is off';
  if (described.usesTriggers) return 'triggers still run in Knowledge Mode';
  if (described.knowledgeOnlyAfterNoMatch) return 'the after-no-match rule applies in Knowledge Mode';
  return true;
}

async function testHybridModeRunsTriggersThenKnowledge() {
  // §25's diagram. Both pipelines run, and knowledge is reached ONLY after a trigger miss.
  const described = describeReplyMode(REPLY_MODE.HYBRID);
  if (!described.usesTriggers) return 'triggers are off';
  if (!described.usesKnowledge) return 'the knowledge fallback is off';
  if (!described.knowledgeOnlyAfterNoMatch) {
    return 'Hybrid does not encode §25\'s ordering rule — knowledge could run before the trigger match';
  }
  return true;
}

async function testTheHelpersAgreeWithTheDescriptor() {
  // A caller that uses the booleans must get the same answer as one that reads the descriptor,
  // or the two spellings drift and one of them is wrong.
  for (const mode of listReplyModes()) {
    const described = describeReplyMode(mode);
    if (modeUsesKnowledge(mode) !== described.usesKnowledge) return `${mode} knowledge helper disagrees`;
    if (modeUsesTriggers(mode) !== described.usesTriggers) return `${mode} trigger helper disagrees`;
  }
  return true;
}

// ── The default, which is load-bearing ─────────────────────────────────────────

async function testTheDefaultIsTrigger() {
  // Not a formality. A user upgrading has no knowledge base yet, so a Knowledge default would
  // skip every comment with no error anywhere.
  if (DEFAULT_REPLY_MODE !== REPLY_MODE.TRIGGER) return `the default is ${DEFAULT_REPLY_MODE}`;

  for (const value of [undefined, null, '', '   ', 'nonsense', 42, {}, [], true]) {
    if (normalizeReplyMode(value) !== REPLY_MODE.TRIGGER) {
      return `${JSON.stringify(value)} → ${normalizeReplyMode(value)}`;
    }
  }
  return true;
}

async function testTheDefaultComesFromConfigRatherThanASecondLiteral() {
  // Two literals can drift, and then the constant says one thing while a fresh install gets
  // another.
  if (DEFAULT_REPLY_MODE !== DEFAULT_CONFIG.replyBehavior.replyMode) {
    return `the module says ${DEFAULT_REPLY_MODE}, config says ${DEFAULT_CONFIG.replyBehavior.replyMode}`;
  }
  if (!listReplyModes().includes(DEFAULT_CONFIG.replyBehavior.replyMode)) {
    return `the configured default ${DEFAULT_CONFIG.replyBehavior.replyMode} is not a valid mode`;
  }
  return true;
}

async function testTheSettingIsAReplyBehaviourKey() {
  // It has to live inside `replyBehavior`, which `getSettings()` deep-merges wholesale — a new
  // TOP-LEVEL key would need adding to the explicit key list and would silently never load.
  const mode = DEFAULT_CONFIG.replyBehavior.replyMode;
  if (mode === undefined) return 'replyBehavior.replyMode is not in DEFAULT_CONFIG';
  return true;
}

async function testAFreshSettingsObjectReportsTrigger() {
  // The observable form of the default, through the object every caller actually receives.
  const described = describeReplyMode(DEFAULT_CONFIG.replyBehavior);
  if (described.mode !== REPLY_MODE.TRIGGER || described.usesKnowledge) {
    return `a fresh settings object reported ${JSON.stringify(described)}`;
  }
  return true;
}

// ── Normalization ─────────────────────────────────────────────────────────────

async function testFormattingVariantsAreAccepted() {
  // A user hand-editing settings should not have their actual choice rejected over case or
  // whitespace — that reads as the setting being broken.
  for (const value of ['hybrid', 'Hybrid', 'HYBRID', ' hybrid ', '\thybrid\n']) {
    if (normalizeReplyMode(value) !== REPLY_MODE.HYBRID) return `${JSON.stringify(value)} → ${normalizeReplyMode(value)}`;
  }
  for (const value of ['knowledge', ' Knowledge ']) {
    if (normalizeReplyMode(value) !== REPLY_MODE.KNOWLEDGE) return `${JSON.stringify(value)} → ${normalizeReplyMode(value)}`;
  }
  return true;
}

async function testAnUnknownModeNeverBecomesKnowledge() {
  // Falling back to Knowledge would switch a user onto a mode they never chose, on a base they
  // have not configured. Trigger is the recoverable direction.
  for (const value of ['knowledge-ish', 'KnowledgeBase', 'hybridmode', 'tri', 'trigger,hybrid']) {
    if (normalizeReplyMode(value) === REPLY_MODE.KNOWLEDGE) {
      return `${JSON.stringify(value)} silently became Knowledge`;
    }
  }
  return true;
}

async function testValidationSeparatesValidFromUnknown() {
  // The options page needs to tell the user "that is not a reply mode" rather than silently
  // rewriting their selection behind their back.
  for (const value of listReplyModes()) {
    if (!isValidReplyMode(value)) return `${value} was rejected as invalid`;
    if (!isValidReplyMode(value.toUpperCase())) return `${value} uppercased was rejected`;
  }
  for (const value of ['', '   ', 'nonsense', 42, null, undefined, {}, [], 'hybrid mode']) {
    if (isValidReplyMode(value)) return `${JSON.stringify(value)} was accepted`;
  }
  return true;
}

async function testNormalizationIsTotal() {
  for (const value of [null, undefined, 0, 1, NaN, Infinity, {}, [], [1], () => {}, Symbol('x')]) {
    let mode;
    try {
      mode = normalizeReplyMode(value);
    } catch (error) {
      return `normalizeReplyMode threw on ${String(value)}`;
    }
    if (!listReplyModes().includes(mode)) return `${String(value)} → ${mode}`;
  }
  return true;
}

// ── The descriptor's shape ────────────────────────────────────────────────────

async function testEveryDescriptorHasOneShape() {
  const shapes = new Set(listReplyModes().map((m) => Object.keys(describeReplyMode(m)).sort().join(',')));
  if (shapes.size !== 1) return `shapes differ: ${[...shapes].join(' | ')}`;
  return true;
}

async function testTheDescriptorAlwaysNamesTheMode() {
  // A descriptor whose `mode` disagreed with the value it describes would let a caller act on
  // one and display another.
  for (const value of listReplyModes()) {
    if (describeReplyMode(value).mode !== value) return `${value} → ${describeReplyMode(value).mode}`;
  }
  return true;
}

async function testDescribingIsDeterministic() {
  const first = JSON.stringify(describeReplyMode(REPLY_MODE.HYBRID));
  for (let i = 0; i < 5; i++) {
    if (JSON.stringify(describeReplyMode(REPLY_MODE.HYBRID)) !== first) return 'the descriptor varied';
  }
  return true;
}

async function testTheModesAreDistinct() {
  // If two modes described the same pipeline, one of them is unreachable and the user cannot
  // tell which they selected.
  const seen = new Set();
  for (const mode of listReplyModes()) {
    const key = JSON.stringify(describeReplyMode(mode));
    if (seen.has(key)) return `${mode} duplicates another mode's pipeline`;
    seen.add(key);
  }
  return true;
}

async function testTheVocabularyIsClosed() {
  // §25 names three modes. An open list would mean anything can be stored and then behave
  // unpredictably, which is validation that cannot fail.
  const keys = Object.keys(REPLY_MODE);
  if (keys.length !== 3) return `${keys.length} keys`;
  for (const [key, value] of Object.entries(REPLY_MODE)) {
    if (value !== key.toLowerCase()) return `${key} → ${value}`;
  }
  if (Object.values(REPLY_MODE).includes('unknown')) return '`unknown` is a mode — it is the fallback, not a choice';
  return true;
}

export default async function runAllTests() {
  await runTest("§25's three modes exist", testTheThreeModesExist);
  await runTest('Trigger Mode runs triggers only', testTriggerModeRunsTriggersOnly);
  await runTest('Knowledge Mode runs the full pipeline', testKnowledgeModeRunsTheFullPipeline);
  await runTest('Hybrid Mode runs triggers then knowledge (§25)', testHybridModeRunsTriggersThenKnowledge);
  await runTest('the helpers agree with the descriptor', testTheHelpersAgreeWithTheDescriptor);

  await runTest('the default is Trigger', testTheDefaultIsTrigger);
  await runTest('the default comes from config, not a second literal', testTheDefaultComesFromConfigRatherThanASecondLiteral);
  await runTest('the setting is a replyBehaviour key', testTheSettingIsAReplyBehaviourKey);
  await runTest('a fresh settings object reports Trigger', testAFreshSettingsObjectReportsTrigger);

  await runTest('formatting variants are accepted', testFormattingVariantsAreAccepted);
  await runTest('an unknown mode never becomes Knowledge', testAnUnknownModeNeverBecomesKnowledge);
  await runTest('validation separates valid from unknown', testValidationSeparatesValidFromUnknown);
  await runTest('normalization is total', testNormalizationIsTotal);

  await runTest('every descriptor has one shape', testEveryDescriptorHasOneShape);
  await runTest('the descriptor always names the mode', testTheDescriptorAlwaysNamesTheMode);
  await runTest('describing is deterministic', testDescribingIsDeterministic);
  await runTest('the modes are distinct', testTheModesAreDistinct);
  await runTest('the vocabulary is closed', testTheVocabularyIsClosed);

  return results;
}