# Retyc Thunderbird Plugin — Notes for Claude

## Language policy

**All code, comments, commit messages, log strings, user-facing text, and
documentation in this repo MUST be in English.** No French anywhere in
the codebase, even in comments. The owner is French but distributes this
plugin internationally.

## What it does

Thunderbird MailExtension that intercepts emails with attachments and
uploads them to Retyc (E2E encrypted file transfer). Attachments are
removed from the message and a download link is injected into the body.

Recipients with a Retyc account get end-to-end encryption via their public
key. For recipients without an account, a passphrase (≥ 8 chars) is
required at upload time.

## Architecture

- **Background script** (`src/background/index.ts`) is the single source of
  truth. UI pages talk to it via `browser.runtime.sendMessage`.
- **Dialog** (`src/dialog/`) opens as a popup window during the
  intercept-and-upload flow.
- **Popup** (`src/popup/`): toolbar button — auth status, login/logout,
  token refresh, user info.
- **Compose-popup** (`src/compose-popup/`): button inside the compose
  window — shows status, exposes the per-message kill switch
  (`retyc_enabled`), and shortcut to settings.
- **Options** (`src/options/`): settings page (API URL, app URL, expiry,
  auto-send).

## The send-interception flow

```
User clicks Send
  → onBeforeSend fires
       → kill switch off (retyc_enabled = false) → return (send normally)
       → has attachments + authenticated + ≥1 recipient?
            → proactive token refresh if access token < 60s of life
            → cancel send + open dialog popup
                 → user confirms
                      → upload to Retyc (sequential reads, abortable)
                      → SDK fires onProgress per chunk → broadcast
                        UPLOAD_PROGRESS{phase:'uploading', uploadedBytes, totalBytes, ratio}
                      → remove attachments
                      → append link to body (URL validated against app origin)
                      → bypassTabs.add(tabId)
                          - 5s window in auto-send mode
                          - 60s window in manual 2-step mode
                      → compose.sendMessage(tabId, {mode: 'sendNow'}) if autoSend
                                ↓
                      → onBeforeSend fires again → bypass → real send
```

## Critical gotchas

### Thunderbird API quirks
- `browser.compose.getAttachmentFile(id)` takes ONLY the attachment id, no
  tabId. Don't trust some older docs.
- `compose.sendMessage` requires the **`compose.send`** permission
  separately from `compose`. Without it, you get
  `TypeError: browser.compose.sendMessage is not a function`.
- `windows.create` does NOT support `focused: true` in Thunderbird (Firefox
  only).
- `ComposeAttachment.id` is a `number`, not a string.
- `compose_scripts` are sandboxed and cannot access Thunderbird's chrome
  globals (`goDoCommand`, etc.).

### SDK quirks
- `sdk.transfers.upload()` is the upload entry point (not `shares`).
- `expires` is in **seconds** (multiply days by 86400).

### onBeforeSend bypass mechanism
- After uploading, we call `compose.sendMessage` which re-fires
  `onBeforeSend`. The `bypassTabs: Set<number>` lets that one through.
- The bypass auto-clears after 5s in auto-send mode and 60s in manual
  2-step mode (the user may take a moment to click Send themselves).
- Concurrent send protection: if `pendingUploads.has(tabId)` when
  `onBeforeSend` fires, we cancel the duplicate rather than overwriting
  the in-flight `AbortController`.

### Token refresh strategy
- `isTokenNearExpiry` checks `expiresAt - 60 < now`. When true,
  `onBeforeSend` calls `sdk.auth.refresh()` proactively before opening the
  dialog. Avoids the "expired mid-upload" failure mode.

### Transfer URL safety
- `buildTransferUrl` constructs the link via `new URL(path, base)` and
  refuses any result whose protocol/host differs from the configured app
  URL — defence in depth against a malicious slug from a compromised API.
- `escapeHtml` covers `& < > " '` (single-quote included for HTML attrs).

## Commands

```bash
npm run build:dev    # webpack dev build (with cheap-module-source-map)
npm run build        # production build
npm run watch        # rebuild on file changes
npm run typecheck    # tsc --noEmit
npm run lint         # eslint with --format=compact
npm run package      # build + create .xpi in artifacts/
```

## Tooling constraints

- **Thunderbird 115 (ESR) minimum**. `compose.getAttachmentFile` was
  added in TB 98, so the plugin cannot run on older versions. 115 is the
  current ESR baseline and matches what AMO/ATN expects.
- **Node 18+** is supported (CI matrix: 18, 20, 22).
- **ESLint 10's `stylish` formatter crashes on Node 18** (uses
  `util.styleText` which is Node 22+). Use `--format=compact`. The
  `eslint-formatter-compact` package is a devDep.
- **`eslint.config.mjs`** (not `.js`) — ESLint 10 loads `.js` files as
  CommonJS by default.
- Webpack uses `cheap-module-source-map` in dev (not the default
  `eval-source-map`) because the extension CSP blocks `eval`.

## Storage layout (browser.storage.local)

| Key | Type | Notes |
|---|---|---|
| `retyc_tokens` | `TokenSet` | access + refresh tokens. Validated on read; auto-cleared if shape is invalid. |
| `retyc_api_url` | `string` | API base URL |
| `retyc_app_url` | `string` | App URL for the share link |
| `retyc_expires_days` | `number` | transfer expiry in days |
| `retyc_auto_send` | `boolean` | 1-step (auto-send) vs 2-step |
| `retyc_enabled` | `boolean` | global kill switch toggled from the compose-popup. When `false`, `onBeforeSend` returns immediately and the email is sent normally. Default `true`. |

## Permissions and why

Required at install time:
- `storage` — settings + tokens
- `compose` — listAttachments, getAttachmentFile, removeAttachment, etc.
- `compose.send` — `compose.sendMessage` (auto-send mode)
- `accountsRead` — needed to enumerate compose accounts
- `notifications` — system notifications when SDK fails or upload is cancelled
- `tabs` — `tabs.onRemoved` for cleanup
- `https://api.retyc.com/*` — default API origin, granted upfront so that
  out-of-the-box installs work with the Retyc-hosted backend.

Optional, requested at runtime:
- `<all_urls>` — only requested in `options.ts > saveSettings()` when the
  user configures a non-default API URL. Asked via
  `browser.permissions.request({ origins })` from the Save click (user
  gesture). Keeps the install-time permissions narrow for ATN review.

## Patterns

### Async event handlers
ESLint's `no-misused-promises` requires wrapping async functions passed to
event listeners:
```ts
btn.addEventListener('click', () => { void asyncFn() })
```
Top-level `init()` calls use `.catch(console.error)` for defense.

### Background message router
Async handlers return Promises directly. Sync handlers return values
wrapped in `Promise.resolve()`:
```ts
case 'GET_COMPOSE_INFO': return Promise.resolve(handleGetComposeInfo(...))
```

## Known limitations (documented in SECURITY.md)

- Tokens stored in `browser.storage.local` are **not encrypted at rest**.
- The user must protect their OS account / Thunderbird profile.

## Don't do

- Don't add comments in French.
- Don't write `console.log` in production code paths — use
  `console.warn` / `console.error` only when justified.
- Don't add fields to `ComposeRecipient` types beyond what
  `thunderbird.d.ts` declares — it's a hand-rolled subset.
- Don't reintroduce a `keycloak` field in `SDKConfig` — the SDK no longer
  needs it (lazy OIDC loading).
- Don't use `compose_scripts` to trigger send — `compose.sendMessage` does
  it natively (with the `compose.send` permission).
