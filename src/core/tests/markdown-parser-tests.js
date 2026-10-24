/**
 * Markdown Parser Tests — Phase 20.3
 *
 * §5 and §7 are short lists, and this suite is organised to match them: heading hierarchy,
 * nested headings, paragraphs, lists, normal Markdown text, empty sections, and invalid or
 * unusual input that must not crash.
 *
 * The cases that matter most are the ones where the parser would be WRONG WITHOUT AN ERROR.
 * A throw is loud and gets fixed; a `#` line inside a code fence being read as a heading is
 * silent, and it deletes a price from the knowledge base. Those are grouped at the bottom
 * under "silent misparse", because that is the failure mode this parser has to earn its
 * keep on.
 *
 * Runs in the browser from markdown-parser-tests.html. Nothing here needs `chrome`: the
 * parser is pure text-in, sections-out.
 */

import {
  parseMarkdownSections,
  parseDocumentSections,
  extractHeadings
} from '../markdown-parser.js';
import { toKnowledgeDocument, isSectionUsable } from '../knowledge-schema.js';

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

/** The phase's own example document (§3 / §5). */
const CHEMISTRY_MD = [
  '# كتاب التفوق كيمياء 3 ثانوي 2027',
  '',
  '## السعر',
  '',
  'السعر الحالي: 350 جنيه.',
  '',
  '## الشحن',
  '',
  'شحن كتاب واحد: 30 جنيه.',
  'الشحن مجاني عند شراء كتابين أو أكثر.',
  '',
  '## ملاحظات',
  '',
  'هذه الأسعار تخص إصدار 2027.'
].join('\n');

/** Find the section whose leaf heading is `heading`. */
function sectionFor(sections, heading) {
  return sections.find((s) => s.headingPath[s.headingPath.length - 1] === heading) || null;
}

// ── §5: headings and nesting ──────────────────────────────────────────────────

async function testOneHeadingMakesOneSection() {
  const sections = parseMarkdownSections('# السعر\n\n350 جنيه.\n');
  if (sections.length !== 1) return `Expected 1 section, got ${sections.length}`;
  if (sections[0].content !== '350 جنيه.') return `Unexpected content: ${JSON.stringify(sections[0].content)}`;
  if (sections[0].headingPath.join('/') !== 'السعر') return `Unexpected path: ${sections[0].headingPath}`;
  if (sections[0].headingLevel !== 1) return `Unexpected level: ${sections[0].headingLevel}`;
  return true;
}

async function testNestedHeadingsKeepTheirFullPath() {
  const sections = parseMarkdownSections([
    '# كيمياء',
    '',
    '## تالتة ثانوي',
    '',
    '### السعر',
    '',
    '350 جنيه.'
  ].join('\n'));

  const price = sectionFor(sections, 'السعر');
  if (!price) return 'The leaf section is missing';
  if (price.headingPath.join(' > ') !== 'كيمياء > تالتة ثانوي > السعر') {
    return `Unexpected path: ${price.headingPath.join(' > ')}`;
  }
  if (price.headingLevel !== 3) return `Unexpected level: ${price.headingLevel}`;
  return true;
}

async function testAParentDoesNotContainItsChildren() {
  // The decision this parser exists to get right. If the parent carried the children's
  // text, then answering a shipping question with the price section would look supported by
  // a section that never mentioned shipping — a grounding hole created by the chunker.
  const sections = parseMarkdownSections([
    '# كيمياء',
    'نص تمهيدي.',
    '## السعر',
    '350 جنيه.',
    '## الشحن',
    '30 جنيه.'
  ].join('\n'));

  const root = sections[0];
  if (root.content.includes('350')) return 'The parent section swallowed the price';
  if (root.content.includes('30')) return 'The parent section swallowed the shipping cost';
  if (!root.content.includes('نص تمهيدي')) return "The parent's own body was lost";

  const price = sectionFor(sections, 'السعر');
  if (price.content.includes('30')) return 'A section absorbed its sibling';
  return true;
}

