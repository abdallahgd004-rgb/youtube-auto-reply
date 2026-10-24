// Semantic Trigger Matching — LM Studio decides whether a comment matches a trigger
//
// Platform-agnostic by design: no `chrome.*`, no DOM, no `fetch`. The completion
// function is INJECTED (the service worker passes the existing `chatCompletion` from
// background/api-client.js), so this module adds no second HTTP client and is fully
// testable without a network.
//
// WHY THIS EXISTS: matching used to be a local deterministic `includes()` / `===`
// check in processJob(). That cannot read Arabic intent — "بكام" would not match
// "كام سعره؟", and "منين أجيب" would not match "جيبه من فين". LM Studio now answers the
// only question that matters: does this comment express the intent behind any enabled
// trigger?
//
// SCOPE: classification ONLY. This module never generates a reply, never writes to
// storage and never touches the DOM. It returns a verdict and the caller decides.
//
// FAIL-SAFE CONTRACT (the whole point of this file):
//   - LM Studio unreachable      -> ok:false, no match, no reply generated
//   - budget spent on thinking   -> ok:false, no match, no reply generated
//   - malformed / non-JSON reply -> ok:false, no match, no reply generated
//   - unexpected schema          -> ok:false, no match, no reply generated
// There is NO path through this module that returns matched:true without a literal
// `true` parsed out of the model's own JSON. A failure can therefore never be mistaken
// for a match, which is what would otherwise cause a reply to every comment on the page.

/**
 * Decoding options for the classification call.
 *
 * `temperature: 0` because this is a decision, not prose — the same comment and the
 * same triggers should always produce the same verdict.
 *
 * `maxTokens` is the size of the PAYLOAD, not of the request. The verdict reads
 * `{"matched":true,"trigger":"بكام"}` and never needed 64 tokens to be written, which is
 * exactly why this was wrong: against the reasoning model actually in use
 * (`google/gemma-4-e2b`) the call came back `finish_reason:"length"` with an EMPTY
 * `content`, all 64 tokens spent thinking, and this module reported the result as
 * "no JSON object in response" — pointing at the parser when the cause was the ceiling.
 *
 * Phase 20.24 moves the number to `core/reasoning-budget.js`, which owns the rule for every
 * structured call and states why a generous ceiling is free (`max_tokens` is a cap, not a
 * reservation). Do not inline a ceiling here: a bare `maxTokens` is a number that looks right
 * and silently is not, which is precisely how this broke in the first place.
 */
// Phase 19.9 — imported for the DIAGNOSTIC cross-check only. The local matchers stay out of
// the runtime decision (see the note on withDiagnostic): the model reads intent, a
// substring test does not.
import { normalizeArabic } from './matchers/arabic-normalizer.js';
import { match as containsMatch } from './matchers/contains-matcher.js';
import { structuredCallOptions } from './reasoning-budget.js';

/** Size of the JSON verdict this call has to be able to emit. */
export const SEMANTIC_MATCH_PAYLOAD_TOKENS = 64;

export const SEMANTIC_MATCH_OPTIONS = Object.freeze(
  structuredCallOptions({ maxTokens: SEMANTIC_MATCH_PAYLOAD_TOKENS, operation: 'SEMANTIC_MATCH' })
);

/**
 * Reduce enabled trigger rules to a flat, de-duplicated phrase list plus the reverse
 * lookup that turns a returned phrase back into the rule that owns it.
 *
 * The semantic pass works on phrases, not rules, because the model answers "which of
 * these intents is this?" — the rule grouping is a UI/storage concern. Rule ids are
 * recovered afterwards so the activity log keeps recording `matchedRule`.
 *
 * Unusable input is dropped rather than sent: a phrase must be a non-empty string.
 *
 * @param {Array<Object>} rules - trigger rules ({id, enabled, phrases})
 * @returns {{phrases: string[], ruleIdByPhrase: Map<string,string>}}
 */
