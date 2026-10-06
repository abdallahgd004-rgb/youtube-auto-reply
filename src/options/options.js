// Options Page Script - YouTube Auto Reply Extension
// Phase 3: Model dropdown with LM Studio integration + Phase 3.5: Connection Test

import { getSettings, saveSettings } from '../core/storage.js';
import { getTriggers } from '../core/trigger-crud.js';

console.log('[YouTube Auto Reply] Options page loaded');

/**
 * Normalize a Base URL for LM Studio.
 *
 * Strips trailing slashes and appends `/v1` when the user omitted it, since
 * api-client builds `${baseUrl}/models`, so the OpenAI-compatible prefix must be
 * part of the saved value. Returns '' for empty input so callers can detect it.
 */
function normalizeBaseUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const withoutSlash = trimmed.replace(/\/+$/, '');
  if (/\/v\d+$/.test(withoutSlash)) return withoutSlash;
  return withoutSlash + '/v1';
}

let currentSettings = null;
let savedModelValue = ''; // Preserve the saved model value even if unavailable

/**
 * Load existing settings into the form fields.
 */
async function loadSettings() {
  try {
    currentSettings = await getSettings();
    
    const baseUrlInput = document.getElementById('baseUrl');
    const modelSelect = document.getElementById('model');
    
    // Set Base URL value
    baseUrlInput.value = currentSettings.lmStudio.baseUrl || '';
    
    // Preserve the saved model value for later selection if needed
    savedModelValue = currentSettings.lmStudio.model || '';
    
    // Request models from background via service worker
    await loadModels();
  } catch (error) {
    console.error('[YouTube Auto Reply] Error loading settings:', error);
  }
}

/**
 * Load available models from LM Studio and populate the dropdown.
 */
async function loadModels() {
  const modelSelect = document.getElementById('model');
  const messageEl = document.getElementById('message');
  
  // Show loading state
  modelSelect.innerHTML = '<option value="">Loading models...</option>';
  hideMessage();
  clearModelError();
  
  try {
    // Send request to background service worker
    const response = await chrome.runtime.sendMessage({ action: 'GET_LM_STUDIO_MODELS' });
    
    if (response.success) {
      const models = response.models;
      
      if (!models || models.length === 0) {
        // Empty model list
        modelSelect.innerHTML = '<option value="">No models available</option>';
        showMessage('No models available', 'warning');
        return;
      }
      
      // Populate dropdown with model IDs
      const optionsHtml = models.map(model => 
        `<option value="${escapeHtml(model.id)}">${model.id}</option>`
      ).join('');
      
      modelSelect.innerHTML = '<option value="">Select a model</option>' + optionsHtml;
      
      // Select the saved model if it exists in the list
      if (savedModelValue && models.some(m => m.id === savedModelValue)) {
        modelSelect.value = savedModelValue;
      } else if (savedModelValue) {
        // Saved model is not available - show as temporary selection with indicator
        const savedOption = document.querySelector(`option[value="${escapeHtml(savedModelValue)}"]`);
        if (savedOption) {
          savedOption.textContent = `Saved model unavailable\n${savedModelValue}`;
          savedOption.style.fontStyle = 'italic';
          savedOption.value = savedModelValue; // Keep the original value for storage
        }
      }
    } else {
      // Error loading models
      throw new Error(response.error || 'Failed to load models');
    }
  } catch (error) {
    console.error('[YouTube Auto Reply] Error loading models:', error.message);
    
    // Show error state but keep the form usable
    modelSelect.innerHTML = '<option value="">Unable to load models</option>';
    showModelError(
      `${error.message} — check that LM Studio is running, and that the Base URL is reachable ` +
      `and permitted in the extension's host permissions.`
    );
  }
}

/**
 * Handle form submission to save settings.
 */
async function handleSave(event) {
  event.preventDefault();
  
  const baseUrlInput = document.getElementById('baseUrl');
  const modelSelect = document.getElementById('model');
  
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  
  // Get selected model value (preserves saved model even if unavailable)
  const model = modelSelect.value;
  
  try {
    // Save only the lmStudio settings with baseUrl and model
    await saveSettings({
      lmStudio: {
        baseUrl,
        model
      }
    });
    
    // Show success message
    showMessage('Settings saved', 'success');
    
    // Clear message after 2 seconds
    setTimeout(() => {
      hideMessage();
    }, 2000);
    
  } catch (error) {
    console.error('[YouTube Auto Reply] Error saving settings:', error);
    showMessage('Error saving settings', 'error');
  }
}

/**
 * Test connection to LM Studio.
 */
async function testConnection() {
  const testBtn = document.getElementById('test-connection-btn');
  const messageEl = document.getElementById('message');
  const resultEl = document.getElementById('connection-result');
  
  // Disable button during test
  testBtn.disabled = true;
  testBtn.textContent = 'Testing...';
  hideMessage();
  clearResult();
  
  try {
    // Send request to background service worker for connection test
    const response = await chrome.runtime.sendMessage({ action: 'TEST_CONNECTION' });
    
    if (response.success) {
      // Success - show result in dedicated element
      resultEl.textContent = `✓ Connection successful! Model: ${escapeHtml(response.model || 'unknown')}`;
      resultEl.className = 'success visible'
      
      // Also show a brief success message
      showMessage('Connection test passed', 'success');
    } else {
      throw new Error(response.error || 'Connection test failed');
    }
  } catch (error) {
    console.error('[YouTube Auto Reply] Connection test error:', error.message);
    
    // Show error in dedicated element
    resultEl.textContent = `✗ ${escapeHtml(error.message)}`;
    resultEl.className = 'error visible'
    
    showMessage('Connection test failed', 'error');
  } finally {
    // Re-enable button
    testBtn.disabled = false;
    testBtn.textContent = 'Test LM Studio Connection';
  }
}

