/**
 * Context Templates — Phase 19.5
 *
 * WHAT A TEMPLATE IS
 * A named, reusable block of instructions or fixed facts that the user can swap in and
 * out: "Product & pricing", "Support hours", "Course FAQ". Exactly one is ACTIVE at a
 * time, and the active one is appended to every prompt after the static context.
 *
 * This is the same job as `staticContext`, but swappable. Static context is one fixed
 * block typed into a single box; templates let a creator keep several versions — one per
 * video type, say — and change which one is live without rewriting the same box.
 *
 * WHY ONE ACTIVE TEMPLATE
 * Combining templates would make it impossible to reason about what actually reached
 * the model, and the prompt is the one place where "what did we send" must stay
 * inspectable. One active template keeps the prompt a known, ordered composition:
 * base system prompt → response style → static context → active template.
 *
 * NO PLACEHOLDERS IN THIS VERSION
 * A template body is sent verbatim. Substituting {{author}} or {{videoTitle}} would need
 * those values plumbed into the prompt builder, and the comment author is not currently
 * passed there — so offering it would mean sending a placeholder that silently stays
 * literal. Better to leave the feature out than to ship it half working.
 *
 * Platform-agnostic: no `chrome.*`, no DOM. Storage access goes through storage.js.
 */

import { getSettings, saveSettings } from './storage.js';
import { parseScope } from './template-scope.js';

/**
 * Longest template body accepted, in characters.
 *
 * The body is injected into every prompt, so it is bounded for the same reason
 * MAX_STATIC_CONTEXT_CHARS is: a pasted wall of text must not inflate every request.
 * Two thousand characters is comfortably more than a set of product facts.
 */
export const MAX_TEMPLATE_BODY_CHARS = 2000;

/**
 * Longest template name accepted.
 *
 * Names are labels in the Options list, not prompt content, so this is only there to
 * stop one field filling the whole row.
 */
export const MAX_TEMPLATE_NAME_CHARS = 60;

/**
 * Most templates kept.
 *
 * Bounds the Options list and, more importantly, the saved settings blob.
 */
export const MAX_TEMPLATES = 10;

/** Storage key holding the template list, inside replyBehavior. */
const SETTINGS_PATH = 'replyBehavior';

/** Generate an id in the same shape trigger-crud.js uses, with its own prefix. */
function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 7);
  return `tpl-${timestamp}-${random}`;
}

/**
 * Reduce any input to the stored shape, or null when unusable.
 *
 * A template with no body would be sent as nothing, so it is refused outright rather
 * than stored as an empty row the user has to clean up.
 *
 * @param {*} input
 * @returns {Object|null}
 */
function toTemplate(input) {
  if (!input || typeof input !== 'object') return null;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!name || !body) return null;

  return {
    id: typeof input.id === 'string' && input.id ? input.id : generateId(),
    name: name.slice(0, MAX_TEMPLATE_NAME_CHARS),
    body: body.slice(0, MAX_TEMPLATE_BODY_CHARS),
    // Phase 20.13 — the knowledge scope this template applies to (§22). Stored verbatim as the
    // user typed it and normalized by `template-scope.js`, which owns the path rules. Kept
    // out of the prompt: a scope is a retrieval selector, and §22 requires template context
    // and factual knowledge to stay separate.
    scope: parseScope(input.scope),
    // Opt-IN, not opt-out. Defaulting this to true meant a second template was created
    // already active, so the list held two active templates and the prompt builder had to
    // guess which one meant something. addTemplate() turns the first one on explicitly.
    enabled: input.enabled === true
  };
}

/**
 * Read the stored list, tolerating anything.
 *
 * @returns {Promise<Array>} always an array; a malformed store reads as "no templates"
 */
export async function getTemplates() {
  const settings = await getSettings();
  const list = settings?.[SETTINGS_PATH]?.contextTemplates;
  return Array.isArray(list) ? list.filter((t) => t && typeof t === 'object') : [];
}

/**
 * The template currently injected into every prompt.
 *
 * The FIRST enabled template wins. Ordering is the user's, because the list is rendered
 * in the order they created it and there is no drag-and-drop to reorder it here.
 *
 * @returns {Promise<Object|null>} the active template, or null when none is enabled
 */
export async function getActiveTemplate() {
  const templates = await getTemplates();
  const usable = templates.map(toTemplate).filter(Boolean);
  return usable.find((t) => t.enabled) || null;
}