export function flattenTriggerPhrases(rules) {
  const phrases = [];
  const ruleIdByPhrase = new Map();
  if (!Array.isArray(rules)) return { phrases, ruleIdByPhrase };

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (!Array.isArray(rule.phrases)) continue;

    const ruleId = typeof rule.id === 'string' ? rule.id : '';
    for (const phrase of rule.phrases) {
      if (typeof phrase !== 'string') continue;
      const trimmed = phrase.trim();
      if (!trimmed) continue;
      // First rule wins, matching the old "first match wins" behaviour.
      if (!ruleIdByPhrase.has(trimmed)) ruleIdByPhrase.set(trimmed, ruleId);
      if (!phrases.includes(trimmed)) phrases.push(trimmed);
    }
  }

  return { phrases, ruleIdByPhrase };
}

/**
 * Build the classification prompt.
 *
 * Kept as short as reliability allows: one system line fixing the output contract, one
 * user message carrying the triggers and the comment. There is deliberately no request
 * to explain, no chain-of-thought, no request to describe the video and no request for
 * a reply — every one of those would cost tokens and invite prose into the output.
 *
 * @param {string} commentText
 * @param {string[]} phrases - enabled trigger phrases
 * @returns {Array<{role: string, content: string}>}
 */
export function buildSemanticMatchMessages(commentText, phrases) {
  const triggers = Array.isArray(phrases) ? phrases.filter((p) => typeof p === 'string' && p.trim()) : [];

  return [
    {
      role: 'system',
      content:
        'You classify YouTube comments. Decide whether a comment expresses the same intent as any given trigger phrase. ' +
        'Understand Egyptian Arabic, Modern Standard Arabic, paraphrases, and spelling variations that preserve intent. ' +
        'A comment that merely shares a word with a trigger is NOT a match. ' +
        'Answer with JSON only, no explanation, no markdown: {"matched":true,"trigger":"<the trigger phrase>"} or {"matched":false}'
    },
    {
      role: 'user',
      content:
        'Triggers:\n' +
        triggers.map((p) => `- ${p}`).join('\n') +
        '\n\nComment:\n' +
        String(commentText == null ? '' : commentText) +
        '\n\nJSON only.'
    }
  ];
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that requiring a bare parse would
 * fail on correct answers, so the fences and any surrounding text are stripped first.
 *
 * @param {string} raw
 * @returns {string|null} the JSON substring, or null if none is present
 */
function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  return text.slice(start, end + 1);
}

/**
 * Interpret a model response as a verdict.
 *
 * This is the safety boundary. It returns matched:true ONLY when the model's own JSON
 * carries a boolean `true`. Anything else — invalid JSON, a missing field, a string
 * "true", a negated object, an empty reply — is `ok:false`. Callers treat ok:false as
 * "do not reply", so an unreadable answer can never turn into a reply.
 *
 * @param {string} raw - the assistant text from LM Studio
 * @returns {{ok: boolean, matched: boolean, trigger: string, reason: string}}
 */
export function parseSemanticMatchResult(raw) {
  const failure = (reason) => ({ ok: false, matched: false, trigger: '', reason });

  const json = extractJson(raw);
  if (!json) return failure('no JSON object in response');

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return failure('invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('unexpected schema');
  }

  // Strict identity check on a real boolean. `parsed.matched === 'true'` or a truthy
  // 1 would both let a malformed answer through, so neither is accepted.
  if (typeof parsed.matched !== 'boolean') return failure('matched is not a boolean');
  if (parsed.matched !== true) return { ok: true, matched: false, trigger: '', reason: 'no_match' };

  const trigger = typeof parsed.trigger === 'string' ? parsed.trigger.trim() : '';
  if (!trigger) return failure('matched without a trigger phrase');

  return { ok: true, matched: true, trigger, reason: 'match' };
}

/**
 * Ask LM Studio whether a comment matches any of the given triggers.
 *
 * Never rejects. A transport error, a timeout or an unreadable answer all come back as
 * `{ok:false, matched:false}` so one failed classification cannot take down the queue.
 *
 * @param {Object} params
 * @param {string} params.commentText
 * @param {string[]} params.phrases - enabled trigger phrases
 * @param {Function} params.complete - async (messages, options) => {text, reasoning}
 *        Injected so this module reuses the existing API client rather than adding one.
 * @returns {Promise<{ok: boolean, matched: boolean, trigger: string, reason: string}>}
 */