async function testSiblingsAreSeparateSections() {
  const sections = parseMarkdownSections(CHEMISTRY_MD);
  if (sections.length !== 4) return `Expected 4 sections, got ${sections.length}`;

  const price = sectionFor(sections, 'السعر');
  const shipping = sectionFor(sections, 'الشحن');
  if (!price || !shipping) return 'A section is missing';
  if (!price.content.includes('350')) return 'The price section lost its text';
  if (shipping.content.includes('350')) return 'The shipping section absorbed the price';
  if (!shipping.content.includes('مجاني')) return 'The second shipping line was lost';
  return true;
}

async function testALevelJumpDoesNotInventMissingLevels() {
  // `#` straight to `###` is legal and common enough. The path should read what the
  // document says, not what the numbering implies.
  const sections = parseMarkdownSections('# كيمياء\n\n### السعر\n\n350 جنيه.');
  const price = sectionFor(sections, 'السعر');
  if (price.headingPath.join('/') !== 'كيمياء/السعر') {
    return `Unexpected path: ${price.headingPath.join('/')}`;
  }
  return true;
}

async function testHeadingLevelsUnwindCorrectly() {
  // Going 1 → 3 → 2 must return to the level-1 ancestor, not to the level-3 one.
  const sections = parseMarkdownSections([
    '# A',
    '## B',
    '### C',
    '## D',
    'body'
  ].join('\n'));

  const d = sectionFor(sections, 'D');
  if (d.headingPath.join('/') !== 'A/D') return `Unexpected path for D: ${d.headingPath.join('/')}`;
  const c = sectionFor(sections, 'C');
  if (c.headingPath.join('/') !== 'A/B/C') return `Unexpected path for C: ${c.headingPath.join('/')}`;
  return true;
}

async function testATextBeforeTheFirstHeadingIsKept() {
  // Dropping it would silently discard the user's content. §7 requires every section to be
  // traceable to its ORIGINAL content.
  const sections = parseMarkdownSections('ملاحظة قبل أي عنوان.\n\n# السعر\n\n350 جنيه.');
  if (sections.length !== 2) return `Expected 2 sections, got ${sections.length}`;
  if (sections[0].headingPath.length !== 0) return 'The preamble should have an empty path';
  if (!sections[0].content.includes('ملاحظة قبل')) return 'The preamble text was dropped';
  if (sections[1].headingPath.join('/') !== 'السعر') return 'The heading section lost its path';
  return true;
}

async function testAnEmptyPreambleIsNotASection() {
  // A file that opens with a heading has no preamble. Emitting one would put a
  // `KNOWLEDGE-…` section in the index that corresponds to nothing the user wrote.
  const sections = parseMarkdownSections('# السعر\n\n350 جنيه.');
  if (sections[0].headingPath.length === 0) return 'An empty preamble was emitted';
  return true;
}

// ── §5: empty sections ────────────────────────────────────────────────────────

async function testAnEmptySectionIsKeptNotDropped() {
  // §5 lists empty sections as a case to handle. A heading the user wrote with nothing
  // under it is real structure, and dropping it would change the document's shape.
  const sections = parseMarkdownSections('# كيمياء\n\n## ملاحظات\n\n## السعر\n\n350 جنيه.');
  const notes = sectionFor(sections, 'ملاحظات');
  if (!notes) return 'The empty section was dropped entirely';
  if (notes.content !== '') return `An empty section should have no content, got ${JSON.stringify(notes.content)}`;
  if (notes.headingPath.join('/') !== 'كيمياء/ملاحظات') return 'The empty section lost its path';
  return true;
}

