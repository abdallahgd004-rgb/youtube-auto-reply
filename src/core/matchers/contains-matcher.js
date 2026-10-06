/**
 * Contains Matcher - Phase 4.2
 * 
 * Determines whether a YouTube comment text contains at least one phrase
 * from an active trigger rule.
 * 
 * @param {string} text - The comment text to search
 * @param {string[]} phrases - Array of trigger phrases to match against
 * @param {boolean} caseSensitive - If true, matching is case-sensitive; otherwise case-insensitive (default)
 * @returns {{matched: boolean, matchedPhrase?: string}} - Result object with match status and original matched phrase
 */
import { normalizeArabic } from './arabic-normalizer.js';

export function match(text, phrases, caseSensitive = false) {
  // Case-fold first, then apply Arabic normalization (diacritics, Alef variants,
  // whitespace, punctuation) so "بِكام" matches a trigger stored as "بكام".
  const searchText = normalizeArabic(caseSensitive ? text : text.toLowerCase());
  
  // Keep track of the original phrase from input (for non-case-sensitive mode)
  let matchedOriginalPhrase = null;
  
  for (const phrase of phrases) {
    const searchPhrase = normalizeArabic(caseSensitive ? phrase : phrase.toLowerCase());
    
    if (searchText.includes(searchPhrase)) {
      // Return the ORIGINAL phrase from the input array, not the lowercased version
      matchedOriginalPhrase = phrase;
      return { matched: true, matchedPhrase: phrase };
    }
  }
  
  return { matched: false };
}

export default { match };