export async function semanticMatchTriggers({ commentText, phrases, complete }) {
  if (typeof complete !== 'function') {
    return { ok: false, matched: false, trigger: '', reason: 'no completion function' };
  }

  const triggers = Array.isArray(phrases) ? phrases.filter((p) => typeof p === 'string' && p.trim()) : [];

  // Nothing configured to match against. Calling the model with an empty trigger list
  // would spend a request to be told there is nothing to match, so this is reported
  // without a request. It is a configuration guard, not a local matching decision.
  if (triggers.length === 0) {
    return { ok: true, matched: false, trigger: '', reason: 'no enabled triggers' };
  }

  let response;
  try {
    response = await complete(
      buildSemanticMatchMessages(commentText, triggers),
      {
        ...SEMANTIC_MATCH_OPTIONS,
        // Phase 19.9 — name this request in the diagnostic log. Without it every
        // classification call is recorded as `operation=UNKNOWN`, which is
        // indistinguishable from any other LM Studio call — so "the classifier failed" and
        // "reply generation failed" were impossible to tell apart when diagnosing a
        // comment that was detected but never matched.
        operation: 'SEMANTIC_MATCH'
      }
    );
  } catch (error) {
    // LM Studio offline, timed out, model not loaded — all indistinguishable here and
    // all equally "do not reply".
    //
    // Phase 20.24 — a thinking-model budget overrun now reaches here as its own case. It is
    // kept distinct from the generic wording because it is not a transport problem: retrying
    // and choosing another model fix neither, and only raising the ceiling does. Losing that
    // distinction is how this bug survived as "the classifier is unreliable".
    const reason = error && error.isReasoningBudget
      ? 'the model spent the whole token budget thinking and returned no verdict'
      : 'LM Studio call failed: ' + (error && error.message ? error.message : 'unknown error');
    return {
      ok: false,
      matched: false,
      trigger: '',
      reason
    };
  }

  const text = response && typeof response.text === 'string' ? response.text : '';
  if (!text.trim()) {
    // A reasoning model that spent the whole token budget thinking leaves content
    // empty. Treated as a controlled failure, never as a match.
    return withDiagnostic({ ok: false, matched: false, trigger: '', reason: 'empty response' }, commentText, triggers);
  }

  return withDiagnostic(parseSemanticMatchResult(text), commentText, triggers);
}

/**
 * Attach the Phase 19.9 diagnostic cross-check to a verdict.
 *
 * WHY THIS EXISTS: a comment can be detected and still not match, and the Side Panel shows
 * that only as "matched 0 / failed 1" — which reads like a NO_MATCH but is actually the
 * error branch (a genuine NO_MATCH does not increment failed/skipped). There was no way to
 * tell those apart, and no way to see WHAT the classifier was given.
 *
 * This records, without changing any decision:
 *   - the normalized comment text (as a VERBOSE-gated preview)
 *   - the normalized trigger phrases
 *   - what the deterministic contains matcher would have said
 *
 * The cross-check is an OBSERVATION. `src/core/matchers/*` stays out of the runtime flow —
 * it cannot read Arabic intent, which is why the model decides. Running it here proves the
 * opposite point that matters when a match is missed: if the local matcher says "matched"
 * and the model said no (or failed), the problem is the classification, not the phrase,
 * the normalization or the parser.
 *
 * @param {{ok: boolean, matched: boolean, trigger: string, reason: string}} verdict
 * @param {string} commentText
 * @param {string[]} phrases
 * @returns {object} the same verdict, plus a `diagnostic` field
 */
function withDiagnostic(verdict, commentText, phrases) {
  let local = { matched: false, matchedPhrase: null };
  try {
    const result = containsMatch(commentText, phrases, false);
    local = { matched: !!result.matched, matchedPhrase: result.matchedPhrase || null };
  } catch (_) {
    // The cross-check must never be the reason a verdict fails to return.
  }

  return {
    ...verdict,
    diagnostic: {
      normalizedComment: String(commentText == null ? '' : commentText),
      normalizedPhrases: phrases.map((p) => normalizeArabic(p)),
      containsCrossCheck: local
    }
  };
}
