/**
 * Arabic Normalizer - Phase 4.4
 * 
 * Applies basic text normalization to Arabic comments for better matching.
 * This is a separate reusable function, not integrated into matchers yet.
 */

/**
 * Normalize Arabic text according to the following rules:
 * 1. Remove diacritics/tashkeel (fatḥa, ḍamma, kasra, shadda, sukun)
 * 2. Normalize Alef variants: أ → ا, إ → ا, آ → ا
 * 3. Collapse repeated whitespace into single space and trim
 * 4. Remove simple punctuation characters (.,!?;:'"<>())[]{}@#&$%)
 * 
 * @param {string} text - The Arabic text to normalize
 * @returns {string} Normalized text
 */
export function normalizeArabic(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let normalized = text;

  // Step 1: Remove diacritics/tashkeel (fatḥa, ḍamma, kasra, shadda, sukun)
  const diacriticsRegex = /[\u064B-\u065F\u0670]/g;
  normalized = normalized.replace(diacriticsRegex, '');

  // Step 2: Normalize Alef variants to standard Alef (ا)
  // أ → ا, إ → ا, آ → ا
  normalized = normalized
    .replace(/أ/g, 'ا')   // Alef with fatḥa
    .replace(/إ/g, 'ا')   // Alef with ḍamma  
    .replace(/آ/g, 'ا');  // Alef with hamza

  // Step 3: Collapse repeated whitespace and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Step 4: Remove simple punctuation characters (including Arabic punctuation)
  const punctuationRegex = /[.,!?;:'"<>())\[\]{}@#$%؟،؛]/g;
  normalized = normalized.replace(punctuationRegex, '');

  return normalized;
}

export default { normalizeArabic };