/**
 * Context Template Tests — Phase 19.5
 *
 * The rule this module exists to protect is "exactly one template is injected into the
 * prompt, and the prompt stays a known, ordered composition". These cases pin that, plus
 * the CRUD edges that would otherwise corrupt the saved settings blob.
 *
 * Runs in the browser from context-template-tests.html (there is no Node runner).
 * chrome-storage-stub.js must be imported first so `chrome` exists before
 * context-templates.js is evaluated.
 */

import { resetStorage, readStore, store as liveStore } from './chrome-storage-stub.js';
import {
  getTemplates,
  getActiveTemplate,
  addTemplate,
  activateTemplate,
  deactivateTemplates,
  deleteTemplate,
  MAX_TEMPLATE_BODY_CHARS,
  MAX_TEMPLATE_NAME_CHARS,
  MAX_TEMPLATES
} from '../context-templates.js';
import { buildSystemPrompt } from '../prompt-builder.js';

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

const PRICE = 'منتج Acme Pro بسعر ٩٩ جنيهًا، والتوصيل مجاني';

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function testStartsEmpty() {
  resetStorage();
  if ((await getTemplates()).length !== 0) return 'A fresh profile should have no templates';
  if ((await getActiveTemplate()) !== null) return 'No template means no active template';
  return true;
}

async function testAddAndReadBack() {
  resetStorage();
  const created = await addTemplate({ name: 'الأسعار', body: PRICE });
  const list = await getTemplates();
  if (list.length !== 1) return `Expected 1 template, got ${list.length}`;
  if (list[0].name !== 'الأسعار') return 'Name was not stored';
  if (list[0].body !== PRICE) return 'Body was not stored';
  if (typeof created.id !== 'string' || !created.id) return 'An id should be generated';
  return true;
}

async function testScopeSurvivesStorage() {
  // Phase 20.13 — the scope has to survive a write/read cycle, or the field is declared and
  // then silently dropped on the way to storage, leaving every template unscoped. Tested HERE
  // rather than in the packaging checks because this is the suite with the storage stub: from a
  // settings object built in memory the drop is invisible.
  resetStorage();
  await addTemplate({ name: 'Books', body: PRICE, scope: ['books/', 'books/chemistry.md', '..', ''] });

  const list = await getTemplates();
  if (list.length !== 1) return `Expected 1 template, got ${list.length}`;

  const stored = list[0].scope;
  if (!Array.isArray(stored)) return `scope came back as ${typeof stored}`;
  if (stored.length !== 2) return `scope came back as ${JSON.stringify(stored)}`;
  if (stored[0].kind !== 'directory' || stored[0].value !== 'books') return `entry 0 was ${JSON.stringify(stored[0])}`;
  if (stored[1].kind !== 'document' || stored[1].value !== 'books/chemistry.md') return `entry 1 was ${JSON.stringify(stored[1])}`;

  // A template with no scope must not gain one.
  resetStorage();
  await addTemplate({ name: 'NoScope', body: PRICE });
  const bare = await getTemplates();
  if (!Array.isArray(bare[0].scope) || bare[0].scope.length !== 0) {
    return `a template without a scope gained ${JSON.stringify(bare[0].scope)}`;
  }

  return true;
}

async function testFirstTemplateIsActiveAutomatically() {
  resetStorage();
  const created = await addTemplate({ name: 'الأسعار', body: PRICE });
  const active = await getActiveTemplate();
  if (!active) return 'The first template should be active';
  if (active.id !== created.id) return 'The wrong template is active';
  return true;
}

async function testBlankNameOrBodyIsRefused() {
  resetStorage();
  const cases = [
    [{}, 'no fields'],
    [{ name: '  ', body: 'x' }, 'blank name'],
    [{ name: 'x', body: '   ' }, 'blank body'],
    [{ name: 'x' }, 'missing body'],
    [null, 'null'],
    ['not an object', 'a string']
  ];
  for (const [input, label] of cases) {
    let threw = false;
    try {
      await addTemplate(input);
    } catch (_) {
      threw = true;
    }
    if (!threw) return `Expected ${label} to be refused`;
  }
  if ((await getTemplates()).length !== 0) return 'A refused template must not be stored';
  return true;
}

async function testLongFieldsAreBounded() {
  resetStorage();
  const created = await addTemplate({
    name: 'ن'.repeat(MAX_TEMPLATE_NAME_CHARS + 50),
    body: 'ب'.repeat(MAX_TEMPLATE_BODY_CHARS + 500)
  });
  if (created.name.length !== MAX_TEMPLATE_NAME_CHARS) return `Name was not capped: ${created.name.length}`;
  if (created.body.length !== MAX_TEMPLATE_BODY_CHARS) return `Body was not capped: ${created.body.length}`;
  return true;
}

