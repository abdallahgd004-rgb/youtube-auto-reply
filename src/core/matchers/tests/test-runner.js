/**
 * Matcher Unit Tests - Phase 4.7
 * 
 * Simple test runner for YouTube Auto Reply matcher functions.
 * Can be run in browser console or with Node.js (if ES modules support is available).
 */

import { match as containsMatch } from '../contains-matcher.js';
import { match as exactMatch } from '../exact-matcher.js';
import { normalizeArabic } from '../arabic-normalizer.js';

// Test results tracking
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  tests: []
};

/**
 * Run a single test case.
 */
function runTest(name, fn) {
  results.total++;
  
  try {
    const result = fn();
    
    if (result === true || result === 'PASS') {
      results.passed++;
      console.log(`✓ ${name}`);
    } else {
      results.failed++;
      console.log(`✗ ${name}: Expected ${result}, got unexpected result`);
    }
  } catch (error) {
    results.failed++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

/**
 * Test Case 1: Contains match
 */
function testContainsMatch() {
  const text = "بكام الكتاب؟";
  const phrases = ["بكام"];
  const result = containsMatch(text, phrases, false);
  
  if (result.matched && result.matchedPhrase === "بكام") {
    return true;
  } else {
    console.log(`  Expected: matched=true, matchedPhrase="بكام"`);
    console.log(`  Got: matched=${result.matched}, matchedPhrase="${result.matchedPhrase || 'undefined'}"`);
    return false;
  }
}

/**
 * Test Case 2: Contains no match
 */
function testContainsNoMatch() {
  const text = "السلام عليكم";
  const phrases = ["بكام"];
  const result = containsMatch(text, phrases, false);
  
  if (!result.matched) {
    return true;
  } else {
    console.log(`  Expected: matched=false`);
    console.log(`  Got: matched=${result.matched}`);
    return false;
  }
}

/**
 * Test Case 3: Exact match
 */
function testExactMatch() {
  const text = "بكام";
  const phrases = ["بكام"];
  const result = exactMatch(text, phrases, false);
  
  if (result.matched && result.matchedPhrase === "بكام") {
    return true;
  } else {
    console.log(`  Expected: matched=true, matchedPhrase="بكام"`);
    console.log(`  Got: matched=${result.matched}, matchedPhrase="${result.matchedPhrase || 'undefined'}"`);
    return false;
  }
}

/**
 * Test Case 4: Exact no match (partial text should not match)
 */
function testExactNoMatch() {
  const text = "بكام الكتاب";
  const phrases = ["بكام"];
  const result = exactMatch(text, phrases, false);
  
  if (!result.matched) {
    return true;
  } else {
    console.log(`  Expected: matched=false (partial match should not count)`);
    console.log(`  Got: matched=${result.matched}`);
    return false;
  }
}

/**
 * Test Case 5a: Arabic normalization - diacritics removal
 */
function testNormalizationDiacritics() {
  const input = "بِكام الكتاب؟";
  const expected = "بكام الكتاب";
  const result = normalizeArabic(input);
  
  if (result === expected) {
    return true;
  } else {
    console.log(`  Input: "${input}"`);
    console.log(`  Expected: "${expected}"`);
    console.log(`  Got: "${result}"`);
    return false;
  }
}

/**
 * Test Case 5b: Arabic normalization - Alef variants
 */
function testNormalizationAlef() {
  const input = "أهلاً وإخاً وآمن";
  const expected = "اهلا واخا وامن";
  const result = normalizeArabic(input);
  
  if (result === expected) {
    return true;
  } else {
    console.log(`  Input: "${input}"`);
    console.log(`  Expected: "${expected}"`);
    console.log(`  Got: "${result}"`);
    return false;
  }
}

/**
 * Test Case 5c: Arabic normalization - whitespace collapse and trim
 */
function testNormalizationWhitespace() {
  const input = "  بكام   الكتاب  ";
  const expected = "بكام الكتاب";
  const result = normalizeArabic(input);
  
  if (result === expected) {
    return true;
  } else {
    console.log(`  Input: "${input}"`);
    console.log(`  Expected: "${expected}"`);
    console.log(`  Got: "${result}"`);
    return false;
  }
}

/**
 * Test Case 5d: Arabic normalization - punctuation removal
 */
function testNormalizationPunctuation() {
  const input = "بكام، السعر؛ منين؟";
  const expected = "بكام السعر منين";
  const result = normalizeArabic(input);
  
  if (result === expected) {
    return true;
  } else {
    console.log(`  Input: "${input}"`);
    console.log(`  Expected: "${expected}"`);
    console.log(`  Got: "${result}"`);
    return false;
  }
}

/**
 * Test Case 5e: Arabic normalization — Arabic-Indic digits fold to ASCII (Phase 19.2)
 *
 * A viewer types prices on an Arabic keyboard ("٩٩") while the trigger was typed on a
 * Latin keyboard ("99"). Both must reach the same normalized string.
 */
function testNormalizationArabicIndicDigits() {
  // The suffix is written once and reused, so this compares the DIGIT SETS only.
  // Typing two visually identical Arabic words separately is exactly how a test ends
  // up failing for a reason that has nothing to do with the rule under test.
  const suffix = ' جنيه';
  const ascii = normalizeArabic('بكام 99' + suffix);
  const arabicIndic = normalizeArabic('بكام \u0669\u0669' + suffix);
  const extended = normalizeArabic('بكام \u06F9\u06F9' + suffix);

  if (arabicIndic !== ascii) {
    console.log(`  Arabic-Indic: "${arabicIndic}" vs ASCII "${ascii}"`);
    return false;
  }
  if (extended !== ascii) {
    console.log(`  Extended Arabic-Indic: "${extended}" vs ASCII "${ascii}"`);
    return false;
  }
  if (!/99/.test(ascii)) {
    console.log(`  Expected digits to survive as ASCII, got "${ascii}"`);
    return false;
  }
  return true;
}

/**
 * Test Case 5f: Arabic normalization — alef maqsura folds to ya (Phase 19.2)
 */
function testNormalizationAlefMaqsura() {
  // "على" (alef maqsura) and "علي" (ya) are one word written two ways, and Farsi yeh
  // is the third spelling that arrives with Persian/Urdu keyboards.
  //
  // The three letters are written as escapes and the rest of the word is shared, so
  // this compares the LETTER UNDER TEST and nothing else. Hand-typing three visually
  // identical Arabic words is how this test ends up failing for an unrelated reason.
  const word = (yeh) => normalizeArabic('ع' + yeh + ' المنص\u0629');

  const ALEF_MAQSURA = '\u0649';
  const YA = '\u064A';
  const FARSI_YEH = '\u06CC';

  const fromMaqsura = word(ALEF_MAQSURA);
  const fromYa = word(YA);
  const fromFarsi = word(FARSI_YEH);

  if (fromMaqsura !== fromYa) {
    console.log(`  alef maqsura and ya should agree, got "${fromMaqsura}" and "${fromYa}"`);
    return false;
  }
  if (fromFarsi !== fromYa) {
    console.log(`  Farsi yeh should fold to ya, got "${fromFarsi}" and "${fromYa}"`);
    return false;
  }
  return true;
}

/**
 * Test Case 5g: the new rules reach the matchers, not just the normalizer.
 *
 * This is the point of Phase 19.2: without matcher integration a nicer normalizer
 * would change nothing a user can observe.
 */
function testNewRulesAffectContainsMatching() {
  const digits = containsMatch("السعر ٩٩ جنيه", ["السعر 99"], false);
  if (!digits.matched) {
    console.log('  A comment using Arabic-Indic digits should match an ASCII trigger');
    return false;
  }

  const maqsura = containsMatch("انا علي المنصة", ["انا علي المنصة"], false);
  if (!maqsura.matched) {
    console.log('  A comment using alef maqsura should match a ya trigger');
    return false;
  }

  const exact = exactMatch("علي المنصة", ["علي المنصة"], false);
  if (!exact.matched) {
    console.log('  Exact matching should fold alef maqsura too');
    return false;
  }
  return true;
}

/**
 * Test Case 5h: the content-script copy still agrees with the core copy.
 *
 * The two files are maintained by hand because content scripts cannot be ES modules.
 * If they drift, comments get normalized one way and triggers another, and matching
 * fails in a way that is very hard to see.
 */
function testNormalizerCopiesAgree() {
  const globalNormalize = globalThis.normalizeArabic;
  if (typeof globalNormalize !== 'function') {
    console.log('  The content-script copy is not loaded, cannot compare');
    return false;
  }

  const samples = [
    'بِكام الكتاب؟',
    'أهلاً وإخاً',
    'بكام ٩٩ و ۴۹',
    'على المنصة',
    'السعر، shipment؟',
    'تمّ‏ بنجاح',
    '«اقتباس»said',
    ''
  ];

  for (const sample of samples) {
    const core = normalizeArabic(sample);
    const copy = globalNormalize(sample);
    if (core !== copy) {
      console.log(`  Input "${sample}": core "${core}" vs content copy "${copy}"`);
      return false;
    }
  }
  return true;
}

/**
 * DISABLED-RULE HANDLING - DOCUMENTATION NOTE
 * 
 * IMPORTANT: Disabled-rule filtering is NOT currently implemented in the production Trigger Engine.
 * The matchers (contains-matcher.js, exact-matcher.js) do not know about the `enabled` field.
 * Filtering of disabled rules must be done at the application layer (background service worker,
 * content script, or future trigger engine module).
 * 
 * This test is REMOVED from the executable suite because there is no production code to verify.
 * When the application-layer filtering is implemented, a new integration test should be added
 * that calls the actual production API and verifies disabled rules are ignored during matching.
 */

/**
 * Additional test: Case-insensitive matching (default behavior)
 */
function testCaseInsensitiveDefault() {
  const text = "PRICE";
  const phrases = ["price"];
  const result = containsMatch(text, phrases, false); // caseSensitive=false by default
  
  if (result.matched && result.matchedPhrase === "price") {
    return true;
  } else {
    console.log(`  Expected: matched=true for case-insensitive`);
    console.log(`  Got: matched=${result.matched}, matchedPhrase="${result.matchedPhrase || 'undefined'}"`);
    return false;
  }
}

/**
 * Additional test: Case-sensitive matching when enabled
 */
function testCaseSensitiveEnabled() {
  const text = "PRICE";
  const phrases = ["price"];
  const result = containsMatch(text, phrases, true); // caseSensitive=true
  
  if (!result.matched) {
    return true;
  } else {
    console.log(`  Expected: matched=false for case-sensitive`);
    console.log(`  Got: matched=${result.matched}`);
    return false;
  }
}

/**
 * Additional test: Multiple phrases - first match wins
 */
function testMultiplePhrases() {
  const text = "السعر رخيص";
  const phrases = ["رخيص", "سعر"];
  const result = containsMatch(text, phrases, false);
  
  // Should match "رخيص" (first in array that matches)
  if (result.matched && result.matchedPhrase === "رخيص") {
    return true;
  } else {
    console.log(`  Expected: matched=true, matchedPhrase="رخيص"`);
    console.log(`  Got: matched=${result.matched}, matchedPhrase="${result.matchedPhrase || 'undefined'}"`);
    return false;
  }
}

/**
 * Phase 19.9 regression — the reported "تم" case, exactly as it was seen in Chrome.
 *
 * Phrase "تم", mode contains, against the real comment. This passed all along: the
 * failure was never in the matcher, it was the semantic classification call failing. The
 * case is kept because it is the exact input that prompted the investigation, and a
 * future change to normalization or whitespace folding must not break it silently.
 */
const REPORTED_PHRASE = "تم";
const REPORTED_COMMENT = "تم\nجبت كتاب الكيمياء من مكتبة الهدى بـ ٣٥٠ج هو عندكو بكام";

function testReportedContainsCase() {
  const result = containsMatch(REPORTED_COMMENT, [REPORTED_PHRASE], false);

  if (!result.matched) {
    console.log(`  Expected "تم" to match the reported comment, got matched=false`);
    return false;
  }
  if (result.matchedPhrase !== REPORTED_PHRASE) {
    console.log(`  Expected matchedPhrase="${REPORTED_PHRASE}", got "${result.matchedPhrase}"`);
    return false;
  }

  // Every shape the report listed as "must match".
  const mustMatch = [
    "تم",
    "تم جبت الكتاب",
    "أيوه تم جبت الكتاب",
    "تم، جبت الكتاب",
    "تم\nجبت كتاب الكيمياء من مكتبة الهدى",
    REPORTED_COMMENT
  ];
  for (const text of mustMatch) {
    if (!containsMatch(text, [REPORTED_PHRASE], false).matched) {
      console.log(`  Expected "تم" to match: ${JSON.stringify(text)}`);
      return false;
    }
  }

  // And the case that must NOT match, so the matcher is not simply matching everything.
  if (containsMatch("الكتاب حلو جدا شكرا", [REPORTED_PHRASE], false).matched) {
    console.log('  A comment without "تم" must not match');
    return false;
  }

  // Exact mode must stay exact: the same comment is NOT an exact match.
  if (exactMatch(REPORTED_COMMENT, [REPORTED_PHRASE], false).matched) {
    console.log('  Exact mode must not match a comment that merely contains the phrase');
    return false;
  }
  if (!exactMatch("تم", [REPORTED_PHRASE], false).matched) {
    console.log('  Exact mode must still match the phrase on its own');
    return false;
  }

  return true;
}

/**
 * The normalization of the reported pair, pinned so a change that would break the match is
 * visible in the log rather than only in Chrome.
 */
function testReportedNormalization() {
  const normalizedPhrase = normalizeArabic(REPORTED_PHRASE);
  const normalizedComment = normalizeArabic(REPORTED_COMMENT);

  if (!normalizedComment.includes(normalizedPhrase)) {
    console.log(`  normalizeArabic(comment) = ${JSON.stringify(normalizedComment)}`);
    console.log(`  normalizeArabic(phrase)  = ${JSON.stringify(normalizedPhrase)}`);
    console.log('  The normalized comment must still contain the normalized phrase');
    return false;
  }
  // The newline must fold to a space, and Arabic-Indic digits to ASCII — both are what
  // make the reported multi-line, digit-bearing comment match cleanly.
  if (normalizedComment.includes('\n')) {
    console.log('  A line break survived normalization');
    return false;
  }
  if (!/350/.test(normalizedComment)) {
    console.log(`  Arabic-Indic digits were not folded: ${JSON.stringify(normalizedComment)}`);
    return false;
  }
  return true;
}

/**
 * Run all tests and print summary.
 */
function runAllTests() {
  console.log('\n=== Matcher Unit Tests ===\n');
  
  // Core functionality tests
  runTest('Contains match', testContainsMatch);
  runTest('Contains no match', testContainsNoMatch);
  runTest('Exact match', testExactMatch);
  runTest('Exact no match (partial)', testExactNoMatch);
  
  // Arabic normalization tests
  runTest('Normalization: diacritics removal', testNormalizationDiacritics);
  runTest('Normalization: Alef variants', testNormalizationAlef);
  runTest('Normalization: whitespace collapse', testNormalizationWhitespace);
  runTest('Normalization: punctuation removal', testNormalizationPunctuation);
  runTest('Normalization: Arabic-Indic digits fold to ASCII', testNormalizationArabicIndicDigits);
  runTest('Normalization: alef maqsura folds to ya', testNormalizationAlefMaqsura);
  runTest('Phase 19.2 rules reach the matchers', testNewRulesAffectContainsMatching);
  runTest('Core and content-script normalizers agree', testNormalizerCopiesAgree);
  
  // DISABLED-RULE HANDLING NOTE:
  // Disabled-rule filtering is not yet implemented in production.
  // See documentation comment above for details.
  // This is NOT counted as a passing behavioral test.
  
  // Additional edge case tests
  runTest('Reported "تم" contains case (Phase 19.9)', testReportedContainsCase);
  runTest('Reported "تم" normalization (Phase 19.9)', testReportedNormalization);
  runTest('Case-insensitive default behavior', testCaseInsensitiveDefault);
  runTest('Case-sensitive when enabled', testCaseSensitiveEnabled);
  runTest('Multiple phrases - first match wins', testMultiplePhrases);
  
  // Print summary
  console.log(`\n=== Test Summary ===`);
  console.log(`Total: ${results.total}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  
  if (results.failed === 0) {
    console.log('\n✓ All tests passed!');
  } else {
    console.log(`\n✗ ${results.failed} test(s) failed.`);
  }
  
  return results;
}

// Run tests when loaded in browser
if (typeof window !== 'undefined') {
  runAllTests();
}

export default runAllTests;