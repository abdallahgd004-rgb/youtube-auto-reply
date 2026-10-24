// Arabic Normalizer - content-script (classic script) build
//
// These rules are a VERBATIM copy of src/core/matchers/arabic-normalizer.js, exposed
// as a global instead of an ES module export.
//
// WHY A COPY EXISTS
// src/content/content.js is declared in the manifest WITHOUT "type": "module", so it
// is a classic script and cannot use `import`. Chrome does not support ES modules for
// content_scripts at all. The core file must stay an ES module, because
// contains-matcher.js, exact-matcher.js and comment-fingerprint.js import
// `normalizeArabic` from it, and the matcher implementation is not to be changed.
// So the shared rules are carried into the content-script world by this file, exactly
// the way content/youtube-adapter.js carries the site adapter across that boundary.
//
// No new rules are introduced here. This is the same normalizer, unchanged, including
// the Phase 19.2 digit and alef-maqsura folds.
//
// KEEP IN SYNC: these rules must match src/core/matchers/arabic-normalizer.js. The
// normalize-content test asserts both implementations return identical output for a
// range of inputs, so drift fails the suite instead of going unnoticed.

/**
 * Normalize Arabic text according to the following rules:
 * 1. Remove diacritics/tashkeel (fatḥa, ḍamma, kasra, shadda, sukun)
 * 2. Remove invisible formatting marks (zero-width, bidi controls, tatweel)
 * 3. Normalize Alef variants: أ → ا, إ → ا, آ → ا
 * 4. Fold Arabic-Indic and Extended Arabic-Indic digits to ASCII (Phase 19.2)
 * 5. Normalize alef maqsura to ya: ى → ي (Phase 19.2)
 * 6. Collapse repeated whitespace into single space and trim
 * 7. Remove punctuation, including the Arabic and typographic variants
 *
 * @param {string} text - The Arabic text to normalize
 * @returns {string} Normalized text
 */
function normalizeArabic(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let normalized = text;

  // Step 1: Remove diacritics/tashkeel (fatḥa, ḍamma, kasra, shadda, sukun)
  const diacriticsRegex = /[\u064B-\u065F\u0670]/g;
  normalized = normalized.replace(diacriticsRegex, '');


  // Step 2: Remove invisible formatting marks.
  //
  // These carry no readable content but they DO break substring matching. A comment
  // that visibly reads "تم" is NOT the string "تم" if an invisible code point sits
  // between the two letters, so text.includes(phrase) is false and a configured
  // contains trigger silently reports NO_MATCH.
  //
  // Real YouTube comment text carries these: right-to-left marks (U+200F/U+200E/
  // U+061C) around Arabic runs, and zero-width joiner/non-joiner (U+200D/U+200C) for
  // letter shaping. Tatweel (U+0640) is the Arabic elongation character. Every one of
  // them is invisible when the comment is rendered, which is exactly why the text looks
  // correct on screen while matching fails.
  //
  // This is the same category of operation as step 1: removing characters that are
  // present in the string but carry no readable meaning. It is applied to BOTH the
  // comment and the trigger phrase, so it stays symmetric and cannot make two
  // visually different strings compare equal.
  const invisibleMarksRegex = /[\u0640\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
  normalized = normalized.replace(invisibleMarksRegex, '');

  // Step 3: Normalize Alef variants to standard Alef (ا)
  normalized = normalized
    .replace(/أ/g, 'ا')   // Alef with fatḥa
    .replace(/إ/g, 'ا')   // Alef with ḍamma
    .replace(/آ/g, 'ا');  // Alef with hamza

  // Step 4: Fold Arabic-Indic digits to ASCII (Phase 19.2).
  //
  // Two digit sets are in real use in Arabic text: Arabic-Indic (U+0660..U+0669,
  // "٠١٢٣") and Extended Arabic-Indic (U+06F0..U+06F9, "۰۱۲۳", used on Persian and
  // Urdu keyboards). They mean the same digits as ASCII but are different code points,
  // so a viewer typing a price on an Arabic keyboard writes "بكام ٩٩" while a trigger
  // typed on a Latin keyboard stores "بكام 99" and the two never match.
  //
  // Applied to the comment and the phrase alike, so it only ever equates the same
  // number written two ways.
  normalized = normalized
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[\u06F0-\u06F9]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 0x30));

  // Step 5: Normalize alef maqsura to ya (Phase 19.2).
  //
  // ى (U+0649, alef maqsura) and ي (U+064A, ya) are different code points that readers
  // treat as the same letter: "على" and "علي" are one word written two ways, and both
  // spellings turn up in real comments. This is the same fold Unicode applies for
  // search (UAX #15 confusable mapping).
  //
  // Farsi yeh (U+06CC) is folded for the same reason: it arrives with the Persian and
  // Urdu keyboards that also carry the Extended Arabic-Indic digits folded above, so a
  // viewer on one of those keyboards writes both differences in the same comment.
  normalized = normalized
    .replace(/ى/g, 'ي')   // alef maqsura
    .replace(/\u06CC/g, 'ي');  // Farsi yeh, from Persian/Urdu keyboards

  // Step 6: Collapse repeated whitespace and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Step 7: Remove punctuation, including the Arabic and typographic variants.
  //
  // U+06D4 is the Arabic full stop, U+00AB/U+00BB the guillemets Arabic text uses for
  // quotation, and U+2018..U+201D the curly quotes. Each is punctuation rather than
  // content, so a phrase should not stop matching because the commenter typed an
  // Arabic comma instead of an English one.
  const punctuationRegex = /[.,!?;:'"<>())\[\]{}@#$%؟،؛۔«»‘’“”]/g;
  normalized = normalized.replace(punctuationRegex, '');
  return normalized;
}

if (typeof globalThis !== 'undefined') {
  globalThis.normalizeArabic = normalizeArabic;
} else if (typeof window !== 'undefined') {
  window.normalizeArabic = normalizeArabic;
}
