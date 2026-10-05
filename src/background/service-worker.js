// Background Service Worker - YouTube Auto Reply Extension
// Phase 1: Minimal initialization only + Phase 3.5: Connection Test

console.log('[YouTube Auto Reply] Background service worker initialized');

import { getModels, chatCompletion } from './api-client.js';

// Single consolidated message handler for all message types
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      sendResponse({ success: true, received: true });
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