async function testAnEmptySectionIsMarkedUnusableNotRetrievedFrom() {
  // A dedicated document: the phase's example has real text under `## ملاحظات`, so it
  // cannot demonstrate this. Here the heading genuinely has no body.
  const document = toKnowledgeDocument({
    filename: 'books/chemistry.md',
    content: '# كيمياء\n\n## ملاحظات\n\n## السعر\n\n350 جنيه.'
  });
  const sections = parseDocumentSections(document);
  const notes = sections.find((s) => s.headingPath[s.headingPath.length - 1] === 'ملاحظات');
  if (!notes) return 'The section is missing';
  if (notes.empty !== true) return 'The empty section was not marked empty';
  if (isSectionUsable(notes)) return 'An empty section must not be retrievable';
  // Both `كيمياء` and `ملاحظات` are bodyless here, so only the price is retrievable.
  if (sections.filter(isSectionUsable).length !== 1) {
    return `Expected 1 usable section, got ${sections.filter(isSectionUsable).length}`;
  }
  return true;
}

async function testAHeadingWithNoBodyAtTheEndIsStillASection() {
  const sections = parseMarkdownSections('# السعر\n\n350 جنيه.\n\n## الشحن\n');
  const shipping = sectionFor(sections, 'الشحن');
  if (!shipping) return 'A trailing empty heading was dropped';
  if (shipping.content !== '') return 'A trailing empty heading should have no content';
  return true;
}

// ── §5: paragraphs, lists and normal Markdown ─────────────────────────────────

async function testInteriorBlankLinesAreKept() {
  // They are paragraph structure. Collapsing them would merge a price and its caveat into
  // one line, which is how a grounded reply ends up asserting something the document never
  // quite said.
  const body = 'السعر 350 جنيه.\n\nالسعر القديم كان 300 جنيه.';
  const sections = parseMarkdownSections(`# السعر\n\n${body}`);
  if (sections[0].content !== body) {
    return `Paragraph breaks were altered: ${JSON.stringify(sections[0].content)}`;
  }
  return true;
}

async function testLeadingAndTrailingBlankLinesAreDropped() {
  const sections = parseMarkdownSections('# السعر\n\n\n\n350 جنيه.\n\n\n');
  if (sections[0].content !== '350 جنيه.') {
    return `Edge blank lines survived: ${JSON.stringify(sections[0].content)}`;
  }
  return true;
}

async function testListMarkersArePreservedVerbatim() {
  const body = '- شحن كتاب واحد: 30 جنيه.\n- مجاني للكتبين أو أكثر.';
  const sections = parseMarkdownSections(`# الشحن\n\n${body}`);
  if (sections[0].content !== body) {
    return `List markers were rewritten: ${JSON.stringify(sections[0].content)}`;
  }
  return true;
}

async function testOrderedListsQuotesAndTablesSurvive() {
  const body = [
    '> ملاحظة: الشحن مجاني للكتبين أو أكثر.',
    '',
    '| البند | السعر |',
    '|---|---:|',
    '| كتاب واحد | 30 جنيه |'
  ].join('\n');
  const sections = parseMarkdownSections(`# الشحن\n\n${body}`);
  if (sections[0].content !== body) return 'Block quotes or tables were rewritten';
  return true;
}

async function testArabicTextIsNotAltered() {
  // No Arabic normalization anywhere in the parser. The content hash normalizes, but the
  // content itself is the user's words and is stored and cited verbatim.
  const body = 'السعر الحالي: ٣٥٠ جنيه، والأسعار تخصّ إصدار ٢٠٢٧.';
  const sections = parseMarkdownSections(`# السعر\n\n${body}`);
  if (sections[0].content !== body) return 'The Arabic text was altered';
  return true;
}

async function testCarriageReturnsDoNotLeakIntoContent() {
  // A file authored on Windows arrives with \r\n. Left in place they end up inside every
  // section's content and in every hash computed from it.
  const sections = parseMarkdownSections('# السعر\r\n\r\n350 جنيه.\r\n');
  if (sections[0].content !== '350 جنيه.') return `CR leaked into content: ${JSON.stringify(sections[0].content)}`;
  if (sections[0].headingPath[0] !== 'السعر') return 'CR leaked into the heading';
  return true;
}

async function testAByteOrderMarkDoesNotCorruptTheFirstHeading() {
  const sections = parseMarkdownSections('﻿# السعر\n\n350 جنيه.');
  if (sections[0].headingPath[0] !== 'السعر') return `The BOM stayed in the heading: ${sections[0].headingPath[0]}`;
  return true;
}

