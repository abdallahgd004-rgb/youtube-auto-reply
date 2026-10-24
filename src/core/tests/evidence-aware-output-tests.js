/**
 * Evidence-Aware Output Tests — Phase 20.9
 *
 * The tests here concentrate on the one architectural decision this milestone makes, which is
 * easy to get backwards and expensive when you do:
 *
 *   **The model's citations must NOT decide what gets validated.** §16 asks whether the
 *   reply's claims are supported by the RETRIEVED KNOWLEDGE — the whole approved set. An
 *   implementation that validates only against cited sections loses a correct reply every
 *   time a model cites one of the two sections it actually used.
 *
 * So `evidence` is asserted to be the full approved set on every outcome, and the citations
 * are asserted to be recorded rather than used to narrow anything.
 *
 * Plus the mechanical hazards: a leaked evidence id in reply text, an id that was never
 * offered, and a model that returns prose instead of §15's shape.
 *
 * Runs in the browser from evidence-aware-output-tests.html. No chrome stub, no network:
 * `complete` is injected.
 */

import {
  generateGroundedReply,
  parseGroundedOutput,
  mapEvidenceIds,
  stripEvidenceIds,
  GENERATION_STATUS,
  MAX_REPLY_CHARS,
  MAX_CITED_IDS
} from '../evidence-aware-output.js';

import { buildGroundedMessages, OUTPUT_FORMAT, buildOutputInstruction } from '../grounded-prompt-builder.js';
import { KNOWLEDGE_ERROR, isExpectedKnowledgeSkip, categorizeKnowledgeError, ERROR_CATEGORY } from '../knowledge-schema.js';

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

const answering = (text) => async () => ({ text });

/** The gate's approved evidence, as 20.7 returns it. */
function approved() {
  return [
    { evidenceId: 'KNOWLEDGE-BOOKS-CHEMISTRY-PRICE', documentId: 'doc-a', filename: 'books/chemistry.md', headingPath: ['كيمياء', 'السعر'], content: 'السعر الحالي: 350 جنيه.' },
    { evidenceId: 'KNOWLEDGE-BOOKS-CHEMISTRY-COVERAGE', documentId: 'doc-a', filename: 'books/chemistry.md', headingPath: ['كيمياء', 'التغطية'], content: 'يغطي التفوق الدوال والتفاعلات.' }
  ];
}

const COMMENT = 'هو تمن كتاب الكيمياء إيه؟';
const GOOD_REPLY = 'كتاب الكيمياء سعره 350 جنيه.';

const structured = (reply, evidence) => JSON.stringify({ reply, evidence });

/** §15's documented shape, verbatim. */
async function testReadsTheDocumentedShape() {
  const parsed = parseGroundedOutput(structured(
    'كتاب التفوق كيمياء تالتة ثانوي سعره 350 جنيه.',
    ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']
  ));
  if (!parsed.ok) return `not ok: ${parsed.reason}`;
  if (parsed.reply !== 'كتاب التفوق كيمياء تالتة ثانوي سعره 350 جنيه.') return `reply was ${parsed.reply}`;
  if (parsed.citedIds.length !== 1) return `citedIds: ${parsed.citedIds}`;
  return true;
}

async function testGeneratesAndMapsCitations() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });

  if (outcome.status !== GENERATION_STATUS.GENERATED) return `status ${outcome.status}: ${outcome.reason}`;
  if (outcome.reply !== GOOD_REPLY) return `reply was ${outcome.reply}`;
  if (outcome.citedIds.length !== 1) return `citedIds: ${outcome.citedIds}`;
  if (outcome.citedIds[0] !== 'KNOWLEDGE-BOOKS-CHEMISTRY-PRICE') return `id was ${outcome.citedIds[0]}`;
  if (outcome.unmappedIds.length !== 0) return `unmapped: ${outcome.unmappedIds}`;
  if (outcome.offeredIds.length !== 2) return `offeredIds: ${outcome.offeredIds}`;
  return true;
}

// ─── The decision this milestone makes ────────────────────────────────────────

