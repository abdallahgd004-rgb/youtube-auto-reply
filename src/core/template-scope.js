/**
 * Template ↔ Knowledge Integration — Phase 20.13
 *
 * §22: an active template "can eventually be associated with a knowledge scope", which "can
 * reduce irrelevant retrieval and improve accuracy". This module implements that.
 *
 * ── What a scope IS, and what it is not ──────────────────────────────────────
 *
 * A scope is a SELECTOR — a list of knowledge paths that says where facts may come from. It
 * is emphatically not a source. §22 closes with the rule this whole milestone exists to keep:
 * "Templates provide context/scope; the Knowledge Base provides factual source material."
 *
 * So nothing here returns or forwards CONTENT. A scope decides which documents are eligible;
 * what they say is still the knowledge base's, and every downstream stage (§16's grounding
 * validation especially) still checks claims against the evidence rather than against this
 * configuration. §23 puts the Knowledge Base ABOVE the Active Template in the hierarchy for
 * exactly this reason.
 *
 * 20.8 already fences the template BODY as non-factual in the prompt. This milestone must not
 * weaken that, and the scope deliberately does not go into the prompt at all — a file path in
 * a prompt invites the model to reason about files rather than facts, and the knowledge block
 * already contains exactly the scoped sections.
 *
 * ── The narrowing hazard, stated up front ────────────────────────────────────
 *
 * Scoping REMOVES evidence, and every lesson in this phase is that removing evidence loses
 * correct replies: 20.9 must not validate against citations only, and 20.11 must not starve the
 * retry by narrowing to cited sections. So a scope is treated as a deliberate, user-authored
 * filter and is reported loudly when it filters out everything — a scope matching no documents
 * is a MISCONFIGURATION, and silently reporting "no relevant knowledge" would look exactly like
 * a base with nothing in it.
 *
 * ── §18's "Template scope" ───────────────────────────────────────────────────
 *
 * §18 lists template scope among the mechanisms that can resolve a conflict. Implemented here by
 * scoping BEFORE the conflict decision: if only one of two contradicting documents is in scope,
 * the other is not applicable and there is nothing to resolve. The conflict rule itself is NOT
 * reimplemented — this filters and then calls the single owner in `knowledge-conflicts.js`.
 *
 * PURE: no storage, no network. The active template is read from settings by the caller, as
 * `buildPromptParts()` already does for the prompt.
 */

import { resolveSectionConflict, CONFLICT_SEVERITY } from './knowledge-conflicts.js';
import { ACCEPTED_EXTENSIONS } from './knowledge-schema.js';

/** Bounds, because the value is user-typed and unbounded elsewhere already bit us. */
export const MAX_SCOPE_ENTRIES = 20;
export const MAX_SCOPE_CHARS = 120;

/**
 * One normalized scope entry.
 *
 * `kind: 'directory'` is a PATH PREFIX, not 20.1's `category` — that field is only the
 * immediate parent folder, so `books/2027/chemistry.md` has category `2027` and a scope of
 * `books/` would miss it. §22's examples (`books/`, `books/chemistry.md`) are both paths, and
 * matching on paths is what the user means.
 */
export function normalizeScopeEntry(value) {
  if (typeof value !== 'string') return null;

  let entry = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!entry) return null;
  if (entry.length > MAX_SCOPE_CHARS) return null;

  // Reject traversal for the same reason `normalizeFilename` does: a scope is user-typed and
  // this is a path matcher.
  const segments = entry.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;

  const lowered = entry.toLowerCase();
  const withoutTrailingSlash = lowered.replace(/\/+$/, '');

  // A `.md`/`.markdown` entry names one document. Anything else — with or without a trailing
  // slash — is a directory prefix.
  const extension = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf('.') + 1);
  if (withoutTrailingSlash.includes('.') && ACCEPTED_EXTENSIONS.includes(`.${extension}`)) {
    return { kind: 'document', value: withoutTrailingSlash };
  }
  return { kind: 'directory', value: withoutTrailingSlash };
}

/**
 * Normalize whatever the template stored into a usable scope.
 *
 * Accepts a single string, an array, or nothing, because a user editing JSON by hand will
 * produce all three. A malformed entry is DROPPED rather than failing the whole scope: one bad
 * line should not silently disable scoping for the rest.
 *
 * @param {string|string[]|null} value
 * @returns {Array<{kind: string, value: string}>}
 */
export function parseScope(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);

  const entries = [];
  for (const item of raw.slice(0, MAX_SCOPE_ENTRIES)) {
    const entry = normalizeScopeEntry(item);
    if (!entry) continue;
    if (entries.some((e) => e.kind === entry.kind && e.value === entry.value)) continue;
    entries.push(entry);
  }
  return entries;
}

/**
 * Whether a document's path falls inside a scope.
 *
 * An EMPTY scope matches everything — the template simply declares no scope, which is the
 * default and must behave exactly as it did before this milestone.
 *
 * Case-insensitive on both sides: filenames are user-typed too, and a scope is a hint, so
 * `Books/` should reach `books/chemistry.md` rather than silently matching nothing.
 *
 * @param {string|Object} document - a filename, or a document object
 * @param {Array<Object>} scope - from parseScope()
 * @returns {boolean}
 */
