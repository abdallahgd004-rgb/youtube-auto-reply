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
export function match(text, phrases, caseSensitive = false) {
  // Normalize text for comparison
  const searchText = caseSensitive ? text : text.toLowerCase();
  
  // Keep track of the original phrase from input (for non-case-sensitive mode)
  let matchedOriginalPhrase = null;
  
  for (const phrase of phrases) {
    const searchPhrase = caseSensitive ? phrase : phrase.toLowerCase();
    
    if (searchText.includes(searchPhrase)) {
      // Return the ORIGINAL phrase from the input array, not the lowercased version
      matchedOriginalPhrase = phrase;
      return { matched: true, matchedPhrase: phrase };
    }
  }
  
  return { matched: false };
}

export default { match };