async function testValidationIsNotNarrowedByCitations() {
  // §16 validates the reply TEXT against the retrieved knowledge. If this returned only the
  // cited sections, a model citing one of the two sections it used would produce a reply
  // that fails validation for a claim that was perfectly grounded — losing a correct reply
  // and spending a regeneration on it.
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });

  if (outcome.evidence.length !== 2) return `evidence was narrowed to ${outcome.evidence.length}`;
  for (const item of approved()) {
    if (!outcome.evidence.some((e) => e.evidenceId === item.evidenceId)) {
      return `${item.evidenceId} is missing from the validation set`;
    }
  }
  return true;
}

async function testTheFullSetSurvivesEveryFailure() {
  // The approved set is a property of the gate, not of generation, so it must not vary with
  // how generation went. A caller that reached 20.10 after a partial failure would otherwise
  // validate against a different set than the one the gate approved.
  const outcomes = await Promise.all([
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: answering('garbage') }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: async () => { throw new Error('offline'); } }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved() }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: answering(structured('x'.repeat(MAX_REPLY_CHARS + 1), [])) })
  ]);

  for (const outcome of outcomes) {
    if (outcome.status !== GENERATION_STATUS.FAILED) continue;
    if (outcome.evidence.length !== 2) return `a failure narrowed the set to ${outcome.evidence.length}`;
    if (outcome.offeredIds.length !== 2) return `a failure changed offeredIds to ${outcome.offeredIds.length}`;
  }
  return true;
}

async function testAnInventedCitationIsRecordedNotTrusted() {
  // A citation the gate never approved means the model referenced knowledge it was not shown.
  // It cannot create a grounding hole — 20.10 checks the text against the approved set either
  // way — so it is surfaced for diagnostics instead of rejected. §15 lists explainability and
  // troubleshooting as the point of these ids.
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE', 'KNOWLEDGE-ALSO-INVENTED']))
  });

  if (outcome.status !== GENERATION_STATUS.GENERATED) return `status ${outcome.status}`;
  if (outcome.citedIds.length !== 1) return `mapped ${outcome.citedIds}`;
  if (outcome.unmappedIds.length !== 1 || outcome.unmappedIds[0] !== 'KNOWLEDGE-ALSO-INVENTED') {
    return `unmapped was ${outcome.unmappedIds}`;
  }
  // And critically, the invented id did not widen what will be validated.
  if (outcome.evidence.length !== 2) return `the set was widened to ${outcome.evidence.length}`;
  if (outcome.evidence.some((e) => e.evidenceId === 'KNOWLEDGE-ALSO-INVENTED')) {
    return 'an invented id entered the validation set';
  }
  return true;
}

async function testNoCitationsIsStillUsable() {
  // A model that returned a well-formed reply without citing anything has produced something
  // 20.10 can still validate. Rejecting it would enforce a convention that carries no safety
  // weight, at the cost of discarding a usable answer.
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, []))
  });

  if (outcome.status !== GENERATION_STATUS.GENERATED) return `status ${outcome.status}`;
  if (outcome.citedIds.length !== 0) return `citedIds: ${outcome.citedIds}`;
  if (outcome.reply !== GOOD_REPLY) return `reply was ${outcome.reply}`;
  if (outcome.evidence.length !== 2) return `evidence was narrowed to ${outcome.evidence.length}`;
  return true;
}

// ─── Leaked ids ───────────────────────────────────────────────────────────────

async function testALeakedIdIsStrippedNotRejected() {
  // §15: the ids do not need to be shown to commenters. A leak is a cosmetic defect, and
  // discarding a correct answer over it would be the wrong trade.
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured('كتاب الكيمياء سعره 350 جنيه [KNOWLEDGE-BOOKS-CHEMISTRY-PRICE]', ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });

  if (outcome.status !== GENERATION_STATUS.GENERATED) return `status ${outcome.status}: ${outcome.reason}`;
  if (outcome.reply.includes('KNOWLEDGE')) return `the id survived: ${outcome.reply}`;
  if (!outcome.reply.includes('350')) return 'the reply lost its content';
  if (outcome.strippedIds.length !== 1) return `strippedIds: ${outcome.strippedIds}`;
  if (/  /.test(outcome.reply)) return `the strip left a double space: "${outcome.reply}"`;
  return true;
}