export function documentInScope(document, scope) {
  const entries = Array.isArray(scope) ? scope.filter(Boolean) : [];
  if (entries.length === 0) return true;

  const filename = String(
    typeof document === 'string' ? document : (document && (document.filename || '')) || ''
  )
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();

  if (!filename) return false;

  return entries.some((entry) => {
    if (entry.kind === 'document') return filename === entry.value;
    // A directory matches itself and everything beneath it. Comparing on a whole-segment
    // boundary stops `book/` from matching `books/chemistry.md`.
    return filename === entry.value || filename.startsWith(entry.value + '/');
  });
}

/**
 * The scope declared by an active template, read from settings.
 *
 * Synchronous, for the same reason `buildPromptParts()` is: the active template is already in
 * the settings object and a store round-trip would make the read path async for no benefit.
 *
 * @param {Object} [settings]
 * @returns {{entries: Array<Object>, templateName: string, templateId: string}}
 */
export function readActiveScope(settings) {
  const templates = Array.isArray(settings?.replyBehavior?.contextTemplates)
    ? settings.replyBehavior.contextTemplates
    : [];

  // The blank-body rule is the SAME one `buildPromptParts()` applies, and the two must agree:
  // if the prompt uses a template, the scope must come from that same template. Using a
  // different rule here would let the prompt and the scope come from different templates.
  const active = templates.find((t) =>
    t && t.enabled === true && typeof t.body === 'string' && t.body.trim().length > 0
  );

  if (!active) return { entries: [], templateName: '', templateId: '' };

  return {
    entries: parseScope(active.scope),
    templateName: typeof active.name === 'string' ? active.name.trim() : '',
    templateId: typeof active.id === 'string' ? active.id : ''
  };
}

/**
 * Narrow a section list to a scope.
 *
 * Reports what it removed, because a scope that silently empties the evidence turns into a
 * stream of skips with no explanation — the failure mode §22's "reduce irrelevant retrieval"
 * is supposed to improve on, not reproduce.
 *
 * @param {Array<Object>} sections
 * @param {Array<Object>} scope - from parseScope()
 * @returns {{sections: Array<Object>, removedCount: number, documentsInScope: number}}
 */
export function filterSectionsByScope(sections, scope) {
  const usable = (Array.isArray(sections) ? sections : []).filter(Boolean);
  const entries = Array.isArray(scope) ? scope.filter(Boolean) : [];

  if (entries.length === 0) {
    return { sections: usable, removedCount: 0, documentsInScope: new Set(usable.map((s) => s.documentId)).size };
  }

  const kept = usable.filter((section) => documentInScope(section, entries));
  const documentsInScope = new Set(kept.map((s) => String(s.documentId || ''))).size;

  return { sections: kept, removedCount: usable.length - kept.length, documentsInScope };
}

/**
 * Resolve a §18 conflict WITHIN a scope.
 *
 * The scope is applied FIRST, so a contradicting document that the template excludes is not
 * applicable and cannot force a skip. §18 lists template scope among its resolution
 * mechanisms, and this is that mechanism.
 *
 * The conflict rule is not reimplemented: after filtering, the single owner in
 * `knowledge-conflicts.js` decides, which is what keeps this from drifting from the gate's own
 * per-comment decision.
 *
 * @param {Array<Object>} sections
 * @param {Array<Object>} scope
 * @returns {{conflicting: boolean, resolvedByScope: boolean, severity: string, winner: (Object|null),
 *   reason: string, documents: Array<Object>}}
 */
export function resolveScopedConflict(sections, scope) {
  const { sections: scoped, documentsInScope } = filterSectionsByScope(sections, scope);
  const entries = Array.isArray(scope) ? scope.filter(Boolean) : [];

  if (entries.length === 0) {
    // No scope: nothing was excluded, so nothing was resolved by one.
    const plain = resolveSectionConflict(scoped);
    return { ...plain, resolvedByScope: false };
  }

  if (documentsInScope === 0) {
    // A scope that matches nothing is a MISCONFIGURATION. It is reported as such rather than
    // as "no conflict", because silently proceeding with zero evidence would surface as every
    // comment being skipped for no stated reason.
    return {
      conflicting: false,
      resolvedByScope: false,
      severity: '',
      winner: null,
      documents: [],
      reason: 'the template scope matched no knowledge document, so there is nothing to resolve against'
    };
  }

  const outcome = resolveSectionConflict(scoped);
  const documentsTotal = new Set(
    (Array.isArray(sections) ? sections : []).filter(Boolean).map((s) => String(s.documentId || ''))
  ).size;

  // The scope RESOLVED it when filtering left a single document and there had been more than
  // one to disagree. That is the only case where scoping changed the answer.
  const resolvedByScope = !outcome.conflicting && documentsTotal > 1 && documentsInScope === 1;

  let reason = outcome.reason;
  if (resolvedByScope) {
    reason =
      'the template scope excludes the other candidate, so §18 has nothing to resolve ' +
      `(${documentsInScope} of ${documentsTotal} documents in scope)`;
  }

  return { ...outcome, resolvedByScope, reason };
}

export { CONFLICT_SEVERITY };