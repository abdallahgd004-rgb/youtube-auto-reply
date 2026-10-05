// Background Service Worker - YouTube Auto Reply Extension
// Phase 6.3: Matching logic with trigger rules
// Phase 9.x: Deduplication — handled-comments store + in-session reply deduplicator

console.log('[YouTube Auto Reply] Background service worker initialized');

import { getModels, chatCompletion } from './api-client.js';
import { getTriggers } from '../core/trigger-crud.js';
import { match as containsMatch } from '../core/matchers/contains-matcher.js';
import { match as exactMatch } from '../core/matchers/exact-matcher.js';
import { buildReplyPrompt } from '../core/prompt-builder.js';
import { getSettings } from '../core/storage.js';

// Phase 9.x — Deduplication imports
import { createFingerprint } from '../core/comment-fingerprint.js';
import { isHandled, markHandled } from '../core/handled-comments.js';
import { createReplyDeduplicator } from '../core/reply-deduplicator.js';

// In-session reply deduplicator (fast path).
// NOTE: This state is lost when the service worker is killed and restarted.
// That is acceptable — the persistent `handledComments` store in chrome.storage.local
// is the real guard; this deduplicator just avoids redundant LM Studio calls within a session.
const replyDedup = createReplyDeduplicator();

// Platform constant for this single-platform MVP (YouTube only).
const PLATFORM_SITE = 'YouTube';