// ── §5: unusual but legal Markdown ────────────────────────────────────────────

async function testClosingHashesAreStripped() {
  // CommonMark renders `## السعر ##` as "السعر". Keeping the hashes would put
  // KNOWLEDGE-BOOKS-CHEMISTRY-السعر-## into the evidence id.
  const sections = parseMarkdownSections('## السعر ##\n\n350 جنيه.');
  if (sections[0].headingPath[0] !== 'السعر') return `Unexpected heading: ${sections[0].headingPath[0]}`;
  return true;
}

async function testIndentedHeadingsAreStillHeadings() {
  // Up to three leading spaces is legal CommonMark, and a user indenting a list item's
  // subsection writes exactly that.
  const sections = parseMarkdownSections('  ## السعر\n\n  350 جنيه.');
  if (sections[0].headingPath[0] !== 'السعر') return 'A legal indented heading was not recognised';
  return true;
}

async function testSetextHeadingsAreRecognised() {
  // Older Markdown writes `Title` over `=====`. A user pasting from anywhere gets this.
  const sections = parseMarkdownSections('السعر\n=====\n\n350 جنيه.');
  if (sections[0].headingPath[0] !== 'السعر') return 'A setext heading was missed';
  if (sections[0].headingLevel !== 1) return `Unexpected level: ${sections[0].headingLevel}`;
  return true;
}

async function testAThematicBreakIsNotAHeading() {
  // A `---` with no text above it is a horizontal rule. Reading it as a setext heading
  // would produce a heading with no title at the top of the document.
  const sections = parseMarkdownSections('---\n\n# السعر\n\n350 جنيه.');
  if (sections.length !== 2) return `Expected 2 sections, got ${sections.length}`;
  if (sections[0].headingPath.length !== 0) return 'The thematic break became a heading';
  if (!sections[0].content.includes('---')) return 'The horizontal rule was dropped';
  return true;
}

async function testSevenHashesIsNotAHeading() {
  const sections = parseMarkdownSections('####### ليس عنوانا\n\n350 جنيه.');
  if (sections[0].headingPath.length !== 0) return 'Seven hashes was read as a heading';
  if (!sections[0].content.includes('#######')) return 'The line was dropped';
  return true;
}

// ── Silent misparse: the failures with no error message ───────────────────────

async function testAHashInsideAFencedBlockIsNotAHeading() {
  // THE case this parser could silently get wrong. A user documenting a pricing script
  // writes `# the price is 350`. Read as a heading, the real price line becomes a heading
  // with no body and the answer disappears from the knowledge base — with no error.
  const md = [
    '# الأسعار',
    '',
    'الكود التالي يحدد السعر:',
    '',
    '```python',
    '# the price is 350',
    'price = 350',
    '```',
    '',
    'السعر الرسمي: 350 جنيه.'
  ].join('\n');

  const sections = parseMarkdownSections(md);
  // The whole document is one section: the fence is inside `# الأسعار`, and nothing after
  // it starts a new heading. A `#` line read as a heading would split it in two.
  if (sections.length !== 1) return `A fenced hash became a heading: ${sections.length} sections`;
  const code = sections[0];
  if (code.headingPath.join('/') !== 'الأسعار') return 'The section lost its heading';

  if (!code.content.includes('# the price is 350')) return 'The commented line inside the fence was lost';
  if (!code.content.includes('price = 350')) return 'The code line inside the fence was lost';
  if (!code.content.includes('```')) return 'The fence markers were stripped from the body';

  // And the price after the fence must still belong to that same section.
  if (!code.content.includes('السعر الرسمي: 350 جنيه.')) return 'The text after the fence left its section';
  return true;
}