async function testShortIdsAreNotStripped() {
  // Every id 20.1 builds is long and KNOWLEDGE-prefixed, but this module must not assume
  // well-formed input: replacing a two-character "id" out of an Arabic sentence would damage
  // real text.
  const { reply, stripped } = stripEvidenceIds('السعر 350 جنيه A B', ['A', 'B']);
  if (stripped.length !== 0) return `stripped ${stripped}`;
  if (reply !== 'السعر 350 جنيه A B') return `reply became "${reply}"`;

  const long = stripEvidenceIds('قبل KNOWLEDGE-BOOKS-CHEMISTRY-PRICE بعد', ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']);
  if (long.stripped.length !== 1) return 'a long id was not stripped';
  if (long.reply.includes('KNOWLEDGE')) return `survived: "${long.reply}"`;
  return true;
}

async function testStrippingDoesNotFoldArabicDigits() {
  // Folding the id before matching would let an id containing a price-shaped number be
  // matched by digits that legitimately belong to the price — a worse outcome than a leak.
  // A real id has no digits, but a hash-suffixed one can, and an id built from a heading
  // could too; the rule is that matching happens on the RAW string only.
  const id = 'KNOWLEDGE-BOOKS-CHEMISTRY-350';
  const arabicId = id.replace('350', '٣٥٠');

  const { reply, stripped } = stripEvidenceIds('السعر 350 جنيه ' + arabicId, [id]);
  if (stripped.length !== 0) return `a folded id matched: ${stripped}`;
  if (!reply.includes('350')) return `a real price was removed: "${reply}"`;

  // The raw form still is stripped, so the protection is not "strip nothing".
  const raw = stripEvidenceIds('قبل ' + id + ' بعد', [id]);
  if (raw.stripped.length !== 1) return 'the raw id was not stripped';
  return true;
}

async function testAStrippedIdThatEmptiesTheReplyFails() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured('KNOWLEDGE-BOOKS-CHEMISTRY-PRICE', ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });
  if (outcome.status !== GENERATION_STATUS.FAILED) return 'a reply that was only an id was accepted';
  if (!outcome.reason) return 'no reason given';
  return true;
}

// ─── Malformed output ─────────────────────────────────────────────────────────

async function testProseInsteadOfJsonFails() {
  // A model that ignores §15's shape entirely. 20.11 regenerates; 20.9 reports.
  const bad = ['كتاب الكيمياء سعره 350 جنيه.', '```json\n{}\n```', '', '   ', '{', 'null', '[{"reply":"x"}]'];

  for (const text of bad) {
    const outcome = await generateGroundedReply({
      commentText: COMMENT,
      evidence: approved(),
      complete: answering(text)
    });
    if (outcome.status === GENERATION_STATUS.GENERATED) return `${JSON.stringify(text.slice(0, 30))} was accepted`;
    if (outcome.reply !== '') return `${JSON.stringify(text.slice(0, 30))} produced a reply`;
    if (outcome.code !== KNOWLEDGE_ERROR.GENERATION_FAILED) return `code was ${outcome.code}`;
  }
  return true;
}

async function testAnEmptyReplyFails() {
  for (const reply of ['', '   ', '\n\n']) {
    const outcome = await generateGroundedReply({
      commentText: COMMENT,
      evidence: approved(),
      complete: answering(structured(reply, []))
    });
    if (outcome.status === GENERATION_STATUS.GENERATED) return `${JSON.stringify(reply)} was accepted`;
  }
  return true;
}

async function testAWronglyTypedEvidenceListFails() {
  // Silently treating {"evidence":"KNOWLEDGE-A"} as no citations would hide real
  // non-compliance behind a plausible-looking result.
  for (const evidence of ['KNOWLEDGE-A', { id: 'A' }, [1, 2], [null], [['A']]]) {
    const parsed = parseGroundedOutput(JSON.stringify({ reply: 'x', evidence }));
    if (parsed.ok) return `${JSON.stringify(evidence)} was accepted`;
  }
  // An ABSENT list is valid, though: same "absent is not invalid" rule 20.6 uses.
  const absent = parseGroundedOutput('{"reply":"x"}');
  if (!absent.ok || absent.citedIds.length !== 0) return 'an absent list was rejected';
  return true;
}

