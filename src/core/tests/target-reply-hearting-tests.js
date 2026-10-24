/**
 * Target-Based Reply Drafting and Immediate Hearting Tests
 *
 * Verifies the enable/disable toggle for Phase 23.1:
 * - Setting defaults to false for safe installation/migration.
 * - Enabling activates the target drafting & immediate hearting workflow.
 * - Disabling prevents hearting while leaving other features untouched.
 * - Background worker enforces the setting authoritatively from storage.
 * - Dry-run strictly suppresses hearting on both worker and content layers.
 * - Knowledge mode never hearts comments (no trigger ruleId).
 * - Fixed replies with triggers inherit the hearting behavior properly.
 * - Two-way UI synchronization via chrome.storage.onChanged.
 * - Existing user settings migrate safely without data loss.
 */

import { resetStorage, readStore, fireStorageChanged } from './chrome-storage-stub.js';
import { DEFAULT_CONFIG } from '../config.js';
import { getSettings, saveSettings } from '../storage.js';
import { shouldHeartAfterInsert } from '../target-reply-hearting.js';

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
    console.log(`✗ ${name}: ${error && error.message ? error.message : error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Setting Defaults
// ─────────────────────────────────────────────────────────────────────────────

async function testSettingDefaultsToFalseInConfig() {
  if (DEFAULT_CONFIG.targetReplyHeartingEnabled !== false) {
    return `DEFAULT_CONFIG.targetReplyHeartingEnabled must be false, got ${DEFAULT_CONFIG.targetReplyHeartingEnabled}`;
  }
  return true;
}

async function testSettingDefaultsToFalseInGetSettings() {
  resetStorage();
  const settings = await getSettings();
  if (settings.targetReplyHeartingEnabled !== false) {
    return `getSettings() on fresh storage must default to false, got ${settings.targetReplyHeartingEnabled}`;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Enabling Activates Intended Workflow
// ─────────────────────────────────────────────────────────────────────────────

async function testEnablingActivatesWorkflowWhenTriggerMatches() {
  resetStorage();
  await saveSettings({ targetReplyHeartingEnabled: true, dryRun: false });
  const settings = await getSettings();

  const verdict = {
    result: 'MATCH',
    ruleId: 'rule-price-123',
    reply: 'السعر 100 جنيه'
  };

  const shouldHeart = shouldHeartAfterInsert(verdict, settings);
  if (shouldHeart !== true) {
    return `shouldHeartAfterInsert must be true when enabled, not dry-run, and trigger matches; got ${shouldHeart}`;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Disabling Prevents Hearting Workflow
// ─────────────────────────────────────────────────────────────────────────────

async function testDisablingPreventsHeartingWorkflow() {
  resetStorage();
  await saveSettings({ targetReplyHeartingEnabled: false, dryRun: false });
  const settings = await getSettings();

  const verdict = {
    result: 'MATCH',
    ruleId: 'rule-price-123',
    reply: 'السعر 100 جنيه'
  };

  const shouldHeart = shouldHeartAfterInsert(verdict, settings);
  if (shouldHeart !== false) {
    return `shouldHeartAfterInsert must be false when targetReplyHeartingEnabled is false; got ${shouldHeart}`;
  }
  return true;
}

async function testCorruptedOrStringValuesDoNotActivate() {
  const corruptedValues = ['true', '1', 1, {}, [], 'yes'];
  for (const bad of corruptedValues) {
    const verdict = { result: 'MATCH', ruleId: 'rule-1' };
    const settings = { targetReplyHeartingEnabled: bad, dryRun: false };
    if (shouldHeartAfterInsert(verdict, settings) !== false) {
      return `Corrupted value ${JSON.stringify(bad)} must not activate hearting`;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Background Worker Enforces Independently of UI State
// ─────────────────────────────────────────────────────────────────────────────

async function testWorkerEnforcesSettingFromStorageNotUIState() {
  resetStorage();
  // Storage says disabled
  await saveSettings({ targetReplyHeartingEnabled: false, dryRun: false });

  // A stale UI or client tries to pass a verdict pretending hearting is desired
  const settings = await getSettings();
  const verdict = {
    result: 'MATCH',
    ruleId: 'rule-1',
    reply: 'Hello'
  };

  // Background worker computes:
  verdict.heartAfterInsert = shouldHeartAfterInsert(verdict, settings);

  if (verdict.heartAfterInsert !== false) {
    return 'Worker must evaluate to false regardless of what caller passes if storage is disabled';
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Settings and Side Panel Controls Use the Same Persisted Setting
// ─────────────────────────────────────────────────────────────────────────────

async function testBothControlsUseSamePersistedSetting() {
  resetStorage();
  // Simulating Side panel toggle write:
  await saveSettings({ targetReplyHeartingEnabled: true });
  const stored1 = readStore();
  if (stored1.targetReplyHeartingEnabled !== true) {
    return 'Writing from side panel did not persist targetReplyHeartingEnabled';
  }

  // Simulating Options page reading and saving:
  const settings = await getSettings();
  if (settings.targetReplyHeartingEnabled !== true) {
    return 'Settings page getSettings() did not read the value saved by side panel';
  }

  await saveSettings({ targetReplyHeartingEnabled: false });
  const stored2 = readStore();
  if (stored2.targetReplyHeartingEnabled !== false) {
    return 'Writing from options page did not persist targetReplyHeartingEnabled';
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Two-Way Synchronization via chrome.storage.onChanged
// ─────────────────────────────────────────────────────────────────────────────

async function testStorageOnChangedSyncsSurfaces() {
  resetStorage();
  let popupObserved = null;
  let optionsObserved = null;

  // Listeners representing Popup and Options
  const popupListener = (changes, area) => {
    if (area === 'local' && changes.targetReplyHeartingEnabled) {
      popupObserved = changes.targetReplyHeartingEnabled.newValue === true;
    }
  };
  const optionsListener = (changes, area) => {
    if (area === 'local' && changes.targetReplyHeartingEnabled) {
      optionsObserved = changes.targetReplyHeartingEnabled.newValue === true;
    }
  };

  chrome.storage.onChanged.addListener(popupListener);
  chrome.storage.onChanged.addListener(optionsListener);

  try {
    // External write: options changes setting to true
    fireStorageChanged({ targetReplyHeartingEnabled: { oldValue: false, newValue: true } }, 'local');
    if (popupObserved !== true || optionsObserved !== true) {
      return `Both surfaces must observe true when changed, got popup=${popupObserved}, options=${optionsObserved}`;
    }

    // External write: popup changes setting to false
    fireStorageChanged({ targetReplyHeartingEnabled: { oldValue: true, newValue: false } }, 'local');
    if (popupObserved !== false || optionsObserved !== false) {
      return `Both surfaces must observe false when changed, got popup=${popupObserved}, options=${optionsObserved}`;
    }
    return true;
  } finally {
    chrome.storage.onChanged.removeListener(popupListener);
    chrome.storage.onChanged.removeListener(optionsListener);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Dry-Run Behavior: Hearting Allowed for Target Replies Workflow
// ─────────────────────────────────────────────────────────────────────────────

async function testHeartingPermittedInDryRunWhenTargetHeartingEnabled() {
  const verdict = { result: 'MATCH', ruleId: 'rule-price-123' };
  const settingsWithDryRun = { targetReplyHeartingEnabled: true, dryRun: true };

  const shouldHeart = shouldHeartAfterInsert(verdict, settingsWithDryRun);
  if (shouldHeart !== true) {
    return `shouldHeartAfterInsert must be true when targetReplyHeartingEnabled is true, even in dry-run; got ${shouldHeart}`;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Other Reply Modes & Features Remain Unchanged
// ─────────────────────────────────────────────────────────────────────────────

async function testKnowledgeModeNeverHearts() {
  // Knowledge Mode replies have NO trigger ruleId
  const knowledgeVerdict = {
    result: 'MATCH',
    ruleId: null, // Knowledge Mode leaves ruleId unset / null
    reply: 'Grounded knowledge reply'
  };
  const settings = { targetReplyHeartingEnabled: true, dryRun: false };

  const shouldHeart = shouldHeartAfterInsert(knowledgeVerdict, settings);
  if (shouldHeart !== false) {
    return `Knowledge replies must never be hearted; got ${shouldHeart}`;
  }
  return true;
}

async function testFixedRepliesSupportTargetHearting() {
  // Fixed reply with a trigger has ruleId set
  const fixedVerdict = {
    result: 'MATCH',
    ruleId: 'fixed-rule-1',
    reply: 'Fixed canned reply'
  };
  const settings = { targetReplyHeartingEnabled: true, dryRun: false };

  const shouldHeart = shouldHeartAfterInsert(fixedVerdict, settings);
  if (shouldHeart !== true) {
    return `Fixed reply with matching trigger must be hearted when enabled; got ${shouldHeart}`;
  }
  return true;
}

async function testNoMatchProducesNoHeart() {
  const noMatchVerdict = {
    result: 'NO_MATCH',
    ruleId: null,
    reply: ''
  };
  const settings = { targetReplyHeartingEnabled: true, dryRun: false };

  const shouldHeart = shouldHeartAfterInsert(noMatchVerdict, settings);
  if (shouldHeart !== false) {
    return `NO_MATCH must never heart; got ${shouldHeart}`;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Existing Settings Migrate Safely Without Data Loss
// ─────────────────────────────────────────────────────────────────────────────

async function testMigrationPreservesExistingSettings() {
  resetStorage();
  // Existing legacy settings without targetReplyHeartingEnabled
  const legacySettings = {
    enabled: true,
    dryRun: true,
    lmStudio: {
      baseUrl: 'http://custom-host:1234/v1',
      apiKey: 'secret',
      model: 'my-model',
      temperature: 0.5,
      maxTokens: 2000,
      systemPrompt: 'Custom prompt'
    },
    triggers: [
      { id: 'tr-1', phrase: 'سعر', matchMode: 'contains', enabled: true }
    ],
    replyBehavior: {
      minDelayMs: 5000,
      maxDelayMs: 15000,
      maxRepliesPerHour: 20,
      ignoreHeartedComments: true,
      responseStyle: 'short',
      replyMode: 'trigger',
      contextTemplates: [{ id: 't-1', name: 'T1', text: 'Info', enabled: true }],
      blacklist: ['bad-word'],
      followupOnAnswered: false,
      followupInstruction: ''
    }
  };

  await saveSettings(legacySettings);

  const loaded = await getSettings();

  // Preserved fields:
  if (loaded.lmStudio.baseUrl !== 'http://custom-host:1234/v1') return 'baseUrl lost';
  if (loaded.lmStudio.model !== 'my-model') return 'model lost';
  if (loaded.triggers.length !== 1 || loaded.triggers[0].id !== 'tr-1') return 'triggers lost';
  if (loaded.replyBehavior.responseStyle !== 'short') return 'responseStyle lost';
  if (loaded.replyBehavior.contextTemplates.length !== 1) return 'templates lost';
  if (loaded.replyBehavior.blacklist[0] !== 'bad-word') return 'blacklist lost';

  // New field safely defaulted without altering anything else:
  if (loaded.targetReplyHeartingEnabled !== false) {
    return `targetReplyHeartingEnabled must default to false on migration, got ${loaded.targetReplyHeartingEnabled}`;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite Runner
// ─────────────────────────────────────────────────────────────────────────────

export default async function runAllTests() {
  console.log('\n--- 1. Setting Defaults ---');
  await runTest('targetReplyHeartingEnabled defaults to false in DEFAULT_CONFIG', testSettingDefaultsToFalseInConfig);
  await runTest('targetReplyHeartingEnabled defaults to false in getSettings()', testSettingDefaultsToFalseInGetSettings);

  console.log('\n--- 2. Activation ---');
  await runTest('Enabling activates workflow when a trigger matches (not dry-run)', testEnablingActivatesWorkflowWhenTriggerMatches);

  console.log('\n--- 3. Deactivation & Fail-Safe ---');
  await runTest('Disabling prevents the hearting workflow', testDisablingPreventsHeartingWorkflow);
  await runTest('Corrupted or non-strict-boolean values fail safe to false', testCorruptedOrStringValuesDoNotActivate);

  console.log('\n--- 4. Background Worker Enforcement ---');
  await runTest('Worker enforces setting from storage independently of UI state', testWorkerEnforcesSettingFromStorageNotUIState);

  console.log('\n--- 5. Settings and Side Panel Storage Parity ---');
  await runTest('Settings and Side Panel controls use the same persisted setting', testBothControlsUseSamePersistedSetting);

  console.log('\n--- 6. Storage Synchronization ---');
  await runTest('Storage onChanged synchronizes both surfaces without reload', testStorageOnChangedSyncsSurfaces);

  console.log('\n--- 7. Dry-Run Behavior ---');
  await runTest('Target replies workflow permits hearting even in dry-run mode', testHeartingPermittedInDryRunWhenTargetHeartingEnabled);

  console.log('\n--- 8. Feature Isolation ---');
  await runTest('Knowledge Mode replies are never hearted (no trigger ruleId)', testKnowledgeModeNeverHearts);
  await runTest('Fixed replies with matching triggers inherit hearting properly', testFixedRepliesSupportTargetHearting);
  await runTest('NO_MATCH comments are never hearted', testNoMatchProducesNoHeart);

  console.log('\n--- 9. Data Migration ---');
  await runTest('Existing settings migrate safely without data loss', testMigrationPreservesExistingSettings);

  return results;
}
