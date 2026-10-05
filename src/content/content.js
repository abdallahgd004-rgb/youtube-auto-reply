// Content Script - YouTube Auto Reply Extension
// Phase 1: Minimal initialization only (no comment detection yet)

console.log('[YouTube Auto Reply] Content script loaded on YouTube page');

// Verify we're on a valid YouTube page
if (window.location.hostname === 'www.youtube.com') {
  console.log('[YouTube Auto Reply] Running on YouTube domain');
} else {
  console.warn('[YouTube Auto Reply] Not running on YouTube - skipping');
}