async function testAnOversizedReplyFails() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured('x'.repeat(MAX_REPLY_CHARS + 1), []))
  });
  if (outcome.status !== GENERATION_STATUS.FAILED) return 'an oversized reply was accepted';
  if (!/character/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  return true;
}

async function testTooManyCitationsAreBounded() {
  const many = [];
  for (let i = 0; i < MAX_CITED_IDS + 20; i++) many.push(`KNOWLEDGE-INVENTED-${i}`);

  const parsed = parseGroundedOutput(JSON.stringify({ reply: 'x', evidence: many }));
  if (parsed.citedIds.length > MAX_CITED_IDS) return `${parsed.citedIds.length} citations kept`;

  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, many))
  });
  if (outcome.status !== GENERATION_STATUS.GENERATED) return `status ${outcome.status}`;
  if (outcome.citedIds.length !== 0) return `mapped ${outcome.citedIds}`;
  return true;
}

async function testDuplicateCitationsCollapse() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE', 'KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });
  if (outcome.citedIds.length !== 1) return `citedIds: ${outcome.citedIds}`;
  return true;
}

async function testAModelFailureFailsCleanly() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: async () => { throw new Error('LM Studio unreachable'); }
  });

  if (outcome.status === GENERATION_STATUS.GENERATED) return 'a thrown error produced a reply';
  if (outcome.code !== KNOWLEDGE_ERROR.GENERATION_FAILED) return `code was ${outcome.code}`;
  if (!/LM Studio call failed/.test(outcome.reason)) return `reason was ${outcome.reason}`;
  // A generation failure is an AI issue, never a healthy skip — §32.
  if (isExpectedKnowledgeSkip(outcome.code)) return 'a model failure counts as a healthy skip';
  if (categorizeKnowledgeError(outcome.code) !== ERROR_CATEGORY.AI) return `bucket ${categorizeKnowledgeError(outcome.code)}`;
  return true;
}

async function testFencedAndPrefixedJsonIsAccepted() {
  for (const text of [
    '```json\n{"reply":"' + GOOD_REPLY + '","evidence":["KNOWLEDGE-BOOKS-CHEMISTRY-PRICE"]}\n```',
    'Here is the reply:\n' + structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']),
    structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']) + '\nHope that helps.'
  ]) {
    const outcome = await generateGroundedReply({
      commentText: COMMENT,
      evidence: approved(),
      complete: answering(text)
    });
    if (outcome.status !== GENERATION_STATUS.GENERATED) return `${JSON.stringify(text.slice(0, 26))} → ${outcome.reason}`;
    if (outcome.reply !== GOOD_REPLY) return `reply was ${outcome.reply}`;
  }
  return true;
}

// ─── The request ───────────────────────────────────────────────────────────────

async function testTheRequestAsksForTheStructuredShape() {
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: answering(structured(GOOD_REPLY, []))
  });

  const user = outcome.evidence && outcome.reply ? null : null;
  if (user !== null) return 'unexpected';

  // Inspect the prompt the model was actually given.
  let seen = null;
  await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: async (messages) => { seen = messages; return { text: structured(GOOD_REPLY, []) }; }
  });

  if (!seen) return 'no messages were sent';
  const all = seen.map((m) => m.content).join('\n');
  if (!/"reply"/.test(all)) return 'the prompt does not ask for a reply field';
  if (!/"evidence"/.test(all)) return 'the prompt does not ask for an evidence field';
  if (!/do not invent an id/i.test(all)) return 'the prompt does not forbid inventing an id';
  if (!/plain/i.test(all)) return 'the prompt does not require plain reply text';
  // Grounding must still be first — the structured contract does not replace the rules.
  if (seen[0].role !== 'system' || !/only information contained in the provided knowledge/i.test(seen[0].content)) {
    return 'the grounding rules are no longer first';
  }
  return true;
}

