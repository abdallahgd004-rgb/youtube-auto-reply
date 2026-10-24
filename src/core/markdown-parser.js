/**
 * Markdown Parser — Phase 20.3
 *
 * Turns one knowledge document into its SECTIONS: a heading and the body that belongs to
 * it. This is what makes a knowledge base searchable rather than one blob of text per file,
 * and it is the layer that gives every fact the traceability §7 asks for — a section knows
 * its source document and its heading path, so a reply can cite `books/chemistry.md →
 * السعر` rather than "something in the knowledge base".
 *
 * WHAT A SECTION IS
 * -----------------
 * One heading plus its OWN body, and nothing else:
 *
 *   ```md
 *   # كيمياء                 ← a section with no body (empty, but real structure)
 *   ## تالتة ثانوي
 *   ### السعر
 *   350 جنيه                 ← the section's content
 *   ## الشحن
 *   30 جنيه                  ← a sibling, not part of السعر
 *   ```
 *
 *   →  [ ].headingPath = ['كيمياء', 'تالتة ثانوي', 'السعر'],  content = '350 جنيه'
 *
 * A parent does NOT contain its children. That is deliberate: if "كيمياء" carried the price
 * AND the shipping text, then answering a shipping question with the price section would
 * look supported by a section that never mentioned shipping — which is precisely the hole
 * the grounding validator (20.10) exists to close, created by the chunker instead.
 *
 * WHAT THIS PRESERVES, AND WHY
 * ----------------------------
 * §5 says the parser should preserve the original useful text rather than aggressively
 * rewriting it. So bodies are kept as written — list markers, blank lines between
 * paragraphs, block quotes, tables, fences — and only leading/trailing blank lines are
 * dropped. Nothing is re-wrapped, re-indented or "cleaned up". The one thing that IS
 * interpreted is structure: which lines are headings, and which are inside a code fence.
 *
 * WHY THE MARKDOWN EDGE CASES ARE HANDLED RATHER THAN ASSUMED AWAY
 * ---------------------------------------------------------------
 * §5 lists "invalid or unusual Markdown" among the things that must not crash the
 * extension, but the real risk is not a crash — it is a SILENT MISPARSE. Two of them would
 * corrupt the knowledge base without any error:
 *
 *   - A `#` line inside a fenced code block. A user documenting a pricing script writes
 *     `# the price is 350`. Read as a heading, the real price line becomes a heading with
 *     no body and the answer disappears. Fences are tracked, and their contents are body
 *     text verbatim.
 *   - `#Heading` with no space. CommonMark says that is NOT a heading, and so does this
 *     parser: it stays body text. The failure mode of getting this backwards is that a
 *     line of prose is swallowed and its content is lost.
 *
 * TWO DELIBERATE BOUNDARIES
 * -------------------------
 * 1. An oversized body is NOT split here. §7 asks for chunks "rather than arbitrary giant
 *    blocks", and a 100,000-character section really would be a problem to send to a model.
 *    But splitting a section gives its pieces the SAME heading path, hence the SAME evidence
 *    id, and a duplicate evidence id is a grounding-validation hole: a reply could cite the
 *    wrong piece and pass. Chunking belongs to the index (20.4), where chunk size and
 *    evidence disambiguation can be decided together. Until then one heading is one section,
 *    always.
 * 2. Empty sections are KEPT. A heading the user wrote with no body under it is real
 *    structure — "## ملاحظات" with nothing after it — and dropping it would change the
 *    shape of the document. `toKnowledgeSection()` marks it `empty` so retrieval can skip
 *    it without the parser having to lie about the hierarchy.
 *
 * Platform-agnostic: no `chrome.*`, no DOM, no network, and it never throws.
 */

import { toKnowledgeSection } from './knowledge-schema.js';

/**
 * An ATX heading: up to three leading spaces (CommonMark), 1–6 hashes, then either a space
 * or the end of the line.
 *
 * The space-or-end requirement is load-bearing. Without it `#Heading` parses as a heading
 * and the line vanishes from the body; §7 requires sections to trace back to "original
 * content", so content must never disappear. Seven or more hashes is not a heading either,
 * and this expression already refuses it — the run cannot be followed by another `#` and
 * still satisfy the trailing requirement.
 */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * A closing sequence of hashes at the end of a heading line, which CommonMark strips:
 * `## السعر ##` renders as "السعر".
 */
const ATX_CLOSING = /[ \t]+#+[ \t]*$/;

/** A setext underline. `===` is level 1, `---` is level 2. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Split text into lines, tolerating every line ending a user can realistically produce.
 *
 * `\r\n` is the important one: a knowledge file authored on Windows and pasted into a
 * browser textarea arrives with carriage returns still attached. Left in place they end up
 * inside section content and in every hash computed from it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  // A byte-order mark survives a copy-paste from a UTF-8 file and would otherwise become
  // part of the first line, i.e. part of the first heading or the first body.
  const clean = String(text).replace(/^﻿/, '');  return clean.split(/\r\n|\r|\n/);
}

/**
 * Reduce a document to a flat list of blocks.
 *
 * Two phases on purpose. Reading the whole file into blocks first means a setext underline
 * can be resolved by looking at the line before it, and a fence can swallow the lines after
 * it, without either case needing to un-append text from a half-built section.
 *
 * @param {string} text
 * @returns {Array<{type: string, level?: number, text?: string, lines?: string[]}>}
 */
