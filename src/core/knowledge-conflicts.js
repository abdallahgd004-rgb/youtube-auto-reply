/**
 * Knowledge Conflicts — Phase 20.12
 *
 * §18: "Conflicting documents must be handled explicitly."
 *
 * ── What already existed, and what this adds ─────────────────────────────────
 *
 * `compareDocumentPrecedence()` (20.1) is the comparator, `updateKnowledgeDocument()` (20.2)
 * can change `enabled` and `priority`, and 20.7's gate reports CONFLICTING_KNOWLEDGE for a
 * comment whose retrieved sections disagree. §18's four mechanisms are therefore already in
 * place, and this milestone deliberately does NOT write a second comparator — a second answer
 * to §18 would be a second thing that drifts from the first.
 *
 * What was missing is the USER-FACING half. The gate tells one comment to skip; the user never
 * learns that their knowledge base contradicts itself, so a base full of contradictions looks
 * exactly like a base where the extension "sometimes doesn't reply". §18 asks for conflicts to
 * be handled EXPLICITLY, and a silent per-comment skip is the opposite of explicit.
 *
 * So this module answers "which of my documents disagree, and what do I do about it?" across
 * the whole base rather than for one comment.
 *
 * ── Two severities, because they need different actions ───────────────────────
 *
 *   BLOCKING — equal authority, contradicting. Every comment that touches this subject will
 *              skip with CONFLICTING_KNOWLEDGE. The user MUST resolve it: set a priority,
 *              bump the version, or disable one.
 *   SHADOWED  — one document wins by precedence, so comments are answerable, but the other
 *              file is inert and its author does not know. §18 does not call this a conflict
 *              and neither does the gate; it is reported because "my old price file is still
 *              there but never used" is exactly the question a user asks, and silence answers
 *              it wrongly.
 *
 * ── "Conflict" stays deliberately narrow ──────────────────────────────────────
 *
 * Equal authority AND the same heading AND different content. Two documents that AGREE are not
 * a conflict, and neither are two covering different subjects. Otherwise a user keeping a
 * backup copy of a price list would see a wall of conflicts and learn nothing.
 *
 * No model is involved anywhere in this module, and there is no completion function to inject.
 * §18 forbids the model choosing between conflicting documents "based on intuition", so there
 * is nothing here for a model to do.
 *
 * PURE apart from storage reads the caller performs; it takes sections, not documents.
 */

import {
  resolveDocumentPrecedence,
  isDocumentEnabled,
  isSameDocumentFilename
} from './knowledge-schema.js';

export const CONFLICT_SEVERITY = Object.freeze({
  /** Equal authority and contradicting: comments here will skip. The user must fix it. */
  BLOCKING: 'blocking',
  /** One document wins by precedence; the other is inert. Informational. */
  SHADOWED: 'shadowed',
});

/** Bound on reported conflicts, so a pathological base cannot produce a huge payload. */
export const MAX_REPORTED_CONFLICTS = 100;

/**
 * The heading text, used as the key that decides whether two documents are talking about the
 * same thing.
 *
 * @param {Object} section
 * @returns {string}
 */
export function headingOf(section) {
  const path = Array.isArray(section?.headingPath) ? section.headingPath : [];
  return path.join(' / ') || String(section?.heading || '(no heading)');
}

/**
 * Find a heading both section sets carry with differing content.
 *
 * Compares trimmed content verbatim and treats only EXACT equality as agreement. Normalising
 * would call "350 جنيه" and "350 جنيه." a match, and the two files may still differ elsewhere;
 * a miss here means a real contradiction goes unreported, so the comparison is deliberately
 * blunt.
 *
 * @param {Array<Object>} sectionsA
 * @param {Array<Object>} sectionsB
 * @returns {{heading: string}|null}
 */
export function findDisagreement(sectionsA, sectionsB) {
  const headingsA = new Map();
  for (const section of Array.isArray(sectionsA) ? sectionsA : []) {
    if (!section) continue;
    const key = headingOf(section).trim();
    if (!headingsA.has(key)) headingsA.set(key, []);
    headingsA.get(key).push(String(section.content || '').trim());
  }

  for (const section of Array.isArray(sectionsB) ? sectionsB : []) {
    if (!section) continue;
    const key = headingOf(section).trim();
    if (!headingsA.has(key)) continue;

    for (const contentA of headingsA.get(key)) {
      const contentB = String(section.content || '').trim();
      if (contentA !== contentB) return { heading: key };
    }
  }
  return null;
}