async function testTheTextFormatIsUnchanged() {
  // 20.8's default must still be plain text, or the two contracts are not really optional.
  const instruction = buildOutputInstruction(OUTPUT_FORMAT.TEXT);
  if (/JSON/.test(instruction)) return 'the text format mentions JSON';
  if (!/Plain text only/i.test(instruction)) return 'the text format lost its plain-text rule';

  const structuredText = buildOutputInstruction(OUTPUT_FORMAT.STRUCTURED);
  if (!/JSON only/i.test(structuredText)) return 'the structured format does not require JSON';
  if (!/evidence id in the reply text/i.test(structuredText)) return 'the structured format does not forbid leaking ids';

  // An unknown format falls back to plain text rather than producing a broken instruction.
  const unknown = buildOutputInstruction('nonsense');
  if (unknown !== instruction) return 'an unknown format did not fall back to plain text';
  return true;
}

async function testTheDefaultFormatIsText() {
  const asText = buildGroundedMessages({ commentText: COMMENT, evidence: approved() });
  const explicit = buildGroundedMessages({ commentText: COMMENT, evidence: approved(), outputFormat: OUTPUT_FORMAT.TEXT });
  if (JSON.stringify(asText.messages) !== JSON.stringify(explicit.messages)) {
    return 'the default output format is not plain text';
  }
  return true;
}

async function testTheOperationIsNamed() {
  let operation = '';
  await generateGroundedReply({
    commentText: COMMENT,
    evidence: approved(),
    complete: async (m, o) => { operation = o.operation; return { text: structured(GOOD_REPLY, []) }; }
  });
  if (operation !== 'GROUNDED_GENERATION') return `operation was ${operation}`;
  return true;
}

async function testThePromptStillRefusesWithoutEvidence() {
  // 20.8's guarantee has to survive the structured format, or switching formats would open
  // the exact hole that was just closed.
  const outcome = await generateGroundedReply({
    commentText: COMMENT,
    evidence: [],
    complete: answering(structured(GOOD_REPLY, []))
  });
  if (outcome.status === GENERATION_STATUS.GENERATED) return 'a prompt was generated with no knowledge';
  return true;
}

// ─── Robustness ───────────────────────────────────────────────────────────────

async function testMappingAndStrippingAreTotal() {
  for (const input of [null, undefined, 'x', 42, {}, [null], ['']]) {
    const mapped = mapEvidenceIds(input, approved());
    if (!Array.isArray(mapped.mapped) || !Array.isArray(mapped.unmapped)) return `mapEvidenceIds(${JSON.stringify(input)}) threw`;
    const stripped = stripEvidenceIds('text', input);
    if (typeof stripped.reply !== 'string' || !Array.isArray(stripped.stripped)) return `stripEvidenceIds(${JSON.stringify(input)}) threw`;
  }
  return true;
}

async function testParsingIsTotal() {
  const hostile = [null, undefined, 42, true, [], '{}', '{"reply":null}', '{"reply":42}', '{"reply":[]}', '{"reply":{}}', '{"reply":"x","evidence":[1]}', '}{'];
  for (const value of hostile) {
    const parsed = parseGroundedOutput(value);
    if (parsed.ok) return `${JSON.stringify(value)} parsed`;
    if (parsed.reply !== '') return `${JSON.stringify(value)} → ${parsed.reply}`;
  }
  return true;
}

async function testGeneratingNeverThrows() {
  for (const args of [
    {},
    { commentText: null, evidence: null },
    { commentText: COMMENT },
    { commentText: COMMENT, evidence: 'not an array' },
    { commentText: COMMENT, evidence: approved(), complete: 42 },
    { commentText: COMMENT, evidence: approved(), complete: async () => null },
    { commentText: COMMENT, evidence: approved(), complete: async () => ({ text: 42 }), settings: { lmStudio: { temperature: 0.5, maxTokens: 100 } } }
  ]) {
    const outcome = await generateGroundedReply(args);
    if (!outcome || !outcome.status) throw new Error(`${JSON.stringify(args)} → ${JSON.stringify(outcome)}`);
    if (!Array.isArray(outcome.evidence) || !Array.isArray(outcome.unmappedIds)) {
      throw new Error(`${JSON.stringify(args)} → shape is wrong`);
    }
  }
  return true;
}

