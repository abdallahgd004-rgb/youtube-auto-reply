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

  // Default response for unknown message types
  sendResponse({ status: 'ok' });
  return true;
});

// Log startup message for verification
chrome.runtime.onInstalled.addListener(() => {
  console.log('[YouTube Auto Reply] Extension installed');
});