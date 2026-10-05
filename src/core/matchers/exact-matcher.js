/**
 * Exact Matcher - Phase 4.3
 * 
 * Determines whether a YouTube comment text exactly equals one of the trigger phrases.
 * No normalization beyond case handling is performed.
 * 
 * @param {string} text - The comment text to search
 * @param {string[]} phrases - Array of trigger phrases to match against
 * @param {boolean} caseSensitive - If true, matching is case-sensitive; otherwise case-insensitive (default)
 * @returns {{matched: boolean, matchedPhrase?: string}} - Result object with match status and original matched phrase
 */
export function match(text, phrases, caseSensitive = false) {
  // Normalize text for comparison only
  const searchText = caseSensitive ? text : text.toLowerCase();
  
  for (const phrase of phrases) {
    const searchPhrase = caseSensitive ? phrase : phrase.toLowerCase();
    
    if (searchText === searchPhrase) {
      return { matched: true, matchedPhrase: phrase };
    }
  }
  
  return { matched: false };
}

export default { match };