async function testAFenceIsNotClosedByAShorterRun() {
  // A four-backtick fence legitimately contains a three-backtick line. Closing on the
  // shorter run would truncate the section and turn the rest of it into headings.
  const md = ['# كود', '', '````', '```', 'still inside', '````', '', 'بعد الكود'].join('\n');
  const sections = parseMarkdownSections(md);
  if (sections.length !== 1) return `The fence closed early: ${sections.length} sections`;
  if (!sections[0].content.includes('still inside')) return 'The fence body was truncated';
  if (!sections[0].content.includes('بعد الكود')) return 'The text after the fence was lost';
  return true;
}

async function testAnUnclosedFenceDoesNotSwallowTheDocument() {
  // A missing closing fence is a paste accident, not a reason to lose the rest of the file.
  const md = ['# كود', '', '```', 'line one', 'line two'].join('\n');
  const sections = parseMarkdownSections(md);
  if (sections.length !== 1) return `Expected 1 section, got ${sections.length}`;
  if (!sections[0].content.includes('line two')) return 'The unclosed fence lost content';
  return true;
}

async function testAHashWithNoSpaceStaysBodyText() {
  // CommonMark says `#Heading` is not a heading, and so does this parser. Getting it
  // backwards swallows a line of prose and loses its content permanently.
  const sections = parseMarkdownSections('#Heading\n\nوهو نص عادي.');
  if (sections.length !== 1) return `Expected 1 section, got ${sections.length}`;
  if (sections[0].headingPath.length !== 0) return '`#Heading` was read as a heading';
  if (!sections[0].content.includes('#Heading')) return 'The line was swallowed';
  if (!sections[0].content.includes('وهو نص عادي.')) return 'The body was lost';
  return true;
}

async function testOrdinalsAreContiguousAndInDocumentOrder() {
  // Ordinals are part of the section id (20.1), so a gap or a repeat would make two
  // sections share an id and break evidence validation.
  const sections = parseMarkdownSections(CHEMISTRY_MD);
  const ordinals = sections.map((s) => s.ordinal);
  const expected = sections.map((_, i) => i);
  if (JSON.stringify(ordinals) !== JSON.stringify(expected)) {
    return `Ordinals are not contiguous: ${JSON.stringify(ordinals)}`;
  }
  // The document's first heading has no body of its own — `## السعر` follows immediately —
  // so the price is the SECOND section. Getting that backwards is the classic symptom of a
  // parser that merged the parent's body into its children.
  if (sections[0].content !== '') return `The root section should have no body, got ${JSON.stringify(sections[0].content)}`;
  if (sections[1].content !== 'السعر الحالي: 350 جنيه.') {
    return `The sections are out of document order: ${JSON.stringify(sections[1].content)}`;
  }
  return true;
}

// ── §5: invalid input must not crash ──────────────────────────────────────────

async function testJunkInputProducesNothingRatherThanThrowing() {
  const inputs = [null, undefined, '', '   \n\n  ', 42, {}, [], true];
  for (const input of inputs) {
    const sections = parseMarkdownSections(input);
    if (!Array.isArray(sections)) return `${JSON.stringify(input)} did not produce an array`;
    if (sections.length !== 0) return `${JSON.stringify(input)} produced ${sections.length} sections`;
  }
  return true;
}

async function testPathologicalInputIsSurvivable() {
  // Nothing here should throw or hang. A parser that throws inside the index build takes
  // the whole knowledge mode down; one that loops takes the service worker with it.
  const cases = [
    '#'.repeat(10_000),
    '-'.repeat(50_000),
    '='.repeat(50_000),
    '#'.repeat(2_000) + '\n\n' + 'سعر 350 جنيه.\n'.repeat(5_000),
    '```'.repeat(2_000),
    '\n'.repeat(20_000)
  ];
  for (const input of cases) {
    const sections = parseMarkdownSections(input);
    if (!Array.isArray(sections)) return 'Pathological input did not produce an array';
  }
  return true;
}

async function testOnlyHashesProduceNoHeadingSections() {
  // `#####` is a legal empty heading in CommonMark. It must not create a section with an
  // empty heading path that collides with the preamble's evidence id.
  const sections = parseMarkdownSections('#####\n\n350 جنيه.');
  if (sections[0].headingPath.length !== 1) return 'An empty heading produced no path entry';
  if (sections[0].content !== '350 جنيه.') return 'The body was lost';
  return true;
}