/**
 * Test chat completion with a simple prompt.
 */
async function testChatCompletion() {
  const chatBtn = document.getElementById('test-chat-completion-btn');
  const chatResultEl = document.getElementById('chat-result');
  
  // Disable button during test
  chatBtn.disabled = true;
  chatBtn.textContent = 'Testing...';
  hideChatMessage();
  clearChatError();
  
  try {
    // Send request to background service worker for chat completion test
    const response = await chrome.runtime.sendMessage({ action: 'TEST_CHAT_COMPLETION' });
    
    if (response.success) {
      // Success - show full response text
      let displayText = response.text;
      if (displayText.length > 300) {
        displayText = displayText.substring(0, 300).trim() + '...';
      }
      chatResultEl.textContent = `✓ Response:\n${escapeHtml(displayText)}`;
      chatResultEl.className = 'message visible success';
    } else {
      throw new Error(response.error || 'Chat completion test failed');
    }
  } catch (error) {
    console.error('[YouTube Auto Reply] Chat completion test error:', error.message);
    
    // Show error
    chatResultEl.textContent = `✗ ${escapeHtml(error.message)}`;
    chatResultEl.className = 'message visible error';
  } finally {
    // Re-enable button
    chatBtn.disabled = false;
    chatBtn.textContent = 'Test Chat Completion';
  }
}

/**
 * Show a message to the user.
 */
function showMessage(text, type = '') {
  const messageEl = document.getElementById('message');
  messageEl.textContent = text;
  messageEl.className = 'message visible ' + type;
}

/**
 * Hide any displayed message.
 */
function hideMessage() {
  const messageEl = document.getElementById('message');
  messageEl.classList.remove('visible', 'success', 'error', 'warning');
  messageEl.textContent = '';
}

/**
 * Show error message near Model field.
 */
function showModelError(message) {
  const errorEl = document.getElementById('model-error');
  errorEl.textContent = message;
  errorEl.style.display = 'block';
}

/**
 * Clear any displayed error message.
 */
function clearModelError() {
  const errorEl = document.getElementById('model-error');
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

/**
 * Clear connection result display.
 */
function clearResult() {
  const resultEl = document.getElementById('connection-result');
  resultEl.className = 'hidden'
}

/**
 * Load and display trigger rules in the triggers list.
 */
async function loadTriggers() {
  try {
    const triggers = await getTriggers();
    renderTriggersList(triggers);
  } catch (error) {
    console.error('[YouTube Auto Reply] Error loading triggers:', error);
  }
}

/**
 * Render the triggers list in the UI.
 */
function renderTriggersList(triggers) {
  const container = document.getElementById('triggers-list');
  
  if (!triggers || triggers.length === 0) {
    // Empty state
    container.innerHTML = '<p style="color: #666; font-size: 14px;">No triggers yet.</p>';
    return;
  }

  // Render each trigger
  const triggersHtml = triggers.map(trigger => {
    const isDisabled = !trigger.enabled;
    const statusIcon = isDisabled ? '⏸️' : '✅';
    const statusText = isDisabled ? '(disabled)' : '';
    
    // Escape phrases for safe display
    const escapedPhrases = trigger.phrases.map(phrase => escapeHtml(phrase)).join(', ');
    
    return `
      <div class="trigger-item ${isDisabled ? 'disabled' : ''}">
        <span style="font-size: 12px; color: #666;">${statusIcon}</span>
        <span>${escapedPhrases}</span>
        ${statusText ? `<span style="font-size: 11px; color: #999; margin-left: 8px;">${statusText}</span>` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = triggersHtml;
}

/**
 * Load settings and initialize the page.
 */
async function init() {
  await loadSettings();
  await loadTriggers();
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Hide any displayed chat message.
 */
function hideChatMessage() {
  const chatResultEl = document.getElementById('chat-result');
  if (chatResultEl) {
    chatResultEl.classList.remove('visible', 'success', 'error');
    chatResultEl.style.display = 'none';
  }
}

/**
 * Clear any displayed chat error.
 */
function clearChatError() {
  const chatResultEl = document.getElementById('chat-result');
  if (chatResultEl) {
    chatResultEl.classList.remove('error');
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('[YouTube Auto Reply] Settings page ready');
  
  // Initialize the page (loads settings and triggers)
  init();
  
  // Attach save handler to form
  const form = document.getElementById('settings-form');
  if (form) {
    form.addEventListener('submit', handleSave);
  }
  
  // Attach test connection button handler
  const testBtn = document.getElementById('test-connection-btn');
  if (testBtn) {
    testBtn.addEventListener('click', testConnection);
  }
  
  // Attach chat completion test button handler
  const chatBtn = document.getElementById('test-chat-completion-btn');
  if (chatBtn) {
    chatBtn.addEventListener('click', testChatCompletion);
  }
});