/**
 * Group sections by their source document, dropping disabled ones.
 *
 * A disabled document is out of scope rather than contradictory. Mixing it in would make any
 * base with one switched-off file look broken, which is the same rule 20.1's precedence
 * resolver already applies.
 *
 * The document id and its sections are kept in ONE entry. Pairing them back together by looking
 * an id up a second time would be a second source of truth for the same relationship.
 *
 * @param {Array<Object>} sections
 * @returns {Array<{document: Object, sections: Array<Object>}>}
 */
export function groupSectionsByDocument(sections) {
  const entries = new Map();

  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section) continue;
    const docId = String(section.documentId || '');
    if (!docId) continue;

    // The synthesized document must carry the SAME authority fields a real document
    // object does, or `resolveDocumentPrecedence()` compares two documents whose priority,
    // version and edit time were never read — sees them as equal, and reports every
    // contradiction as ambiguous. That silently defeated §18's mechanisms for any caller
    // that passes index sections rather than whole documents, which is both of them.
    const document = section.document || {
      id: docId,
      filename: section.filename,
      enabled: section.enabled !== false,
      priority: typeof section.priority === 'number' ? section.priority : 0,
      version: typeof section.version === 'number' ? section.version : 1,
      updatedAt: typeof section.updatedAt === 'number' ? section.updatedAt : 0
    };
    if (!isDocumentEnabled(document)) continue;

    if (!entries.has(docId)) entries.set(docId, { document, sections: [] });
    entries.get(docId).sections.push(section);
  }

  return [...entries.values()];
}

/** A stable, human-usable name for a document. */
function nameOf(document) {
  return String(document?.filename || document?.id || 'unknown');
}

/**
 * What the user can do about a blocking conflict, phrased as actions.
 *
 * Given as concrete instructions rather than a verdict, because §18's whole point is that the
 * resolution is the user's to make. Telling them "equal authority" without saying what equal
 * authority means in practice just moves the question.
 *
 * @param {Array<Object>} documents
 * @returns {string[]}
 */
export function buildResolutionSteps(documents) {
  const names = documents.map(nameOf);
  if (names.length < 2) return [];

  return [
    `Give one of them a higher priority: ${names.join(', ')}.`,
    `Or bump the version of the correct one — a later version supersedes what it replaced.`,
    'Or disable the one that should no longer be used, if it is kept only for reference.',
    'Note that renaming or re-saving does not decide this: only priority, version, enabled ' +
      'and the last-edited time do.'
  ];
}

/**
 * Decide whether a set of sections from several documents conflicts.
 *
 * This is the per-comment decision 20.7's gate needs, and it is deliberately shared rather than
 * reimplemented — see the file header.
 *
 * @param {Array<Object>} sections
 * @returns {{conflicting: boolean, severity: string, documents: Array<Object>, winner: (Object|null),
 *   heading: string, reason: string}}
 */
export function resolveSectionConflict(sections) {
  const groups = groupSectionsByDocument(sections);

  if (groups.length < 2) {
    return { conflicting: false, severity: '', documents: [], winner: null, heading: '', reason: 'sections come from one document' };
  }

  const documents = groups.map((entry) => entry.document);
  const precedence = resolveDocumentPrecedence(documents);

  // Authority is not equal, so §18's mechanisms have decided it. Not a conflict for the gate.
  if (!precedence.ambiguous) {
    return {
      conflicting: false,
      severity: '',
      documents,
      // Exposed rather than just named in the reason, so a caller — and the packaging check —
      // can assert WHICH document won without re-deriving precedence. Grepping for a call to
      // `resolveDocumentPrecedence` proves ownership only textually; this makes it observable.
      winner: precedence.winner || null,
      heading: '',
      reason: precedence.winner
        ? `resolved by precedence: ${nameOf(precedence.winner)} wins`
        : precedence.reason
    };
  }

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const pair = findDisagreement(groups[i].sections, groups[j].sections);
      if (!pair) continue;

      return {
        conflicting: true,
        severity: CONFLICT_SEVERITY.BLOCKING,
        documents,
        // Equal authority means nobody wins, and reporting a winner here would be exactly the
        // guess §18 forbids.
        winner: null,
        heading: pair.heading,
        reason:
          `${nameOf(groups[i].document)} and ${nameOf(groups[j].document)} give different ` +
          `content under the same heading (${pair.heading}) and have equal authority`
      };
    }
  }

  // Equal authority but nothing contradicts: they may simply cover different subjects. Not a
  // conflict, and reporting it as one would make a well-organised base look broken.
  return {
    conflicting: false,
    severity: '',
    documents,
    winner: null,
    heading: '',
    reason: 'equal authority, but no contradiction under a shared heading'
  };
}