async function testListIsCapped() {
  resetStorage();
  for (let i = 0; i < MAX_TEMPLATES + 3; i++) {
    try {
      await addTemplate({ name: `قالب ${i}`, body: `نص ${i}` });
    } catch (_) {
      // Expected once the cap is reached.
    }
  }
  const list = await getTemplates();
  if (list.length !== MAX_TEMPLATES) return `Expected a cap of ${MAX_TEMPLATES}, got ${list.length}`;
  return true;
}

// ── activation ───────────────────────────────────────────────────────────────

async function testActivatingSwitchesRatherThanAdds() {
  resetStorage();
  const first = await addTemplate({ name: 'الأسعار', body: PRICE });
  const second = await addTemplate({ name: 'الشحن', body: 'الشحن خلال ثلاثة أيام' });

  const active = await activateTemplate(second.id);
  if (!active || active.id !== second.id) return 'The requested template should become active';

  const templates = await getTemplates();
  const enabledCount = templates.filter((t) => t.enabled).length;
  if (enabledCount !== 1) return `Expected exactly 1 active template, found ${enabledCount}`;
  if (templates.find((t) => t.id === first.id).enabled) return 'The previous template should be off';
  return true;
}

async function testActivatingUnknownIdChangesNothing() {
  resetStorage();
  await addTemplate({ name: 'الأسعار', body: PRICE });
  if ((await activateTemplate('nope')) !== null) return 'An unknown id should resolve to null';
  if ((await getTemplates())[0].enabled !== true) return 'The active template must be left alone';
  return true;
}

async function testDeactivateLeavesTheTemplate() {
  resetStorage();
  await addTemplate({ name: 'الأسعار', body: PRICE });
  if ((await deactivateTemplates()) !== true) return 'Deactivating an active template should report true';
  if ((await getActiveTemplate()) !== null) return 'No template should be active';
  if ((await getTemplates()).length !== 1) return 'Deactivating must not delete the template';
  if ((await deactivateTemplates()) !== false) return 'Deactivating when nothing is active should report false';
  return true;
}

async function testDeletingUnknownIdThrows() {
  resetStorage();
  let threw = false;
  try {
    await deleteTemplate('nope');
  } catch (error) {
    threw = /not found/.test(error.message);
  }
  if (!threw) return 'Deleting an unknown id must reject with "not found"';
  return true;
}

async function testDeletingTheActiveTemplatePromotesASurvivor() {
  resetStorage();
  const first = await addTemplate({ name: 'الأسعار', body: PRICE });
  const second = await addTemplate({ name: 'الشحن', body: 'الشحن خلال ثلاثة أيام' });
  await activateTemplate(first.id);

  await deleteTemplate(first.id);
  const active = await getActiveTemplate();
  if (!active) return 'Something should be active after deleting the active template';
  if (active.id !== second.id) return 'The first survivor should be promoted';
  return true;
}

async function testDeletingTheOnlyTemplateLeavesNoneActive() {
  resetStorage();
  const only = await addTemplate({ name: 'الأسعار', body: PRICE });
  await deleteTemplate(only.id);
  if ((await getTemplates()).length !== 0) return 'The list should be empty';
  if ((await getActiveTemplate()) !== null) return 'Nothing should be active';
  return true;
}

// ── prompt composition ───────────────────────────────────────────────────────

async function testActiveTemplateReachesThePrompt() {
  const system = buildSystemPrompt({
    replyBehavior: {
      contextTemplates: [
        { id: 'a', name: 'الأسعار', body: PRICE, enabled: true },
        { id: 'b', name: 'الشحن', body: 'نص لا يجب أن يظهر', enabled: false }
      ]
    }
  });
  if (!system.includes(PRICE)) return 'The active template body is missing from the prompt';
  if (system.includes('نص لا يجب أن يظهر')) return 'An inactive template leaked into the prompt';
  return true;
}

async function testOnlyOneTemplateIsEverInjected() {
  const system = buildSystemPrompt({
    replyBehavior: {
      contextTemplates: [
        { id: 'a', name: 'أ', body: 'الجزء الأول', enabled: true },
        { id: 'b', name: 'ب', body: 'الجزء الثاني', enabled: true }
      ]
    }
  });
  // Reachable only by hand-editing storage; the first enabled wins, which is what
  // getActiveTemplate() also does. Two templates must not both be injected.
  if (system.includes('الجزء الثاني')) return 'A second enabled template must not be injected';
  if (!system.includes('الجزء الأول')) return 'The first enabled template should be injected';
  return true;
}

async function testTemplateComesAfterStyleAndContext() {
  const system = buildSystemPrompt({
    lmStudio: { systemPrompt: 'BASE' },
    replyBehavior: {
      staticContext: 'CONTEXT',
      contextTemplates: [{ id: 'a', name: 'T', body: 'TEMPLATE', enabled: true }]
    }
  });
  const atBase = system.indexOf('BASE');
  const atContext = system.indexOf('CONTEXT');
  const atTemplate = system.indexOf('TEMPLATE');
  if (!(atBase < atContext && atContext < atTemplate)) {
    return `Prompt order is wrong: base=${atBase} context=${atContext} template=${atTemplate}`;
  }
  return true;
}