/**
 * Add a template.
 *
 * The first template added is enabled automatically: a user who creates one template
 * expects it to be used, and an inactive first template would look like a bug. Every
 * later template starts inactive, so adding one can never create a second active
 * template behind the user's back.
 *
 * @param {{name: string, body: string, enabled?: boolean}} template
 * @returns {Promise<Object>} the stored template
 * @throws {Error} when the name or body is missing, or the list is full
 */
export async function addTemplate(template) {
  const created = toTemplate(template);
  if (!created) {
    throw new Error('Invalid template: a name and a body are both required');
  }

  const settings = await getSettings();
  const existing = Array.isArray(settings[SETTINGS_PATH]?.contextTemplates)
    ? settings[SETTINGS_PATH].contextTemplates
    : [];

  if (existing.length >= MAX_TEMPLATES) {
    throw new Error(`Cannot add more than ${MAX_TEMPLATES} templates`);
  }
  if (existing.some((t) => t && t.id === created.id)) {
    throw new Error(`Template with id "${created.id}" already exists`);
  }

  // The FIRST template is active automatically: a user who creates one expects it to be
  // used, and an inactive first template would look like a bug. Every later one starts
  // inactive so the list can never hold two active templates.
  if (existing.length === 0) {
    created.enabled = true;
  }

  const replyBehavior = {
    ...(settings[SETTINGS_PATH] || {}),
    contextTemplates: [...existing, created]
  };

  await saveSettings({ [SETTINGS_PATH]: replyBehavior });
  return created;
}

/**
 * Make exactly one template the active one.
 *
 * Every other template is disabled, so two templates can never both be injected — the
 * failure mode this module exists to prevent.
 *
 * @param {string} templateId
 * @returns {Promise<Object|null>} the newly active template, or null when unknown
 */
export async function activateTemplate(templateId) {
  if (typeof templateId !== 'string' || !templateId) return null;

  const settings = await getSettings();
  const existing = Array.isArray(settings[SETTINGS_PATH]?.contextTemplates)
    ? settings[SETTINGS_PATH].contextTemplates
    : [];
  if (!existing.some((t) => t && t.id === templateId)) return null;

  const contextTemplates = existing.map((t) => ({
    ...t,
    enabled: Boolean(t) && t.id === templateId
  }));

  await saveSettings({
    [SETTINGS_PATH]: { ...(settings[SETTINGS_PATH] || {}), contextTemplates }
  });

  const stored = contextTemplates.find((t) => t && t.id === templateId);
  return toTemplate({ ...stored, enabled: true });
}

/**
 * Turn the active template off without deleting it.
 *
 * @returns {Promise<boolean>} true when a template was active and is now off
 */
export async function deactivateTemplates() {
  const settings = await getSettings();
  const existing = Array.isArray(settings[SETTINGS_PATH]?.contextTemplates)
    ? settings[SETTINGS_PATH].contextTemplates
    : [];
  if (!existing.some((t) => t && t.enabled)) return false;

  await saveSettings({
    [SETTINGS_PATH]: {
      ...(settings[SETTINGS_PATH] || {}),
      contextTemplates: existing.map((t) => ({ ...t, enabled: false }))
    }
  });
  return true;
}

/**
 * Delete a template.
 *
 * @param {string} templateId
 * @returns {Promise<void>}
 * @throws {Error} when the id is unknown
 */
export async function deleteTemplate(templateId) {
  if (typeof templateId !== 'string' || !templateId) {
    throw new Error('Invalid templateId: must be a non-empty string');
  }

  const settings = await getSettings();
  const existing = Array.isArray(settings[SETTINGS_PATH]?.contextTemplates)
    ? settings[SETTINGS_PATH].contextTemplates
    : [];

  const index = existing.findIndex((t) => t && t.id === templateId);
  if (index < 0) {
    throw new Error(`Template with id "${templateId}" not found`);
  }

  const remaining = existing.filter((t) => t && t.id !== templateId);

  // If the deleted template was the active one, promote the first survivor rather than
  // leaving the extension with no context at all after a deletion the user expected to
  // be a no-op for the prompt.
  if (existing[index].enabled && remaining.length > 0 && !remaining.some((t) => t.enabled)) {
    remaining[0] = { ...remaining[0], enabled: true };
  }

  await saveSettings({
    [SETTINGS_PATH]: {
      ...(settings[SETTINGS_PATH] || {}),
      contextTemplates: remaining
    }
  });
}