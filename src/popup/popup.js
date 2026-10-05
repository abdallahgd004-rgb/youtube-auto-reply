// Popup Script - YouTube Auto Reply Extension
// Task 1.3: Popup UI + Task 2.4: Storage Binding

import { getSettings, saveSettings } from '../core/storage.js';

console.log('[YouTube Auto Reply] Popup opened');

let currentEnabled = false;

/**
 * Load settings and update the UI.
 */
async function loadSettings() {
  try {
    const settings = await getSettings();
    currentEnabled = settings.enabled ?? false;
    
    // Update status display
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
      statusDisplay.textContent = `Status: ${currentEnabled ? 'ON' : 'OFF'}`;
    }
    
    // Update button label after settings loaded
    const toggleBtn = document.getElementById('toggle-btn');
    if (toggleBtn) {
      toggleBtn.textContent = currentEnabled ? 'OFF' : 'ON';
    }
    
  } catch (error) {
    console.error('[YouTube Auto Reply] Error loading settings:', error);
    // On error, default to OFF state for safety
    currentEnabled = false;
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
      statusDisplay.textContent = 'Status: OFF';
    }
    const toggleBtn = document.getElementById('toggle-btn');
    if (toggleBtn) {
      toggleBtn.textContent = 'ON';
    }
  }
}

/**
 * Handle toggle button click.
 */
async function handleToggle() {
  try {
    const newEnabled = !currentEnabled;
    await saveSettings({ enabled: newEnabled });
    currentEnabled = newEnabled;
    
    // Update status display immediately after the write resolves
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
      statusDisplay.textContent = `Status: ${newEnabled ? 'ON' : 'OFF'}`;
    }
    
    // Also update button label to reflect new state
    const toggleBtn = document.getElementById('toggle-btn');
    if (toggleBtn) {
      toggleBtn.textContent = currentEnabled ? 'OFF' : 'ON';
    }
  } catch (error) {
    console.error('[YouTube Auto Reply] Error saving settings:', error);
    // Show error state but don't block the UI
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl) {
      errorMessageEl.textContent = 'Error: Could not save setting';
      errorMessageEl.style.display = 'block';
    }
  }
}

/**
 * Handle settings button click - open options page.
 */
function handleSettings() {
  chrome.runtime.sendMessage({ action: 'openOptions' });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('[YouTube Auto Reply] Popup ready');
  
  // Load current settings (this also updates the button label)
  loadSettings();
  
  // Attach toggle button handler
  const toggleBtn = document.getElementById('toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', handleToggle);
  }
  
  // Attach settings button handler
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', handleSettings);
  }
});