async function testMalformedTemplatesAreIgnored() {
  const system = buildSystemPrompt({
    replyBehavior: {
      contextTemplates: [
        null,
        {},
        { name: 'فارغ', body: '   ', enabled: true },
        { name: 'بلا اسم', body: 'نص حقيقي', enabled: true }
      ]
    }
  });
  // A nameless template is still usable: the builder falls back to a generic header,
  // because the body is the part that matters and the name is only a label.
  if (!system.includes('نص حقيقي')) return 'A template with a real body should be used even without a name';
  // A whitespace-only body must contribute nothing at all.
  if (/\n\s*\n\s*\n/.test(system)) return 'A blank template must not add empty sections';
  if (system.includes('قالب «فارغ»')) return 'A blank template must not add a header';
  return true;
}

async function testNoTemplatesLeavesThePromptUnchanged() {
  const before = buildSystemPrompt({ replyBehavior: { staticContext: 'CONTEXT' } });
  const after = buildSystemPrompt({ replyBehavior: { staticContext: 'CONTEXT', contextTemplates: [] } });
  if (before !== after) return 'An empty template list must not change the prompt';
  if (before.includes('قالب')) return 'No template header should appear when none is used';
  return true;
}

async function testSavedTemplatesSurviveAStorageRoundTrip() {
  resetStorage();
  await addTemplate({ name: 'الأسعار', body: PRICE });
  const saved = readStore().replyBehavior;
  if (!Array.isArray(saved.contextTemplates)) return 'contextTemplates must live inside replyBehavior';
  // A save that replaces replyBehavior wholesale must not drop them.
  const settings = { replyBehavior: { ...saved, responseStyle: 'short' } };
  const { saveSettings } = await import('../storage.js');
  await saveSettings(settings);
  if ((await getTemplates()).length !== 1) return 'Templates were lost on save';
  return true;
}

async function testMalformedStoredListReadsAsEmpty() {
  resetStorage();
  liveStore.replyBehavior = { contextTemplates: 'not an array' };
  if ((await getTemplates()).length !== 0) return 'A malformed list must read as empty';
  if ((await getActiveTemplate()) !== null) return 'A malformed list must have no active template';
  return true;
}

async function testPromptAndModuleAgreeOnTheActiveTemplate() {
  resetStorage();
  await addTemplate({ name: 'الأسعار', body: PRICE });
  await addTemplate({ name: 'الشحن', body: 'نص تجريبي' });
  await activateTemplate((await getTemplates())[1].id);

  const active = await getActiveTemplate();
  const settings = await import('../storage.js').then((m) => m.getSettings());
  const system = buildSystemPrompt(settings);
  if (!system.includes(active.body)) return 'The prompt and getActiveTemplate() disagree';
  if (system.includes(PRICE)) return 'The deactivated template is still in the prompt';
  return true;
}

async function runAllTests() {
  console.log('\n=== Context Template Tests (Phase 19.5) ===\n');

  await runTest('Starts empty', testStartsEmpty);
  await runTest('Add and read back', testAddAndReadBack);
  await runTest('A knowledge scope survives storage (20.13)', testScopeSurvivesStorage);
  await runTest('The first template is active automatically', testFirstTemplateIsActiveAutomatically);
  await runTest('A blank name or body is refused', testBlankNameOrBodyIsRefused);
  await runTest('Long fields are bounded', testLongFieldsAreBounded);
  await runTest('The list is capped', testListIsCapped);
  await runTest('Activating switches rather than adds', testActivatingSwitchesRatherThanAdds);
  await runTest('Activating an unknown id changes nothing', testActivatingUnknownIdChangesNothing);
  await runTest('Deactivating keeps the template', testDeactivateLeavesTheTemplate);
  await runTest('Deleting an unknown id rejects', testDeletingUnknownIdThrows);
  await runTest('Deleting the active template promotes a survivor', testDeletingTheActiveTemplatePromotesASurvivor);
  await runTest('Deleting the only template leaves none active', testDeletingTheOnlyTemplateLeavesNoneActive);
  await runTest('The active template reaches the prompt', testActiveTemplateReachesThePrompt);
  await runTest('Only one template is ever injected', testOnlyOneTemplateIsEverInjected);
  await runTest('The template comes after style and context', testTemplateComesAfterStyleAndContext);
  await runTest('Malformed templates are ignored', testMalformedTemplatesAreIgnored);
  await runTest('No templates leaves the prompt unchanged', testNoTemplatesLeavesThePromptUnchanged);
  await runTest('Templates survive a storage round trip', testSavedTemplatesSurviveAStorageRoundTrip);
  await runTest('A malformed stored list reads as empty', testMalformedStoredListReadsAsEmpty);
  await runTest('The prompt and getActiveTemplate() agree', testPromptAndModuleAgreeOnTheActiveTemplate);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;