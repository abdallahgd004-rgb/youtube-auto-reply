# AGENTS.md

## What this is

Chrome MV3 extension that auto-replies to YouTube comments using a local LM Studio
(OpenAI-compatible) server. No build step, no bundler, no `package.json`, no npm
dependencies — plain ES modules loaded directly by Chrome.

## Load / verify

- "Load unpacked" target is **`src/`** (not the repo root) — `src/manifest.json` is the manifest.
- After any manifest or service-worker change: go to `chrome://extensions/` and hit
  Reload on the extension, then open DevTools on the service worker to read logs.
- Service worker logs are the primary debug channel; every module prefixes with
  `[YouTube Auto Reply]`.
- Matcher tests: open `src/core/matchers/tests/test-runner.html` in a browser. It runs on
  page load via ES module imports — there is no Node test runner.

## Architecture that isn't obvious from filenames

- `src/core/` is platform-agnostic. `src/background/api-client.js` is the only module that
  talks to LM Studio, and it lives in `background/`, not `core/`.
- The service worker is `"type": "module"`, so it may use `import`.
- **`src/content/content.js` is NOT a module** — `content_scripts` in the manifest has no
  `type: "module"`. Do not add `import`/`export` there. Shared code must be injected or
  duplicated into the content script.
- All cross-context communication goes through one listener in
  `src/background/service-worker.js` using `message.action` string constants
  (`openOptions`, `GET_LM_STUDIO_MODELS`, `TEST_CONNECTION`, ...). Async handlers **must
  `return true`** or `sendResponse` is dropped. Add new actions there, not new listeners.
- Popup/options open as full tabs via `chrome.tabs.create` (they are also declared as
  `default_popup` / `options_page`).
- Settings are always read through `getSettings()` in `src/core/storage.js`, which deep-merges
  `chrome.storage.local` over `DEFAULT_CONFIG` in `src/core/config.js`. New settings keys must
  be added to `DEFAULT_CONFIG` *and* to the explicit key list in `getSettings()` — a key missing
  from that list is never loaded.
- `getSettings()` returns a fresh deep copy; never mutate the object you get back.

## Trigger rules

- Shape is documented in `src/core/trigger-schema.js` (`id`, `enabled`, `phrases`,
  `matchMode`, `caseSensitive`); CRUD helpers live in `src/core/trigger-crud.js`.
- **Matchers (`src/core/matchers/*`) are unaware of the `enabled` field.** Filtering disabled
  rules is the caller's job (service worker / content script). Don't add a test that assumes
  matchers skip disabled rules — that test was deliberately removed and a comment in
  `test-runner.js` explains why.
- `arabic-normalizer.js` (`normalizeArabic`) is standalone and is **not yet wired into the
  matchers**; `contains-matcher.js` only lowercases. Integration is still pending work.
- `match()` returns the original (non-lowercased) phrase in `matchedPhrase`, and the first
  matching phrase in the array wins.

## LM Studio specifics

- Default endpoint `http://localhost:1234/v1`, apiKey `lm-studio`, `model` empty by default.
- If you change the port or path in `DEFAULT_CONFIG`, update `host_permissions` in
  `src/manifest.json` (`http://localhost:1234/*`) or fetches will be blocked.
- All requests use a 30s `AbortController` timeout and throw on `AbortError` with a converted
  message — errors are re-thrown, not swallowed.
- The model must be loaded in LM Studio before `TEST_CONNECTION` succeeds.

## Conventions

- Work follows `plan.md` (phases/tasks, partly in Arabic). Implement **one task at a time**,
  verify it, then move on; no drive-by refactors of untouched files. File headers track the
  phase: `// Phase 4.2 - Contains Matcher`. Update it when you move a file forward.
- Scope and hard constraints live in `docs/PROJECT_DECISIONS.md`: YouTube-only MVP, core logic
  must stay platform-agnostic, and **no CAPTCHA / anti-bot bypass** work is in scope.
- `README.md` tracks "what works" per phase — keep it in sync when a phase completes.
- Manifest is at version `1.0.0` and the version is bumped manually, not from a script.