async function testEveryOutcomeHasOneShape() {
  const outcomes = await Promise.all([
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE'])) }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: answering(structured(GOOD_REPLY, ['NOPE'])) }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: answering('garbage') }),
    generateGroundedReply({ commentText: COMMENT, evidence: approved(), complete: async () => { throw new Error('x'); } }),
    generateGroundedReply({ commentText: COMMENT, evidence: [], complete: answering(structured(GOOD_REPLY, [])) })
  ]);

  const shapes = new Set(outcomes.map((o) => Object.keys(o).sort().join(',')));
  if (shapes.size !== 1) throw new Error(`shapes differ: ${[...shapes].join(' | ')}`);
  return true;
}

async function testItIsDeterministic() {
  const a = await generateGroundedReply({
    commentText: COMMENT, evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });
  const b = await generateGroundedReply({
    commentText: COMMENT, evidence: approved(),
    complete: answering(structured(GOOD_REPLY, ['KNOWLEDGE-BOOKS-CHEMISTRY-PRICE']))
  });
  if (a.reply !== b.reply) return 'the same inputs produced different replies';
  if (a.citedIds.join() !== b.citedIds.join()) return 'the same inputs produced different citations';
  return true;
}

export default async function runAllTests() {
  await runTest("§15's documented shape is the shape the code produces", testReadsTheDocumentedShape);
  await runTest('generation maps the citations it was given', testGeneratesAndMapsCitations);

  await runTest('validation is NOT narrowed by the citations (§16)', testValidationIsNotNarrowedByCitations);
  await runTest('the full approved set survives every failure', testTheFullSetSurvivesEveryFailure);
  await runTest('an invented citation is recorded, not trusted', testAnInventedCitationIsRecordedNotTrusted);
  await runTest('a reply with no citations is still usable', testNoCitationsIsStillUsable);

  await runTest('a leaked evidence id is stripped, not rejected', testALeakedIdIsStrippedNotRejected);
  await runTest('short ids are not stripped', testShortIdsAreNotStripped);
  await runTest('stripping does not fold Arabic-Indic digits', testStrippingDoesNotFoldArabicDigits);
  await runTest('a stripped reply that is left empty fails', testAStrippedIdThatEmptiesTheReplyFails);

  await runTest('prose instead of JSON fails', testProseInsteadOfJsonFails);
  await runTest('an empty reply fails', testAnEmptyReplyFails);
  await runTest('a wrongly-typed evidence list fails', testAWronglyTypedEvidenceListFails);
  await runTest('an oversized reply fails', testAnOversizedReplyFails);
  await runTest('too many citations are bounded', testTooManyCitationsAreBounded);
  await runTest('duplicate citations collapse', testDuplicateCitationsCollapse);
  await runTest('a model failure fails cleanly (§32)', testAModelFailureFailsCleanly);
  await runTest('fenced and prefixed JSON is accepted', testFencedAndPrefixedJsonIsAccepted);

  await runTest('the request asks for the structured shape', testTheRequestAsksForTheStructuredShape);
  await runTest('the text format is unchanged (§20.8)', testTheTextFormatIsUnchanged);
  await runTest('the default output format is plain text', testTheDefaultFormatIsText);
  await runTest('the operation is named in diagnostics', testTheOperationIsNamed);
  await runTest('the prompt still refuses without evidence', testThePromptStillRefusesWithoutEvidence);

  await runTest('mapping and stripping are total', testMappingAndStrippingAreTotal);
  await runTest('parsing is total', testParsingIsTotal);
  await runTest('generating never throws', testGeneratingNeverThrows);
  await runTest('every outcome has one shape', testEveryOutcomeHasOneShape);
  await runTest('generation is deterministic', testItIsDeterministic);

  return results;
}
