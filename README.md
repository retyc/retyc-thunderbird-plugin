<p align="center">
  <img width="80" src="assets/icons/icon-128.png" alt="Retyc logo" />
</p>

<h1 align="center">Retyc for Thunderbird</h1>

<p align="center">
  Send large files securely from Thunderbird — end-to-end encrypted, GDPR-compliant.<br/>
  Attachments are automatically uploaded to <a href="https://retyc.com">Retyc</a> before sending, replaced by a secure download link.
</p>

<p align="center">
  <a href="https://github.com/retyc/retyc-thunderbird-plugin/actions/workflows/ci.yml">
    <img src="https://github.com/retyc/retyc-thunderbird-plugin/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/thunderbird-%3E%3D115-blue" alt="Thunderbird ≥ 115" />
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  </a>
</p>

---

## Features

- **Automatic interception** — when you click Send with attachments, the extension offers to upload them to Retyc instead
- **End-to-end encryption** — files are encrypted client-side before upload using the Retyc SDK
- **Passphrase support** — required when recipients don't have a Retyc account (minimum 8 characters)
- **OIDC Device Flow auth** — log in with your Retyc account directly from Thunderbird
- **Configurable** — API URL, app URL, and transfer expiry are all adjustable in settings
- **Clean emails** — attachments are removed and replaced by a formatted download link in the message body

## Requirements

- Thunderbird 115 (ESR) or later
- A [Retyc](https://retyc.com) account

## Installation

### From a release (recommended)

1. Download the latest `retyc-thunderbird-plugin.xpi` from the [Releases](https://github.com/retyc/retyc-thunderbird-plugin/releases) page
2. In Thunderbird: **Tools → Add-ons** → gear icon → **Install Add-on From File…**
3. Select the downloaded `.xpi`

### Load temporarily (development)

```bash
npm install
npm run build:dev
```

In Thunderbird: **Tools → Add-ons → Debug Add-ons → Load Temporary Add-on…** → select `manifest.json` at the project root.

## Usage

### 1. Log in

Click the **Retyc** button in the Thunderbird toolbar (or open **Settings**) and click **Log in with Retyc**. A code and URL will appear — open the URL in your browser, enter the code, and authenticate.

### 2. Send an email with attachments

Compose an email with one or more attachments and click **Send**. The extension intercepts the send and opens a confirmation dialog showing:

- The list of attachments and their sizes
- The recipients

If any recipient does not have a Retyc account, enter a **passphrase** (≥ 8 characters) so they can access the files without an account.

Click **Upload & Send** — the extension uploads the files, removes the attachments, adds a download link to the message body, and sends the email.

Click **Keep attachments** to cancel and send normally.

### 3. Settings

Open **Settings** from the toolbar popup or via **Tools → Add-ons → Retyc → Options**:

| Setting | Description | Default |
|---|---|---|
| API URL | Retyc backend API | `https://api.retyc.com` |
| App URL | Used to build the download link in emails | `https://retyc.com` |
| Transfer expiry | Days before the transfer expires | `7` |

## Development

### Prerequisites

- Node.js 18+ (CI matrix: 18, 20, 22)
- The `@retyc/sdk` package is fetched from npm via `npm install` — no extra setup required

### Setup

```bash
npm install
npm run build:dev   # development build (with source maps)
npm run build       # production build
npm run watch       # rebuild on file changes
npm run typecheck   # TypeScript type-check only
```

### Project structure

```
src/
  background/     # Background script: interception, upload, auth, message router
  compose-popup/  # Popup shown from the compose window toolbar button
  dialog/         # Upload confirmation dialog (opened as a popup window)
  options/        # Settings page
  popup/          # Main toolbar popup (auth status, login/logout)
  shared/         # Shared types and constants
  types/          # Thunderbird MailExtension type declarations
assets/icons/     # Extension icons
dist/             # Webpack build output (gitignored)
```

### Architecture

The extension uses a background script as the single source of truth. UI pages (popup, dialog, options) communicate with it via `browser.runtime.sendMessage`.

**Send interception flow:**

```
User clicks Send
  └─ onBeforeSend fires (background)
       ├─ No attachments or not logged in → pass through
       └─ Attachments + authenticated
            ├─ Cancel the send
            ├─ Open dialog popup
            │    ├─ User cancels → compose window stays open
            │    └─ User confirms (+ optional passphrase)
            │         ├─ Passphrase < 8 chars → validation error, retry
            │         ├─ API 409 (passphrase required) → back to dialog, retry
            │         ├─ Upload files to Retyc (sequentially)
            │         ├─ Remove attachments from compose
            │         ├─ Append download link to message body
            │         └─ Re-send (bypassing interception)
            └─ Cleanup on dialog close or tab close
```

## CI

GitHub Actions runs on every push and pull request:

- Type-check (`tsc --noEmit`)
- Production build (`webpack --mode production`)
- Lint
- Manifest validation (`web-ext lint`)
- Node 18, 20 and 22 matrix

On release, a `.xpi` package is built from the CI artifact and attached to the GitHub release.

## Creating a release

### 1. Build the package locally

```bash
npm run package
# → artifacts/retyc-thunderbird-plugin-X.Y.Z.xpi
```

`npm run package` runs a production webpack build then calls `web-ext build`, which produces a `.xpi` directly (a `.xpi` is a renamed `.zip` — both formats are valid for Thunderbird).

To test the packaged extension before releasing:

```bash
npx web-ext run -t thunderbird --source-dir=.
```

### 2. Bump the version

Update the version in **both** files (they must match):

- `package.json` → `"version": "X.Y.Z"`
- `manifest.json` → `"version": "X.Y.Z"`

### 3. Publish on addons.thunderbird.net (ATN)

1. Go to [addons.thunderbird.net/developers](https://addons.thunderbird.net/en-US/developers/) and log in
2. Submit the `.xpi` from `artifacts/`
3. ATN reviews the extension and returns a **signed** `.xpi`
4. The signed `.xpi` is what end users install

> **Note:** Unlike Firefox/AMO, there is no CLI signing API for Thunderbird. `web-ext sign` targets AMO only — signing must be done via the ATN web interface.

### 4. Create a GitHub release

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The CI `package` job triggers automatically on release tags and attaches the `.xpi` to the GitHub release.

Alternatively, create the release manually on GitHub and upload the signed `.xpi` from ATN.

### Self-hosted distribution

If you distribute outside ATN, host an `updates.json` file to enable automatic updates. See the [MDN self-hosting guide](https://extensionworkshop.com/documentation/publish/self-distribution/) for the required format.

## License

[MIT](LICENSE) — © Retyc / TripleStack SAS