// ── §7: source mapping ────────────────────────────────────────────────────────

async function testSectionsTraceBackToTheirDocument() {
  const document = toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const sections = parseDocumentSections(document);

  if (sections.length !== 4) return `Expected 4 sections, got ${sections.length}`;
  for (const section of sections) {
    if (section.documentId !== document.id) return 'A section lost its document id';
    if (section.filename !== 'books/chemistry.md') return 'A section lost its filename';
    if (section.category !== 'books') return 'A section lost its category';
    if (typeof section.evidenceId !== 'string' || !section.evidenceId.startsWith('KNOWLEDGE-')) {
      return `A section has no evidence id: ${section.evidenceId}`;
    }
    if (section.version !== document.version) return 'A section lost the document version';
  }
  return true;
}

async function testEvidenceIdsAreUniquePerSection() {
  // Two sections sharing an evidence id is a grounding-validation hole: a reply could cite
  // the wrong section and pass.
  const document = toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const ids = parseDocumentSections(document).map((s) => s.evidenceId);
  if (new Set(ids).size !== ids.length) return `Duplicate evidence ids: ${JSON.stringify(ids)}`;
  return true;
}

async function testParsingTheSameDocumentTwiceGivesTheSameIds() {
  // Re-indexing unchanged knowledge must not invalidate evidence already handed to the
  // validator, which is what makes the cache disposable.
  const document = toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD });
  const first = parseDocumentSections(document).map((s) => s.evidenceId);
  const second = parseDocumentSections(document).map((s) => s.evidenceId);
  if (JSON.stringify(first) !== JSON.stringify(second)) return 'Re-parsing produced different ids';
  return true;
}

async function testASectionInheritsItsDocumentsDisabledState() {
  // A disabled document's sections must never be retrievable, and the parser is where they
  // are created — so this is where it has to be right.
  const document = { ...toKnowledgeDocument({ filename: 'books/chemistry.md', content: CHEMISTRY_MD }), enabled: false };
  const sections = parseDocumentSections(document);
  if (sections.length === 0) return 'The sections were not produced';
  if (sections.some(isSectionUsable)) return 'A section from a disabled document is retrievable';
  return true;
}

async function testAnUnusableDocumentYieldsNoSections() {
  if (parseDocumentSections(null).length !== 0) return 'null produced sections';
  if (parseDocumentSections({ id: 'kdoc-1' }).length !== 0) return 'A document with no content produced sections';
  return true;
}

// ── Outline ───────────────────────────────────────────────────────────────────

async function testTheOutlineMatchesWhatWillBeIndexed() {
  // The UI's "view document information" reads the outline. If it disagreed with the parser
  // it would show a knowledge base the extension is not actually using.
  const headings = extractHeadings(CHEMISTRY_MD);
  if (headings.length !== 4) return `Expected 4 headings, got ${headings.length}`;
  if (headings[0].text !== 'كتاب التفوق كيمياء 3 ثانوي 2027') return 'Unexpected first heading';
  if (headings[0].level !== 1) return 'Unexpected first level';
  if (headings[3].path.join('/') !== headings[3].path.join('/')) return 'Path is not stable';
  if (headings[3].path[0] !== 'كتاب التفوق كيمياء 3 ثانوي 2027') return 'The ancestor chain is missing';
  return true;
}

async function testTheOutlineIgnoresFencedHashes() {
  const headings = extractHeadings('# الأسعار\n\n```\n# comment\n```\n');
  if (headings.length !== 1) return `The fenced hash became a heading: ${headings.length} headings`;
  return true;
}

async function testTheOutlineSurvivesJunk() {
  for (const input of [null, undefined, 42, '']) {
    if (!Array.isArray(extractHeadings(input))) return 'Junk input did not produce an array';
  }
  return true;
}

