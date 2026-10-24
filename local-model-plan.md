# YouTube Auto Reply: Step-by-Step Local Model Implementation Plan

> **Comprehensive, prompt-by-prompt engineering specification to build the entire local AI-powered YouTube Auto Reply Chrome extension from scratch using a local LLM.**
> Each Phase is completely self-contained with exact file paths, technical requirements, architectural invariants, verification criteria, and a ready-to-copy prompt block.

---

## 📑 Table of Contents
1. [Project Overview & Core Principles](#1-project-overview--core-principles)
2. [Technical Stack & Architectural Invariants](#2-technical-stack--architectural-invariants)
3. [Instructions for Prompting Local Models](#3-instructions-for-prompting-local-models)
4. [Phase-by-Phase Roadmap](#4-phase-by-phase-roadmap)
   - [Phase 0: Project Setup & Core Configuration](#phase-0-project-setup--core-configuration)
   - [Phase 1: Local LM Studio Client & Reasoning Budget](#phase-1-local-lm-studio-client--reasoning-budget)
   - [Phase 2: Arabic Text Normalization & Basic Matchers](#phase-2-arabic-text-normalization--basic-matchers)
   - [Phase 3: Trigger Rules, Semantic Matching & Reply Prompt Builder](#phase-3-trigger-rules-semantic-matching--reply-prompt-builder)
   - [Phase 4: Safety Layer, Rate Limiting & Reply Validation](#phase-4-safety-layer-rate-limiting--reply-validation)
   - [Phase 5: Queue Management, Inter-comment Delays & Persistence](#phase-5-queue-management-inter-comment-delays--persistence)
   - [Phase 6: YouTube Content Script & DOM Adapter](#phase-6-youtube-content-script--dom-adapter)
   - [Phase 7: Grounded Local Knowledge Base (RAG Pipeline)](#phase-7-grounded-local-knowledge-base-rag-pipeline)
   - [Phase 8: File System Folder Sync & Document Splitter](#phase-8-file-system-folder-sync--document-splitter)
   - [Phase 9: Answered Follow-ups & Target Comment Hearting](#phase-9-answered-follow-ups--target-comment-hearting)
   - [Phase 10: Chrome Side Panel & Options Dashboard UI](#phase-10-chrome-side-panel--options-dashboard-ui)
   - [Phase 11: Master Service Worker Integration & Verification](#phase-11-master-service-worker-integration--verification)
5. [Critical Pitfalls & Hard-Learned Lessons](#5-critical-pitfalls--hard-learned-lessons)

---

## 1. Project Overview & Core Principles

The project is an open-source **Chrome Extension (Manifest V3)** that automatically reads, analyzes, and replies to YouTube comments using local AI models running on the user's computer via an OpenAI-compatible local server (such as [LM Studio](https://lmstudio.ai) or Ollama at `http://localhost:1234/v1`).

### Core Design Rules:
1. **100% Local & Private:** No telemetry, no external cloud APIs, no subscriptions. Data never leaves `localhost`.
2. **Zero Dependencies / No Bundler:** Pure Vanilla JavaScript. No `npm`, no `webpack`, no `vite`, no `package.json`. Background and UI use standard ES Modules (`import`/`export`). Content scripts use Classic Scripts.
3. **Safety-First Channel Protection:**
   - **Dry Run Mode:** On by default; writes the draft into the YouTube reply box without clicking submit.
   - **Human Emulation:** Random inter-comment delays (8–20s) and a rolling 1-hour reply limit (default 30).
   - **Creator Respect:** Never replies to comments that the creator has already replied to, or comments that the creator has hearted (`ignoreHeartedComments`).
4. **Grounded RAG (No Hallucination):** In Knowledge Mode, answers are extracted strictly from local Markdown files. Unsupported claims, invented prices, or fabricated dates are strictly rejected. If facts are missing, the comment is safely skipped.

---

## 2. Technical Stack & Architectural Invariants

- **Browser Target:** Chromium-based browsers (Google Chrome, Brave, Edge).
- **Extension Format:** Manifest V3 (`src/manifest.json`).
  - Permissions: `["storage", "sidePanel", "alarms"]`.
  - Host Permissions: `["http://localhost:1234/*", "http://127.0.0.1:1234/*"]`.
  - Background Service Worker: `"type": "module"`.
  - UI: Chrome Side Panel (`side_panel.default_path: "popup/popup.html"`). **`action.default_popup` must be ABSENT.**
  - Content Scripts: Classic scripts injected at `document_idle`.
- **Local LLM Protocol:** OpenAI REST API compatible (`GET /v1/models`, `POST /v1/chat/completions`).
- **File System API:** Web File System Access API (`showDirectoryPicker`) for direct local markdown folder sync.

---

## 3. Instructions for Prompting Local Models

When working with local code models (e.g., Qwen 2.5 Coder, DeepSeek Coder, Llama 3 Coder):
1. **Execute One Phase at a Time:** Never ask the model to generate the whole codebase at once.
2. **Copy the Dedicated Prompt Block:** Each phase below has a formatted `Prompt for Local Model` block. Copy and paste it verbatim.
3. **Review Before Moving Forward:** Verify the generated code satisfies the file paths and constraints before proceeding to the next phase.

---

## 4. Phase-by-Phase Roadmap

---

### Phase 0: Project Setup & Core Configuration

#### Objective
Establish the directory structure, Chrome Manifest V3 configuration, global diagnostic logger, central default settings, and storage wrapper with safe deep-merge.

#### Files to Create
- `src/manifest.json`
- `src/core/config.js`
- `src/core/dev-log.js`
- `src/core/debug.js`
- `src/core/storage.js`

#### Technical Requirements
1. `src/manifest.json`:
   - `manifest_version`: 3.
   - `permissions`: `["storage", "sidePanel", "alarms"]`.
   - `host_permissions`: `["http://localhost:1234/*", "http://127.0.0.1:1234/*"]`.
   - `background`: `{"service_worker": "background/service-worker.js", "type": "module"}`.
   - `content_scripts`: Match `https://*.youtube.com/*`, `run_at: "document_idle"`. Scripts in exact order:
     `core/dev-log.js`, `content/debug-global.js`, `content/youtube-adapter.js`, `content/arabic-normalizer-global.js`, `content/content.js`.
   - `action`: `{"default_title": "YouTube Auto Reply"}` (NO `default_popup`).
   - `side_panel`: `{"default_path": "popup/popup.html"}`.
   - `options_page`: `"options/options.html"`.
2. `src/core/config.js`:
   - Exports `DEFAULT_CONFIG` with:
     - `enabled`: `false`, `dryRun`: `true`, `targetReplyHeartingEnabled`: `false`.
     - `lmStudio`: `{ baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio", model: "", temperature: 0.7, maxTokens: 1500, systemPrompt: "..." }`.
     - `triggers`: `[]`.
     - `replyBehavior`: `{ minDelayMs: 8000, maxDelayMs: 20000, maxRepliesPerHour: 30, ignoreHeartedComments: true, ignoreCreatorRepliedComments: true, responseStyle: "friendly", replyMode: "trigger", blacklist: [...], followupOnAnswered: false, staticContext: "", contextTemplates: [] }`.
3. `src/core/dev-log.js` & `src/core/debug.js`:
   - `dev-log.js` installs `globalThis.YTAR_DEVLOG` as a classic script. Formats logs with `[YouTube Auto Reply]`, tracks start/end timers, components, and levels.
   - `debug.js` is an ES module exporting `debugLog`, `debugWarn`, `logError`, `DEV_LOG_COMPONENT`, and `DEV_LOG_LEVEL`.
4. `src/core/storage.js`:
   - `deepMerge(stored)`: Merges stored objects over `DEFAULT_CONFIG` without mutating defaults.
   - `getSettings()`: Calls `chrome.storage.local.get(['enabled', 'dryRun', 'lmStudio', 'triggers', 'replyBehavior', 'targetReplyHeartingEnabled'])` and deep merges.
   - `saveSettings(partial)`: Writes partial config back to `chrome.storage.local`.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 0 for the YouTube Auto Reply Chrome extension:

Create the following files using pure Vanilla JavaScript (zero npm dependencies):
1. `src/manifest.json`: Manifest V3 specification. Permissions: storage, sidePanel, alarms. Host permissions: loopback localhost 1234. Background module worker at background/service-worker.js. Side panel default path at popup/popup.html. Ensure action has NO default_popup. Content scripts must match youtube.com and load core/dev-log.js, content/debug-global.js, content/youtube-adapter.js, content/arabic-normalizer-global.js, content/content.js.
2. `src/core/config.js`: Export DEFAULT_CONFIG containing enabled=false, dryRun=true, targetReplyHeartingEnabled=false, lmStudio settings (baseUrl: http://localhost:1234/v1, maxTokens: 1500), triggers array, and replyBehavior (delays 8000-20000ms, maxRepliesPerHour: 30, ignoreHeartedComments: true, ignoreCreatorRepliedComments: true, replyMode: "trigger", blacklist array).
3. `src/core/dev-log.js`: Classic script installing globalThis.YTAR_DEVLOG with methods startTimer(), record(), and log levels (DEBUG, INFO, WARN, ERROR).
4. `src/core/debug.js`: ES module facade exporting debugLog, debugWarn, logError, and referencing YTAR_DEVLOG.
5. `src/core/storage.js`: ES module exporting getSettings() and saveSettings(). Must explicitly read all top-level keys from chrome.storage.local and deep-merge over DEFAULT_CONFIG.

Adhere strictly to ES Module syntax for core/ files and classic script syntax for dev-log.js.
```

---

### Phase 1: Local LM Studio Client & Reasoning Budget

#### Objective
Build the client that communicates with the local OpenAI-compatible endpoint (LM Studio/Ollama) with timeouts, error handling, and reasoning token budget management.

#### Files to Create
- `src/core/reasoning-budget.js`
- `src/background/api-client.js`

#### Technical Requirements
1. `src/core/reasoning-budget.js`:
   - Reasoning models (e.g., DeepSeek-R1, Qwen-2.5, Gemma-2) spend tokens on internal thinking (`<think>`) before outputting JSON. A small `max_tokens` (like 64) causes `content` to return empty!
   - Define a generous ceiling constant: `STRUCTURED_REASONING_BUDGET = 1024` (or 1500).
   - Export helper `getReasoningBudget(operationName)` that returns at least 1024 tokens for all structured JSON calls (`SEMANTIC_MATCH`, `INTENT_ANALYSIS`, `ANSWERABILITY_GATE`, `GROUNDING_VALIDATOR`, `RETRIEVAL_RERANK`).
2. `src/background/api-client.js`:
   - `getModels({ baseUrl, apiKey })`: Calls `GET ${baseUrl}/models` with a 5000ms `AbortController` timeout. Returns an array of `{ id, name }`.
   - `chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens, reasoningTokens })`:
     - Sends `POST ${baseUrl}/chat/completions`.
     - Extracts output from `choices[0].message.content`.
     - Also extracts `choices[0].message.reasoning_content` if present.
     - If the connection fails with `ECONNREFUSED` or `TypeError: Failed to fetch`, return a structured error informing the user that LM Studio is not running at the specified URL.
   - `testConnection({ baseUrl, apiKey, model })`: Pings the server and verifies readiness.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 1 for the YouTube Auto Reply Chrome extension:

Create the following files:
1. `src/core/reasoning-budget.js` (ES Module):
   - Provide token ceiling constants for reasoning models where thinking tokens count against max_tokens.
   - Define STRUCTURED_REASONING_BUDGET = 1024.
   - Export getReasoningBudget(operation) returning 1024+ tokens for structured calls ('SEMANTIC_MATCH', 'INTENT_ANALYSIS', 'ANSWERABILITY_GATE', 'GROUNDING_VALIDATION').
2. `src/background/api-client.js` (ES Module):
   - Import debug utilities from ../core/debug.js.
   - Implement getModels({ baseUrl, apiKey }) fetching /v1/models with 5s timeout.
   - Implement chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens }) sending POST to /v1/chat/completions. Handle AbortSignal timeout, parse response JSON, extract content and reasoning_content, and catch connection failures with human-readable diagnostic messages.
   - Implement testConnection({ baseUrl, apiKey, model }) to quickly probe server health.

Ensure zero npm dependencies and robust error handling.
```

---

### Phase 2: Arabic Text Normalization & Basic Matchers

#### Objective
Provide text normalization and exact/contains matchers with specialized support for Arabic diacritics, character unification, and Eastern/Western numerals.

#### Files to Create
- `src/core/matchers/arabic-normalizer.js`
- `src/content/arabic-normalizer-global.js`
- `src/core/matchers/exact-matcher.js`
- `src/core/matchers/contains-matcher.js`

#### Technical Requirements
1. `src/core/matchers/arabic-normalizer.js` (ES Module):
   - Normalize Alef variants: `[أإآٱ]` → `ا`.
   - Normalize Taa Marbuta: `ة` → `ه`.
   - Normalize Yaa / Alef Maksura: `ى` → `ي`.
   - Strip Arabic diacritics (Harakat / Tashkeel): `[\u064B-\u065F\u0670]`.
   - Strip Tatweel / Kashida: `\u0640`.
   - Convert Eastern/Indic digits (`٠-٩`) to standard Arabic numerals (`0-9`).
   - Collapse redundant whitespace and lowercase English text.
   - Export `normalizeArabic(text)`.
2. `src/content/arabic-normalizer-global.js` (Classic Script):
   - Installs `window.__YTAR_NORMALIZE_ARABIC = normalizeArabic;` for content script usage without ES module imports.
3. `src/core/matchers/exact-matcher.js` & `src/core/matchers/contains-matcher.js`:
   - `matchExact(commentText, phrase)`: Compares normalized strings for strict equality.
   - `matchContains(commentText, phrase)`: Checks if normalized phrase is a substring of normalized comment.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 2 for the YouTube Auto Reply Chrome extension:

Create the text normalization and matcher modules:
1. `src/core/matchers/arabic-normalizer.js` (ES Module):
   - Export normalizeArabic(text): Unifies Alef variants (أ,إ,آ -> ا), Taa Marbuta (ة -> ه), Yaa/Maksura (ى -> ي), strips Tashkeel/diacritics, removes Tatweel (ـ), converts Arabic-Indic digits (٠-٩) to (0-9), collapses whitespace, and lowercases latin text.
2. `src/content/arabic-normalizer-global.js` (Classic Script):
   - Implement the identical normalization logic and assign it to window.__YTAR_NORMALIZE_ARABIC. No import/export syntax!
3. `src/core/matchers/exact-matcher.js` (ES Module):
   - Export matchExact(text, phrase) comparing normalized forms.
4. `src/core/matchers/contains-matcher.js` (ES Module):
   - Export matchContains(text, phrase) checking normalized substring inclusion.
```

---

### Phase 3: Trigger Rules, Semantic Matching & Reply Prompt Builder

#### Objective
Implement CRUD operations for triggers, semantic intent classification via local LLM, reply prompt construction, and fixed-reply resolution.

#### Files to Create
- `src/core/trigger-schema.js`
- `src/core/trigger-crud.js`
- `src/core/semantic-matcher.js`
- `src/core/prompt-builder.js`
- `src/core/fixed-reply.js`

#### Technical Requirements
1. `src/core/trigger-schema.js` & `trigger-crud.js`:
   - Trigger shape: `{ id, name, phrases: string[], prompt: string, enabled: boolean, matchMode: 'semantic'|'contains'|'exact', replyMode: 'llm'|'fixed', fixedReplyText: string }`.
   - CRUD functions: `createTrigger`, `getTriggers`, `updateTrigger`, `deleteTrigger`, `validateTrigger`.
2. `src/core/semantic-matcher.js`:
   - `semanticMatchTriggers({ commentText, triggers, client, model })`:
     - Builds a concise classification prompt presenting the comment and the list of active triggers with their intent phrases.
     - Asks the model to return strict JSON: `{"matched": boolean, "triggerId": string|null, "confidence": number}`.
     - Uses `getReasoningBudget('SEMANTIC_MATCH')` for `maxTokens`.
     - Parses the JSON response; if `matched === true` and `triggerId` is valid, returns the matched trigger.
3. `src/core/prompt-builder.js`:
   - Builds chat messages `[{ role: "system", content }, { role: "user", content }]`.
   - Injects response style rules: `'friendly'` (polite, warm), `'professional'` (concise, formal), or `'short'` (single sentence).
   - Injects `staticContext` and active `contextTemplate` (if configured).
   - Forbids mentioning being an AI, fabricating prices, and using markdown headers/bullets.
4. `src/core/fixed-reply.js`:
   - `resolveReplySource({ trigger, isFixed })`: If trigger has `replyMode === 'fixed'` and `fixedReplyText` is set, bypasses LLM generation and returns the exact fixed reply text byte-identically (no trimming/folding).

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 3 for the YouTube Auto Reply Chrome extension:

Create the trigger and prompt generation modules:
1. `src/core/trigger-schema.js` & `src/core/trigger-crud.js` (ES Modules):
   - Define trigger schema: id, name, phrases (array), prompt, enabled, matchMode ('semantic'|'contains'|'exact'), replyMode ('llm'|'fixed'), fixedReplyText.
   - Implement storage-backed CRUD: getTriggers(), addTrigger(), updateTrigger(), removeTrigger().
2. `src/core/semantic-matcher.js` (ES Module):
   - Export semanticMatchTriggers({ comment, triggers, chatCompletionFn, model }).
   - Formulates a system prompt asking the model to classify if the comment matches any trigger intent, returning JSON: {"matched": true/false, "triggerId": "...", "confidence": 0-1}. Use reasoning token budget.
3. `src/core/prompt-builder.js` (ES Module):
   - Export buildReplyPrompt({ comment, systemPrompt, style, staticContext, triggerPrompt }). Formats system & user messages cleanly without markdown bullets.
4. `src/core/fixed-reply.js` (ES Module):
   - Export resolveReplySource(trigger) which returns { isFixed: true, text: trigger.fixedReplyText } if configured, bypassing LLM generation while maintaining exact byte equality.
```

---

### Phase 4: Safety Layer, Rate Limiting & Reply Validation

#### Objective
Enforce strict channel safety: sliding 1-hour rate limiting, anti-repetition deduplication, reply content validation, and handled-comment persistence.

#### Files to Create
- `src/core/reply-rate-limiter.js`
- `src/core/reply-validator.js`
- `src/core/comment-fingerprint.js`
- `src/core/reply-deduplicator.js`
- `src/core/handled-comments.js`
- `src/core/page-session.js`

#### Technical Requirements
1. `src/core/reply-rate-limiter.js`:
   - Tracks timestamps in `chrome.storage.local` under `recentReplyTimestamps`.
   - `isLimitReached(maxRepliesPerHour)`: Prunes timestamps older than 60 minutes and checks if `count >= maxRepliesPerHour`.
   - `recordReply()`: Adds `Date.now()` to the list.
2. `src/core/reply-validator.js`:
   - `validateReply(replyText, blacklist, options)`:
     - Minimum length (>= 5 chars) and maximum length (<= 500 chars).
     - Checks for blacklist terms (case/Arabic insensitive): "as an ai", "ذكاء اصطناعي", "نموذج لغوي", "بوت", etc.
     - Rejects leaked reasoning tokens (`<think>` tags).
     - Rejects unreplaced bracket placeholders (e.g., `[رابط]`, `[سعر]`).
     - Returns `{ valid: boolean, reason?: string, sanitizedText?: string }`.
3. `src/core/comment-fingerprint.js` & `reply-deduplicator.js`:
   - `createFingerprint(platform, videoUrl, commentId)`: Generates deterministic string key `fp:${platform}|${videoUrl}|${commentId}`.
   - `createReplyDeduplicator()`: In-memory LRU/Set preventing identical or near-identical replies to distinct comments.
4. `src/core/handled-comments.js`:
   - Stores handled fingerprints in `chrome.storage.local` under `handledComments`.
   - **Critical Rule:** A comment is ONLY marked handled after confirmed publishing (or after successful draft placement in Dry Run). Never mark handled prematurely!
5. `src/core/page-session.js`:
   - Resolves `sender.documentId` to scope in-memory deduplication per page load, ensuring page reloads permit re-evaluation of unposted comments.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 4 for the YouTube Auto Reply Chrome extension:

Create the safety and validation modules:
1. `src/core/reply-rate-limiter.js`: Sliding 1-hour window rate limiter using chrome.storage.local key 'recentReplyTimestamps'. Export isLimitReached(maxPerHour) and recordReply().
2. `src/core/reply-validator.js`: Export validateReply(text, blacklist, { allowRepeat }). Validates min/max length (5-500), rejects blacklist terms (e.g. 'as an ai', 'ذكاء اصطناعي'), strips thinking tags (<think>...</think>), rejects code blocks and unfilled placeholders [bracketed].
3. `src/core/comment-fingerprint.js`: Export createFingerprint(platform, url, commentId).
4. `src/core/reply-deduplicator.js`: Export createReplyDeduplicator() with isDuplicate(text) and remember(text) checking recent replies.
5. `src/core/handled-comments.js`: Export isHandled(fingerprint) and markHandled(fingerprint).
6. `src/core/page-session.js`: Export resolvePageSessionId(sender) extracting sender.documentId.
```

---

### Phase 5: Queue Management, Inter-comment Delays & Persistence

#### Objective
Implement an asynchronous FIFO queue with human-like delays, pause/resume controls, and service worker restart survival.

#### Files to Create
- `src/core/queue.js`
- `src/core/queue-control.js`
- `src/core/queue-persistence.js`
- `src/core/processing-stats.js`

#### Technical Requirements
1. `src/core/queue.js`:
   - Maintains an in-memory job array.
   - `enqueue(job)`: Adds job and triggers `processNext()`.
   - Inter-comment random delay: Between jobs, waits `Math.floor(Math.random() * (maxDelay - minDelay) + minDelay)` (e.g., 8,000ms to 20,000ms).
   - Respects pause state and hourly rate limits.
2. `src/core/queue-control.js` & `queue-persistence.js`:
   - `isQueuePaused()` / `setQueuePaused(boolean)` stored in `chrome.storage.local` under `queuePaused`.
   - `savePendingQueue(jobs)` / `restorePendingQueue()`: Persists unprocessed jobs to `pendingJobs` in storage so queue state survives service worker sleep.
3. `src/core/processing-stats.js`:
   - In-memory/storage counters: `detectedCount`, `matchedCount`, `generatedCount`, `submittedCount`, `failedCount`, `skippedCount`.
   - Export methods: `increment(statKey)`, `getStats()`, `resetStats()`.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 5 for the YouTube Auto Reply Chrome extension:

Create the queue and job processing modules:
1. `src/core/queue.js`: Export Queue class managing async job execution. Implements FIFO processing, random delay generator (minDelayMs to maxDelayMs), error isolation (one failed job does not stop the queue), and hooks for rate limiting.
2. `src/core/queue-control.js`: Export isQueuePaused() and setQueuePaused(bool) backed by chrome.storage.local.
3. `src/core/queue-persistence.js`: Export savePendingQueue(jobs) and restorePendingQueue() using storage key 'pendingJobs'.
4. `src/core/processing-stats.js`: Export processing stats manager tracking detected, matched, generated, submitted, failed, and skipped counters.
```

---

### Phase 6: YouTube Content Script & DOM Adapter

#### Objective
Build the DOM observer and YouTube adapter that detects rendered comments, verifies creator heart/reply status, and simulates human input for drafting or submitting replies.

#### Files to Create
- `src/content/debug-global.js`
- `src/content/youtube-adapter.js`
- `src/content/content.js`

#### Technical Requirements
1. **Rule:** Files in `src/content/` MUST be **Classic Scripts** (NO `import` or `export`).
2. `src/content/debug-global.js`:
   - Installs `window.__YTAR_DEBUG = { log, warn, error }` with `[YouTube Auto Reply]` prefix.
3. `src/content/youtube-adapter.js`:
   - Targets YouTube DOM selectors:
     - Thread container: `ytd-comment-thread-renderer`.
     - Comment view model: `ytd-comment-view-model`.
     - Author badge: `#author-comment-badge` (identifies channel owner).
     - Heart indicator: inside `ytd-creator-heart-renderer`.
   - `isOwnComment(commentEl)`: Returns `true` if comment has author badge or owner channel link.
   - `isHeartedComment(commentEl)`:
     - **CRITICAL PITFALL:** In the channel owner's logged-in session, `ytd-creator-heart-renderer` is ALWAYS present on every comment!
     - **CORRECT CHECK:** Check for presence of `#hearted` or `#hearted-thumbnail` AND ensure `#unhearted` is NOT visible.
   - `hasCreatorReply(threadEl)`: Scans child comments in the thread for `#author-comment-badge`.
   - `openReplyBox(commentEl)`: Clicks reply button (`#reply-button-end yt-button-shape button`) and awaits `#contenteditable-root`.
   - `insertDraftReply(commentEl, replyText)`:
     - Sets `#contenteditable-root.textContent = replyText`.
     - Dispatches `new InputEvent('input', { bubbles: true })` and `change` events.
   - `submitReply(commentEl)`: Clicks `#submit-button button` and verifies submission.
4. `src/content/content.js`:
   - Sets up `MutationObserver` on `ytd-comments`.
   - Debounces DOM mutations, extracts newly rendered comments, filters out own comments, hearted comments, and already-seen IDs.
   - Sends `{ action: "COMMENT_DETECTED", comment: { id, author, text, videoUrl } }` via `chrome.runtime.sendMessage`.
   - Listens for `{ action: "WRITE_REPLY", commentId, replyText, dryRun }` to execute draft/submit.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 6 for the YouTube Auto Reply Chrome extension:

Create the YouTube Content Scripts as Classic Scripts (NO import/export syntax!):
1. `src/content/debug-global.js`:
   - Attach window.__YTAR_DEBUG logger with standard methods [YouTube Auto Reply].
2. `src/content/youtube-adapter.js`:
   - Implement DOM adapter object:
     - extractCommentData(element): extracts id, author, text, timestamp.
     - isOwnComment(element): detects channel owner's own comments.
     - isHeartedComment(element): detects if creator hearted this comment. IMPORTANT: Do NOT merely check container ytd-creator-heart-renderer; verify inner element #hearted / #hearted-thumbnail exists.
     - hasCreatorReply(threadElement): detects if creator already replied in this thread.
     - insertReplyText(element, text): focuses #contenteditable-root, sets textContent, dispatches InputEvent.
     - clickSubmit(element): finds and clicks #submit-button.
3. `src/content/content.js`:
   - MutationObserver watching ytd-item-section-renderer #contents for new comments.
   - Filters out own/hearted/duplicate comments and sends COMMENT_DETECTED to background worker.
   - Implements chrome.runtime.onMessage listener for WRITE_REPLY action (handles Dry Run by leaving draft in box, or clicks submit in live mode).
```

---

### Phase 7: Grounded Local Knowledge Base (RAG Pipeline)

#### Objective
Build an offline, zero-hallucination Retrieval-Augmented Generation (RAG) pipeline for user-provided Markdown knowledge files.

#### Files to Create
- `src/core/knowledge-schema.js`
- `src/core/markdown-parser.js`
- `src/core/knowledge-store.js`
- `src/core/knowledge-index.js`
- `src/core/intent-analyzer.js`
- `src/core/knowledge-retrieval.js`
- `src/core/answerability-gate.js`
- `src/core/grounded-prompt-builder.js`
- `src/core/evidence-aware-output.js`
- `src/core/grounding-validator.js`
- `src/core/hallucination-rejection.js`
- `src/core/knowledge-conflicts.js`
- `src/core/reply-modes.js`
- `src/core/reply-router.js`

#### Technical Requirements
1. `markdown-parser.js`:
   - Parses `.md` files into hierarchical sections based on `#`, `##`, `###`.
   - Tracks heading path (e.g. `Courses > Web Development > Pricing`), body text, and extracted numbers/prices.
2. `knowledge-index.js` & `knowledge-store.js`:
   - In-memory BM25 / token index with a **Freshness Gate** (index status must be `FRESH` matching document hash before allowing retrieval).
3. `intent-analyzer.js` & `knowledge-retrieval.js`:
   - `analyzeIntent()`: Uses LLM to extract intent and entities (e.g., product, price question, date).
   - `retrieveKnowledge()`: Two-stage retrieval: (1) lexical BM25 keyword candidates, (2) LLM rerank to select top-k sections.
4. `answerability-gate.js`:
   - Prompts the LLM with the comment and retrieved sections: *"Are these sections 100% SUFFICIENT to answer the question without guessing?"*
   - Returns boolean `canAnswer`. If `false`, immediately skips the comment.
5. `grounded-prompt-builder.js` & `evidence-aware-output.js`:
   - Constructs reply prompt containing ONLY the verified evidence sections.
   - Instructs model to output structured response with citations.
6. `grounding-validator.js` & `hallucination-rejection.js`:
   - Extracts numbers, prices, dates, currencies from generated reply.
   - Verifies each number/fact exists verbatim in the retrieved evidence sections.
   - **Bounded Regeneration:** If validation fails, permits exactly 1 regeneration attempt with an explicit critique. If the second attempt still fails, drops the reply and logs a safe skip.
7. `reply-router.js`:
   - Implements mode routing:
     - `'trigger'`: Evaluates triggers only.
     - `'knowledge'`: Runs RAG pipeline only.
     - `'hybrid'`: Evaluates triggers first; falls back to RAG if no trigger matched.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 7 for the YouTube Auto Reply Chrome extension:

Create the Grounded Local Knowledge Base (RAG) modules (ES Modules):
1. `src/core/knowledge-schema.js`: Schema for documents, sections, and index state.
2. `src/core/markdown-parser.js`: Parses markdown documents into sections split by headings (#, ##, ###), keeping full heading breadcrumbs and extracting numeric tokens.
3. `src/core/knowledge-store.js` & `src/core/knowledge-index.js`: In-memory BM25 token index with Freshness Gate (refuses retrieval if stale).
4. `src/core/intent-analyzer.js`: Extracts intent and search terms from comment using LLM.
5. `src/core/knowledge-retrieval.js`: Two-stage retrieval (BM25 candidates + LLM reranking).
6. `src/core/answerability-gate.js`: Asks LLM if retrieved sections are sufficient to answer. If insufficient, returns canAnswer: false to skip.
7. `src/core/grounded-prompt-builder.js`: Injects only retrieved evidence into generation prompt.
8. `src/core/grounding-validator.js`: Extracts numbers/prices/dates from generated reply and verifies they exist in retrieved evidence.
9. `src/core/hallucination-rejection.js`: Handles bounded regeneration (max 2 attempts). If facts remain unverified, rejects reply cleanly.
10. `src/core/knowledge-conflicts.js`: Resolves contradictions (precedence to specific/newer docs).
11. `src/core/reply-modes.js` & `src/core/reply-router.js`: Routes comments based on replyMode ('trigger' | 'knowledge' | 'hybrid').
```

---

### Phase 8: File System Folder Sync & Document Splitter

#### Objective
Sync a local folder of `.md` files directly via the File System Access API and provide a safe document splitter that structures raw notes into markdown trees without overwriting files.

#### Files to Create
- `src/core/folder-handle-store.js`
- `src/core/knowledge-folder-sync.js`
- `src/core/doc-splitter.js`

#### Technical Requirements
1. `folder-handle-store.js`:
   - Uses IndexedDB to store and retrieve `FileSystemDirectoryHandle`.
   - Exports `saveFolderHandle(handle)`, `loadFolderHandle()`, `clearFolderHandle()`.
2. `knowledge-folder-sync.js`:
   - Scans directory handle recursively for `.md` and `.markdown` files.
   - Computes checksums/hashes, detects additions/modifications/deletions, and updates `knowledge-store`.
3. `doc-splitter.js`:
   - Splits a large text or document into clean markdown files using 2 bounded LLM calls:
     - Call 1: Generate file outline and headings.
     - Call 2: Generate section bodies.
   - **Safety Invariant:** A collision NEVER overwrites existing user files (appends `-2.md`).
   - Requires user review before write (`SPLIT_SOURCE_DOCUMENT` returns preview; `WRITE_GENERATED_DOCUMENTS` writes files).

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 8 for the YouTube Auto Reply Chrome extension:

Create the folder synchronization and document splitting modules:
1. `src/core/folder-handle-store.js`: Stores FileSystemDirectoryHandle in IndexedDB.
2. `src/core/knowledge-folder-sync.js`: Iterates directory entries, filters .md files, calculates hash diffs, and syncs with knowledge store.
3. `src/core/doc-splitter.js`: Splits raw text into structured markdown files via two-stage LLM generation (outline first, then individual file contents). Ensures files are never overwritten (resolves collisions with -2 suffix) and requires explicit review before disk writes.
```

---

### Phase 9: Answered Follow-ups & Target Comment Hearting

#### Objective
Detect viewer follow-ups on threads where the creator previously replied (providing advisory drafts for manual review) and optionally auto-heart comments upon replying.

#### Files to Create
- `src/core/answered-followups.js`
- `src/core/answered-followup-store.js`
- `src/core/target-reply-hearting.js`

#### Technical Requirements
1. `answered-followups.js` & `answered-followup-store.js`:
   - **Advisory Only:** This feature NEVER auto-publishes.
   - Checks if a thread contains an owner reply AND a subsequent viewer question.
   - Prompts the LLM with the original question and the owner's answer, asking if a follow-up answer is needed, and prepares a draft.
   - Saves drafts in `chrome.storage.local` board (bounded to 50 items) for the creator to copy/edit in the Side Panel.
2. `target-reply-hearting.js`:
   - Controlled by `targetReplyHeartingEnabled` (defaults `false`).
   - If enabled and replying to a comment, clicks the heart icon on that comment.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 9 for the YouTube Auto Reply Chrome extension:

Create the follow-up and interaction modules:
1. `src/core/answered-followups.js`:
   - Analyzes threads where owner previously replied.
   - Prompt separates viewer's new question from creator's previous answer. Generates draft without auto-submitting.
2. `src/core/answered-followup-store.js`:
   - Stores up to 50 follow-up draft recommendations in storage for the Side Panel notice board.
3. `src/core/target-reply-hearting.js`:
   - Evaluates targetReplyHeartingEnabled setting (default false) to trigger hearting upon replying.
```

---

### Phase 10: Chrome Side Panel & Options Dashboard UI

#### Objective
Build the persistent Chrome Side Panel for real-time monitoring and controls, along with the full Options settings dashboard.

#### Files to Create
- `src/popup/popup.html`, `popup.css`, `popup.js`
- `src/options/options.html`, `options.css`, `options.js`

#### Technical Requirements
1. Side Panel (`src/popup/`):
   - Opens permanently beside YouTube tabs.
   - Displays real-time status: LM Studio connection indicator, active model, and engine state (Running/Paused).
   - Displays live counters: Detected, Matched, Generated, Submitted, Skipped.
   - Quick action buttons: Pause/Resume Queue, Toggle Dry Run, Open Settings.
   - Answered Follow-ups board: Lists threads needing creator follow-up with a "Copy Draft" button.
2. Options Page (`src/options/`):
   - **Model Settings:** URL, API Key, Model selector dropdown (fetched live via `getModels()`), Test Connection button.
   - **Triggers Management:** Add/Edit/Delete triggers, match mode selector, fixed reply configuration.
   - **Knowledge Base Tab:** "Choose folder..." button triggering `showDirectoryPicker()`, "Sync now" button, list of indexed documents, and Doc Splitter tool.
   - **Safety & Limits Tab:** Hourly cap, delay range sliders, blacklist editor, ignoreHeartedComments toggle, diagnostic logging toggle.

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 10 for the YouTube Auto Reply Chrome extension:

Build the UI components (Vanilla JS, HTML, CSS):
1. `src/popup/popup.html`, `popup.css`, `popup.js` (Side Panel):
   - Persistent UI matching YouTube theme.
   - Real-time status cards (LM Studio connection, queue state, counters).
   - Control buttons (Pause/Resume, Dry Run toggle, link to full options).
   - Follow-up recommendations section with one-click copy.
2. `src/options/options.html`, `options.css`, `options.js` (Options Dashboard):
   - Tabbed layout: (1) LM Studio Connection & Model selector, (2) Triggers CRUD, (3) Knowledge Base & Folder Sync, (4) Safety Limits & Blacklist.
   - Folder selector using window.showDirectoryPicker() saving handle to IndexedDB.
```

---

### Phase 11: Master Service Worker Integration & Verification

#### Objective
Wire all modules into the central Service Worker event loop, register runtime messaging, configure top-level side panel behavior, and verify with automated checks.

#### Files to Create or Finalize
- `src/background/service-worker.js`
- `scripts/verify-extension.mjs`

#### Technical Requirements
1. `src/background/service-worker.js`:
   - **Top-Level Side Panel Init:**
     ```javascript
     chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
     ```
     Must be called at top level (NOT inside `onInstalled`), ensuring toolbar clicks open the side panel even after worker idle shutdowns.
   - **Central Message Handler:**
     ```javascript
     chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
       handleAction(message, sender).then(sendResponse);
       return true; // Keep message channel open for async response
     });
     ```
   - Wire actions: `COMMENT_DETECTED`, `TEST_CONNECTION`, `GET_LM_STUDIO_MODELS`, `SYNC_KNOWLEDGE_FOLDER`, `SPLIT_SOURCE_DOCUMENT`, `GET_PROCESSING_STATS`, etc.
   - Process detected comments through: Fingerprint → Reply Router (Trigger vs Knowledge vs Hybrid) → Rate Limit Check → Generation / Fixed Reply → Validation → Queue with Delay → Content Script Post Handoff → Mark Handled upon confirmation.
2. `scripts/verify-extension.mjs`:
   - Node.js script asserting all 69 architectural invariants (no npm deps, manifest V3 compliance, loopback host permissions, no `default_popup`, no `import/export` in content scripts, reasoning budget ceiling).

#### 🤖 Copy-Paste Prompt for Local Model:
```text
Execute Phase 11 for the YouTube Auto Reply Chrome extension:

1. `src/background/service-worker.js`:
   - Wire all core modules: api-client, storage, queue, reply-router, semantic-matcher, fixed-reply, knowledge-index, safety validators.
   - At TOP LEVEL, execute: chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).
   - Implement single runtime.onMessage listener returning true for async dispatch.
   - Complete comment pipeline: receive comment -> deduplicate -> route -> generate/validate -> delay queue -> content script handoff -> mark handled.
2. `scripts/verify-extension.mjs`:
   - Node.js verification script checking manifest V3 invariants, file existence, lack of ES syntax in content scripts, and configuration integrity.
```

---

## 5. Critical Pitfalls & Hard-Learned Lessons

Keep these 5 hard-learned rules in mind whenever reviewing code generated by your local model:

1. **Creator Heart Detection Container Trap:**  
   Never test `commentEl.querySelector('ytd-creator-heart-renderer') !== null`. In the channel owner's browser, that element is rendered for EVERY comment. Always inspect the internal state: `#hearted` / `#hearted-thumbnail` must be present and `#unhearted` must not be visible.
2. **Reasoning Model Token Budgeting:**  
   Never assign small token limits (`max_tokens: 64`) to JSON classification or verification tasks. Reasoning models spend tokens thinking first. Use `STRUCTURED_REASONING_BUDGET = 1024` so responses are not cut off.
3. **Premature Handled Marking:**  
   Never call `markHandled()` upon reply generation. Only record a comment as handled after the content script confirms successful submission (or draft placement in Dry Run).
4. **Side Panel Action Button Deadlock:**  
   If `action.default_popup` is present in `manifest.json`, the extension will open a temporary popup and the Side Panel will fail to stay open. Keep `action.default_popup` absent and call `setPanelBehavior({ openPanelOnActionClick: true })` at the top level of the service worker.
5. **Content Script Module Boundaries:**  
   Chrome does not support `type: "module"` in `content_scripts`. Never let the local model place `import` or `export` in any file under `src/content/`.
