# Security / Privacy Review — Phase 17

Scope: every task in PHASE 17 of `plan.md`, checked against the code as it stands.
Each entry states what was checked, what was found, and what changed.

The product promise is narrow: comment text goes to a **local** LM Studio server and
nowhere else. Everything below exists to keep that promise auditable.

---

## Task 17.1 — Review Permissions

`activeTab` and `scripting` were both listed in the manifest and **never used**:

| Permission | Used? | Evidence |
|---|---|---|
| `storage` | yes | `chrome.storage.local` — 29 call sites across settings, triggers, logs, handled comments, rate limiter, queue pause, diagnostics |
| `activeTab` | no | no reference anywhere in `src/` |
| `scripting` | no | no `chrome.scripting.*` call; content scripts are declared statically in `manifest.json` |

`chrome.tabs.create` is used to open the Options page. That API does **not** require
a permission — the `tabs` permission only gates reading tab URLs and titles, and it is
not requested.

**Changed:** the manifest now requests `storage` only. Removing `activeTab` and
`scripting` means Chrome no longer grants this extension transient access to the
active tab, which is a real reduction in blast radius even though the code never used
it.

---

## Task 17.2 — Review Stored Data

Everything the extension writes lives in `chrome.storage.local`, under these keys:

| Key | Written by | Contents | Contains user data? |
|---|---|---|---|
| settings keys (`enabled`, `dryRun`, `lmStudio`, `triggers`, `replyBehavior`) | `core/storage.js` | user configuration | phrases the user typed |
| `triggers` | `core/trigger-crud.js` | trigger rules | phrases the user typed |
| `activityLogs` | `core/activity-log.js` | last 200 reply events | **comment text** |
| `handledComments` | `core/handled-comments.js` | fingerprints of answered comments | hashed, not raw |
| `recentReplyTimestamps` | `core/reply-rate-limiter.js` | reply timestamps | no |
| `queuePaused` | `core/queue-control.js` | boolean | no |
| `debugMode` | `core/debug.js` | boolean | no |
| `pendingJobs` (Phase 19.3) | `core/queue-persistence.js` | queued comment id + text + fingerprint | **comment text** |
| `knowledgeDocuments` (Phase 20.2) | `core/knowledge-store.js` | the user's Markdown knowledge files | **commercial content (prices, policies)** |
| `knowledgeIndexMeta` (Phase 20.1) | `core/knowledge-store.js` | index fingerprint, state, counts, build time | no |

Explicitly **not** stored anywhere:

- No cookies (`document.cookie` is never read; no `chrome.cookies` permission).
- No session tokens, OAuth material, or passwords — the extension has no sign-in flow.
- No `lmStudio.apiKey` credential of any consequence: the default is the literal
  placeholder `lm-studio`, which is what LM Studio's OpenAI-compatible endpoint expects
  and is not a secret. If a user replaces it, it is a local-server token held only in
  their own profile and sent only to their own loopback server.
- No browsing history. The only URLs retained are the page URL captured at
  `COMMENT_DETECTED` time for the activity log's `site` field.

**Privacy notes that are true but worth stating plainly:**

1. `activityLogs` keeps **raw comment text** (up to 200 entries). This is the price of
   a readable log, and the popup's "Last reply written" panel reads from it. A user who
   does not want their comment history retained can clear it; `CLEAR_LOGS` is already
   exposed to the background as a message action.
2. Everything above is local to the user's Chrome profile. Unsynced, never uploaded.
3. `knowledgeDocuments` holds the user's own commercial content — price lists, shipping
   terms, policies — which is the most sensitive data this extension stores. It is capped
   at 50 documents / 1,000,000 characters, it is never written to any settings key, and it
   leaves the profile only as the retrieved sections a reply is grounded in (§36). Note
   that nothing yet retrieves: the knowledge pipeline is read-only infrastructure until
   the retrieval milestone lands, so there is currently no code path that sends it anywhere.

**Changed:** nothing had to be removed. Findings are documented instead, plus two
additions — Phase 19.3 introduced `pendingJobs`, which persists comment text across a
service-worker restart, and Phase 20.2 introduced `knowledgeDocuments`, which persists the
user's commercial content. Both are called out explicitly here rather than shipping
unremarked.

---

## Task 17.3 — Review API Data Flow

The whole network surface of the extension is two `fetch` calls, both in
`background/api-client.js`:

- `getModels()` → `${settings.lmStudio.baseUrl}/models`
- `chatCompletion()` → `${settings.lmStudio.baseUrl}/chat/completions`

Both resolve their host from **user settings at call time**. Verified:

- No hard-coded remote endpoint anywhere.
- No analytics, telemetry, crash reporting, or remote-config fetch.
- No `navigator.sendBeacon`, no `WebSocket`, no `XMLHttpRequest`, no image beacon.
- No `<script src>`, `<link href>`, or `@import` pointing at a CDN. The Phase 16/18 UI
  work removed the Google Fonts links, so the extension now loads **zero third-party
  assets** and works fully offline.
- The only external hosts referenced anywhere are the three YouTube origins in
  `content_scripts.matches`, which is what the content script needs to exist at all.

**Conclusion:** comment → LM Studio is local, and no unintended cloud service is
contacted.

---

## Task 17.4 — Review Host Permissions

Host permissions must cover the LM Studio server and nothing else.

**Before:** `http://localhost:1234/*`

That was not actually sufficient. LM Studio's documentation and most users' own
configuration use `http://127.0.0.1:1234/v1`, and `localhost` and `127.0.0.1` are
distinct origins for host-permission matching. A user who pasted the loopback IP got a
blocked fetch with no useful explanation.

**After:**

```json
"host_permissions": [
  "http://localhost:1234/*",
  "http://127.0.0.1:1234/*"
]
```

Still minimal, and the reasoning is deliberate:

- **Loopback only.** No `http://*` and no `https://*` — the extension cannot reach a
  remote host even if a user typed one into Base URL.
- **HTTP only.** LM Studio is a local server with no TLS; there is nothing to match
  over `https`.
- **Port-scoped to 1234**, LM Studio's default port.
- A user who runs LM Studio on a different port must edit the manifest themselves.
  That is the correct trade-off: silently widening this to every port would grant the
  extension reach into unrelated local services, which is exactly the risk Task 17.4
  asks to avoid.

**Consequence to be aware of:** if a user enters a Base URL outside these two
origins, the request is blocked by Chrome. The Options page already surfaces this as a
`model-error` telling the user to check that the Base URL is "permitted in the
extension's host permissions", so the failure mode is explained rather than silent.

---

## Summary of changes made in Phase 17

| File | Change |
|---|---|
| `src/manifest.json` | dropped unused `activeTab` and `scripting`; added the `127.0.0.1:1234` loopback origin |
| `docs/SECURITY_REVIEW.md` | this document |

No functional change was made to matching, prompting, queueing, reply generation, or
reply insertion.