/**
 * Audit a whole knowledge base for contradictions.
 *
 * Reports BLOCKING conflicts and SHADOWED documents separately, so the two are never confused:
 * a shadowed file needs no urgent action and a blocking one does.
 *
 * Takes INDEXED SECTIONS rather than documents, because the sections are what carry the
 * content a contradiction is about, and they are already parsed and fingerprinted by 20.4. It
 * does not read storage and does not check freshness — the caller passes whatever index it has,
 * and auditing a stale index is still better than telling a user their base is fine.
 *
 * @param {Array<Object>} sections - every indexed section, not just the retrieved ones
 * @returns {{conflicts: Array<Object>, shadowed: Array<Object>, documentCount: number,
 *   hasBlockingConflicts: boolean}}
 */
export function auditKnowledgeConflicts(sections) {
  const groups = groupSectionsByDocument(sections);
  const documents = groups.map((entry) => entry.document);
  const conflicts = [];
  const shadowed = [];

  // Priority decides whether the whole base is decided at all. If two documents share the top
  // priority and disagree, that is blocking regardless of what any other document does.
  const precedence = resolveDocumentPrecedence(documents);
  const ambiguous = precedence.ambiguous;

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const pair = findDisagreement(a.sections, b.sections);

      if (!pair) {
        // No contradiction, but one of them may still never be reached. Reported so the user
        // learns their file is inert rather than wondering why it never shows up.
        const decided = resolveDocumentPrecedence([a.document, b.document]);
        if (!decided.ambiguous && decided.winner) {
          const loser = decided.winner.id === a.document.id ? b.document : a.document;
          shadowed.push({
            documentId: String(loser.id || ''),
            filename: nameOf(loser),
            winner: nameOf(decided.winner),
            reason: decided.reason
          });
        }
        continue;
      }

      // A contradiction that precedence already decides is not blocking — §18's mechanisms
      // have answered it, and only the losing document's author is in the dark.
      const pairPrecedence = resolveDocumentPrecedence([a.document, b.document]);
      if (!pairPrecedence.ambiguous && pairPrecedence.winner) {
        const loser = pairPrecedence.winner.id === a.document.id ? b.document : a.document;
        shadowed.push({
          documentId: String(loser.id || ''),
          filename: nameOf(loser),
          winner: nameOf(pairPrecedence.winner),
          reason: `${nameOf(pairPrecedence.winner)} wins on precedence, so the contradiction under "${pair.heading}" never reaches a reply`,
          heading: pair.heading
        });
        continue;
      }

      conflicts.push({
        severity: CONFLICT_SEVERITY.BLOCKING,
        heading: pair.heading,
        reason:
          `${nameOf(a.document)} and ${nameOf(b.document)} give different content under the ` +
          `same heading (${pair.heading}) and have equal authority, so comments about it are skipped`,
        documents: [a.document, b.document].map((document) => ({
          id: String(document.id || ''),
          filename: nameOf(document),
          priority: typeof document.priority === 'number' ? document.priority : 0,
          version: typeof document.version === 'number' ? document.version : 1,
          updatedAt: typeof document.updatedAt === 'number' ? document.updatedAt : 0,
          enabled: isDocumentEnabled(document)
        })),
        resolutions: buildResolutionSteps([a.document, b.document])
      });

      if (conflicts.length >= MAX_REPORTED_CONFLICTS) break;
    }
    if (conflicts.length >= MAX_REPORTED_CONFLICTS) break;
  }

  return {
    conflicts,
    shadowed,
    documentCount: documents.length,
    hasBlockingConflicts: conflicts.length > 0
  };
}

/**
 * Whether two documents describe the same file.
 *
 * Re-exported because a base-wide audit is the natural place a caller needs it — deciding
 * which of two files to rename or disable — and duplicating the comparison would be a second
 * answer to the same question.
 */
export { isSameDocumentFilename };