function tokenize(text) {
  const lines = toLines(text);
  const blocks = [];
  let body = [];

  /** Flush the accumulated body lines as one block. */
  const flushBody = () => {
    if (body.length > 0) {
      blocks.push({ type: 'body', lines: body });
      body = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Fenced code ─────────────────────────────────────────────────────────
    const fence = FENCE.exec(line);
    if (fence) {
      flushBody();
      const marker = fence[1];
      const char = marker[0];
      // A backtick info string may not itself contain a backtick, per CommonMark. Ignoring
      // that rule here would only mean treating such a line as text instead of a fence,
      // which is the harmless direction.
      const isFenceStart = char !== '`' || !fence[2].includes('`');
      if (isFenceStart) {
        const collected = [line];
        // The closing fence must use the same character and be at least as long, so a
        // four-backtick fence can contain a three-backtick line without ending early.
        const closeRe = new RegExp(`^ {0,3}${char === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
        while (++i < lines.length) {
          collected.push(lines[i]);
          if (closeRe.test(lines[i])) break;
        }
        blocks.push({ type: 'body', lines: collected });
        continue;
      }
    }

    // ── ATX heading ─────────────────────────────────────────────────────────
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      flushBody();
      const level = atx[1].length;
      const raw = atx[2] === undefined ? '' : atx[2];
      blocks.push({ type: 'heading', level, text: raw.replace(ATX_CLOSING, '').trim() });
      continue;
    }

    // ── Setext heading ──────────────────────────────────────────────────────
    // Only when the previous line is real text. A `---` after a blank line, or at the very
    // top of the file, is a thematic break — and a document that opens with `---` must not
    // produce a heading with no title.
    const setext = SETEXT_UNDERLINE.exec(line);
    if (setext && body.length > 0) {
      const previous = body[body.length - 1];
      if (previous.trim() !== '') {
        body.pop();
        flushBody();
        blocks.push({
          type: 'heading',
          level: setext[1][0] === '=' ? 1 : 2,
          text: previous.trim()
        });
        continue;
      }
    }

    body.push(line);
  }

  flushBody();
  return blocks;
}

/**
 * Join body lines into section content.
 *
 * Only blank lines at the edges are removed. Interior blank lines are kept because they are
 * paragraph structure — collapsing them would merge two separate statements into one line,
 * and a price and its caveat becoming a single sentence is how a grounded reply ends up
 * asserting something the document never quite said.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function toContent(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

/**
 * Parse one Markdown document into section records.
 *
 * The records are document-agnostic: heading path, level, content and ordinal. Source
 * mapping is `parseDocumentSections()`'s job, because only the caller knows which document
 * these lines came from.
 *
 * @param {string} text - the document's Markdown
 * @returns {Array<{headingPath: string[], headingLevel: number, content: string, ordinal: number}>}
 *   never throws; junk in produces `[]` or a single preamble section
 */
export function parseMarkdownSections(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const blocks = tokenize(text);

  // The heading stack holds the current ANCESTOR chain. `headingLevel` on a section is its
  // OWN level, which is what a UI needs to indent by; `headingPath` is what retrieval and
  // the evidence id need.
  const stack = [];
  const sections = [];

  /** Emit the section currently being accumulated. */
  const emit = (headingLevel, lines) => {
    const content = toContent(lines);
    // The preamble — content before the first heading — is emitted only when it has
    // content. An empty preamble is not user structure, it is an artifact of a file that
    // starts with a heading. Empty HEADINGS are the opposite case and are always kept.
    if (headingLevel === 0 && content === '') return;
    sections.push({
      headingPath: stack.map((entry) => entry.text),
      headingLevel,
      content,
      ordinal: sections.length
    });
  };

  let body = [];
  for (const block of blocks) {
    if (block.type === 'body') {
      body = body.concat(block.lines);
      continue;
    }

    emit(stack.length ? stack[stack.length - 1].level : 0, body);
    body = [];

    // Pop everything at or below the new heading's level, then push. A level JUMP — `#`
    // straight to `###` — simply does not invent the missing intermediate levels; the path
    // reads ['كيمياء', 'السعر'], which is what the document actually says.
    while (stack.length && stack[stack.length - 1].level >= block.level) {
      stack.pop();
    }
    stack.push({ level: block.level, text: block.text });
  }

  emit(stack.length ? stack[stack.length - 1].level : 0, body);
  return sections;
}

/**
 * Parse a stored knowledge document into full section records.
 *
 * This is the source-mapping half: each section comes back with the document id, filename,
 * category and evidence id it will be cited under, so a caller never has to join two lists
 * afterwards and get the pairing wrong.
 *
 * `headingLevel` is carried onto the section because it is not part of the 20.1 shape: it is
 * presentation depth for the UI, not something retrieval or grounding reads.
 *
 * @param {Object} document - a stored knowledge document
 * @returns {Array<Object>} sections in document order; `[]` for an unusable document
 */
export function parseDocumentSections(document) {
  if (!document || typeof document !== 'object') return [];

  const parsed = parseMarkdownSections(document.content);
  const sections = [];

  for (const section of parsed) {
    const built = toKnowledgeSection({
      document,
      headingPath: section.headingPath,
      content: section.content,
      ordinal: section.ordinal
    });
    if (!built) continue;
    sections.push({ ...built, headingLevel: section.headingLevel });
  }

  return sections;
}

/**
 * The heading outline of a document, for the UI's "view document information" (§4).
 *
 * Reads the same tokenizer, so what the outline shows and what the index will contain can
 * never disagree.
 *
 * @param {string} text
 * @returns {Array<{level: number, text: string, path: string[]}>}
 */
export function extractHeadings(text) {
  if (typeof text !== 'string') return [];

  const stack = [];
  const headings = [];

  for (const block of tokenize(text)) {
    if (block.type !== 'heading') continue;
    while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
    stack.push({ level: block.level, text: block.text });
    headings.push({ level: block.level, text: block.text, path: stack.map((entry) => entry.text) });
  }

  return headings;
}