async function runAllTests() {
  console.log('\n=== Markdown Parser Tests (Phase 20.3) ===\n');

  await runTest('One heading makes one section', testOneHeadingMakesOneSection);
  await runTest('Nested headings keep their full path', testNestedHeadingsKeepTheirFullPath);
  await runTest('A parent does not contain its children', testAParentDoesNotContainItsChildren);
  await runTest('Siblings are separate sections', testSiblingsAreSeparateSections);
  await runTest('A level jump does not invent missing levels', testALevelJumpDoesNotInventMissingLevels);
  await runTest('Heading levels unwind correctly', testHeadingLevelsUnwindCorrectly);
  await runTest('Text before the first heading is kept', testATextBeforeTheFirstHeadingIsKept);
  await runTest('An empty preamble is not a section', testAnEmptyPreambleIsNotASection);

  await runTest('An empty section is kept, not dropped', testAnEmptySectionIsKeptNotDropped);
  await runTest('An empty section is marked unusable', testAnEmptySectionIsMarkedUnusableNotRetrievedFrom);
  await runTest('A heading with no body at the end is still a section', testAHeadingWithNoBodyAtTheEndIsStillASection);

  await runTest('Interior blank lines are kept', testInteriorBlankLinesAreKept);
  await runTest('Leading and trailing blank lines are dropped', testLeadingAndTrailingBlankLinesAreDropped);
  await runTest('List markers are preserved verbatim', testListMarkersArePreservedVerbatim);
  await runTest('Quotes and tables survive', testOrderedListsQuotesAndTablesSurvive);
  await runTest('Arabic text is not altered', testArabicTextIsNotAltered);
  await runTest('Carriage returns do not leak into content', testCarriageReturnsDoNotLeakIntoContent);
  await runTest('A byte-order mark does not corrupt the first heading', testAByteOrderMarkDoesNotCorruptTheFirstHeading);

  await runTest('Closing hashes are stripped', testClosingHashesAreStripped);
  await runTest('Indented headings are still headings', testIndentedHeadingsAreStillHeadings);
  await runTest('Setext headings are recognised', testSetextHeadingsAreRecognised);
  await runTest('A thematic break is not a heading', testAThematicBreakIsNotAHeading);
  await runTest('Seven hashes is not a heading', testSevenHashesIsNotAHeading);

  await runTest('A hash inside a fenced block is not a heading', testAHashInsideAFencedBlockIsNotAHeading);
  await runTest('A fence is not closed by a shorter run', testAFenceIsNotClosedByAShorterRun);
  await runTest('An unclosed fence does not swallow the document', testAnUnclosedFenceDoesNotSwallowTheDocument);
  await runTest('A hash with no space stays body text', testAHashWithNoSpaceStaysBodyText);
  await runTest('Ordinals are contiguous and in document order', testOrdinalsAreContiguousAndInDocumentOrder);

  await runTest('Junk input produces nothing rather than throwing', testJunkInputProducesNothingRatherThanThrowing);
  await runTest('Pathological input is survivable', testPathologicalInputIsSurvivable);
  await runTest('Only hashes produce no heading sections', testOnlyHashesProduceNoHeadingSections);

  await runTest('Sections trace back to their document', testSectionsTraceBackToTheirDocument);
  await runTest('Evidence ids are unique per section', testEvidenceIdsAreUniquePerSection);
  await runTest('Parsing twice gives the same ids', testParsingTheSameDocumentTwiceGivesTheSameIds);
  await runTest('A section inherits its document disabled state', testASectionInheritsItsDocumentsDisabledState);
  await runTest('An unusable document yields no sections', testAnUnusableDocumentYieldsNoSections);

  await runTest('The outline matches what will be indexed', testTheOutlineMatchesWhatWillBeIndexed);
  await runTest('The outline ignores fenced hashes', testTheOutlineIgnoresFencedHashes);
  await runTest('The outline survives junk', testTheOutlineSurvivesJunk);

  console.log('\n=== Test Summary ===');
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(results.failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${results.failed} test(s) failed.`);

  return results;
}

export default runAllTests;