// Single consolidated message handler for all message types
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === 'openPopup') {
    chrome.tabs.create({ url: 'popup/popup.html' });
    return true; // Keep channel open for sendResponse
  }
  
  if (message.action === 'openOptions') {
    chrome.tabs.create({ url: 'options/options.html' });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'GET_LM_STUDIO_MODELS') {
    getModels()
      .then(models => {
        sendResponse({ success: true, models });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Error getting models:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CONNECTION') {
    // Use chatCompletion with a minimal request to test connectivity
    const messages = [
      { role: 'user', content: 'ping' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ 
          success: true, 
          model: result.raw.model || 'unknown',
          text: result.text?.substring(0, 50) + (result.text && result.text.length > 50 ? '...' : '')
        });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Connection test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'TEST_CHAT_COMPLETION') {
    // Non-destructive test that returns full chat completion response
    const messages = [
      { role: 'user', content: 'Say hello' }
    ];
    
    chatCompletion(messages)
      .then(result => {
        sendResponse({ success: true, text: result.text });
        return true; // Keep channel open for sendResponse
      })
      .catch(error => {
        console.error('[YouTube Auto Reply] Chat completion test error:', error.message);
        sendResponse({ success: false, error: error.message });
        return true; // Keep channel open for sendResponse
      });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'GET_ENABLED_STATE') {
    chrome.storage.local.get('enabled', result => {
      const enabled = result.enabled !== undefined ? result.enabled : false;
      sendResponse({ enabled: enabled });
      return true; // Keep channel open for sendResponse
    });
    return true; // Keep channel open for sendResponse
  }

  if (message.action === 'COMMENT_DETECTED') {
    const { id, author, text } = message.data || {};
    
    // Defensive: guard against missing/malformed payload
    // Only `id` is required (dedup key); `text` validated in parseComment; `author` may be empty.
    if (!id) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED received invalid payload:', 
        'missing id field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (id)' });
    } else if (!text) {
      console.error('[YouTube Auto Reply] COMMENT_DETECTED received invalid payload:', 
        'missing text field. Received data:', JSON.stringify(message.data));
      sendResponse({ success: false, error: 'Missing required comment field (text)' });
    } else {
      // Normalize author for logging; empty is valid.
      const logAuthor = author || 'unknown';
      const textPreview = text.length > 100 ? text.substring(0, 100) + '...' : text;
      console.log('[YouTube Auto Reply] COMMENT_DETECTED received:', 
        `id=${id}, author=${logAuthor}, text="${textPreview}"`);

      // ── Phase 9.x: Build fingerprint and check handled store ───────────────
      const comment = message.data?.comment;
      const pageInfo = {
        site: PLATFORM_SITE,
        url: sender.tab?.url,   // undefined if sender.tab is absent (e.g. extension page)
      };
      const fingerprint = createFingerprint(comment, pageInfo);

      if (await isHandled(fingerprint)) {
        console.log(`[YouTube Auto Reply] COMMENT_DETECTED: SKIPPED_ALREADY_HANDLED - fp=${fingerprint}`);
        sendResponse({ success: true, id, result: 'SKIPPED_ALREADY_HANDLED' });
        return true;
      }

      // Fetch trigger rules and perform matching
      let verdict = { success: true, id };
      try {
        const triggers = await getTriggers();
        
        // Filter to only enabled rules with non-empty phrases arrays
        const activeRules = triggers.filter(rule => rule.enabled && Array.isArray(rule.phrases) && rule.phrases.length > 0);
        
        if (activeRules.length === 0) {
          console.log('[YouTube Auto Reply] COMMENT_DETECTED: NO_MATCH - no enabled rules');
          verdict.result = 'NO_MATCH';
        } else {
          // Iterate through active rules; first match wins
          for (const rule of activeRules) {
            let matchedResult;
            
            if (rule.matchMode === 'contains') {
              matchedResult = containsMatch(text, rule.phrases, rule.caseSensitive);
            } else if (rule.matchMode === 'exact') {
              matchedResult = exactMatch(text, rule.phrases, rule.caseSensitive);
            } else {
              // Unknown match mode - skip this rule
              console.warn(`[YouTube Auto Reply] COMMENT_DETECTED: skipping rule ${rule.id} with unknown matchMode "${rule.matchMode}"`);
              continue;
            }
            
            if (matchedResult.matched) {
              const matchedPhrase = matchedResult.matchedPhrase || '';
              console.log(`[YouTube Auto Reply] COMMENT_DETECTED: MATCH - id=${id}, result=MATCH, phrase="${matchedPhrase}"`);
              verdict.result = 'MATCH';
              verdict.matchedPhrase = matchedPhrase;
              verdict.ruleId = rule.id;
              break; // First match wins
            }
          }
          
          if (!verdict.result) {
            console.log('[YouTube Auto Reply] COMMENT_DETECTED: NO_MATCH - no rules matched');
            verdict.result = 'NO_MATCH';
          }
        }
      } catch (error) {
        console.error('[YouTube Auto Reply] COMMENT_DETECTED error:', error.message);
        sendResponse({ success: false, error: `Matching failed: ${error.message}` });
        return true; // Keep channel open for sendResponse
      }
      
      // Only attempt generation when verdict.result === 'MATCH'
      if (verdict.result === 'MATCH') {
        let settings;
        let messages;
        try {
          settings = await getSettings();
          messages = buildReplyPrompt({ text }, settings);
        } catch (error) {
          console.error('[YouTube Auto Reply] COMMENT_DETECTED: Prompt build failed:', error.message);
          sendResponse({ success: false, error: `Prompt build failed: ${error.message}` });
          return true; // Keep channel open for sendResponse
        }

        try {
          console.log(`[YouTube Auto Reply] COMMENT_DETECTED: generation attempted for comment id=${verdict.id}`);
          const result = await chatCompletion(messages);

          // Log outcome AFTER the call resolves
          const replyText = result.text || '';
          console.log(`[YouTube Auto Reply] COMMENT_DETECTED: generation completed for comment id=${verdict.id}, reply length=${replyText.length}, preview="${(replyText || '').substring(0, 100)}..."`);
          verdict.reply = replyText;

          // ── Two independent decisions, deliberately decoupled ───────────────
          // 1. In-session reply deduplication (replyDedup): may suppress
          //    near-identical replies across different comments in the same cycle.
          // 2. Persistent marking (markHandled): records that THIS comment was
          //    handled so it won't be replayed after a service-worker restart.
          // The persistent store must NOT depend on reply similarity — two
          // different comments should both be recorded even if their replies
          // are near-duplicates (Rule 4 of the deduplicator). See bug #2.

          // Decision A: in-session reply deduplication verdict.
          const isReplyDuplicate = replyDedup.isDuplicate({
            reply: replyText,
            commentId: verdict.id,
          });
          if (isReplyDuplicate) {
            console.log(
              `[YouTube Auto Reply] COMMENT_DETECTED: in-session duplicate suppressed - fp=${fingerprint}`
            );
          }

          // Decision B: persistent marking — independent of reply similarity.
          // Only mark when generation succeeded, the reply is non-empty,
          // and dry-run is disabled. An empty reply is not a real reply;
          // persisting it would silently lose the comment.
          if (replyText && !settings.dryRun) {
            await markHandled(fingerprint);
          }
        } catch (error) {
          console.error('[YouTube Auto Reply] COMMENT_DETECTED: Generation failed:', error.message);
          sendResponse({ success: false, error: `Generation failed: ${error.message}` });
          return true; // Keep channel open for sendResponse
        }
      }
      
      sendResponse(verdict);
    }
    return true; // Keep channel open for sendResponse
  }

  // Default response for unknown message types
  sendResponse({ status: 'ok' });
  return true;
});

// Log startup message for verification
chrome.runtime.onInstalled.addListener(() => {
  console.log('[YouTube Auto Reply] Extension installed');
});