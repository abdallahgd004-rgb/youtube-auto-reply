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
  
  // DISABLED-RULE HANDLING NOTE:
  // Disabled-rule filtering is not yet implemented in production.
  // See documentation comment above for details.
  // This is NOT counted as a passing behavioral test.
  
  // Additional edge case tests
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