# YouTube Auto Reply - Chrome Extension

A Chrome extension that automatically replies to YouTube comments using AI (LM Studio).

## What This Project Is

This is a Chrome extension designed to connect to a local LM Studio API and automatically generate AI-powered replies to YouTube comments that match user-defined trigger keywords or phrases.

## How to Load the Extension in Chrome

1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked"
5. Select the folder containing this project's source files
6. The extension will now appear in your Chrome extensions list

## Manifest V3 Location

The Manifest V3 configuration file is located at: `src/manifest.json`

## What Currently Works (Phase 1)

- ✅ Extension loads successfully in Chrome Developer Mode
- ✅ Background service worker initializes and runs
- ✅ Content script injects into YouTube pages
- ✅ Popup opens when clicking the extension icon
- ✅ Options page opens via the settings gear icon
- ✅ Basic logging for debugging purposes

## What Is Intentionally Not Implemented Yet

The following features are planned but not yet implemented:

- ❌ YouTube comment detection and analysis
- ❌ Trigger keyword matching logic
- ❌ Connection to LM Studio API
- ❌ AI reply generation
- ❌ Inserting replies into YouTube comments
- ❌ Publishing/reply submission functionality
- ❌ Duplicate reply prevention
- ❌ Settings configuration (keywords, triggers, etc.)

## Architecture Overview

The extension follows a layered architecture:

```
Core Logic → Platform Adapter → YouTube
Chrome UI → Background Service Worker → Core Logic
```

This separation ensures that core logic remains independent from platform-specific code.

## Safety Note

This extension does NOT bypass CAPTCHA, anti-bot protections, or any platform security mechanisms. It respects all platform terms of service and safety guidelines.

## Project Status

**Current Phase:** Phase 1 - Foundation Complete

The basic Chrome Extension structure is ready for the next phase of development.
