import { getSDK, getApiUrl, invalidateSDK } from './sdk-factory'
import {
  DEFAULT_APP_URL,
  DEFAULT_AUTO_SEND,
  DEFAULT_ENABLED,
  DEFAULT_EXPIRES_DAYS,
  TRANSFER_PATH_PREFIX,
  STORAGE_KEY_API_URL,
  STORAGE_KEY_APP_URL,
  STORAGE_KEY_AUTO_SEND,
  STORAGE_KEY_ENABLED,
  STORAGE_KEY_EXPIRES_DAYS,
} from '../shared/constants'
import type {
  Message,
  AuthStatusResponse,
  DeviceFlowResponse,
  RefreshTokenResponse,
  SettingsPayload,
  SetEnabledPayload,
  ComposeInfoResponse,
  ConfirmUploadPayload,
  UploadProgressPayload,
  UploadDonePayload,
  UploadErrorPayload,
  UserInfo,
} from '../shared/messages'

// Cached user info — fetched once after login, cleared on logout or API URL change.
let _cachedUserInfo: UserInfo | null = null

export function clearUserInfoCache(): void {
  _cachedUserInfo = null
}

// Tabs that must bypass the next onBeforeSend interception (post-upload resend).
const bypassTabs = new Set<number>()

interface PendingUpload {
  dialogWindowId?: number
  attachments: browser.compose.ComposeAttachment[]
  recipients: string[]
  abort: AbortController
}
const pendingUploads = new Map<number, PendingUpload>()

// --- Cleanup listeners ---

// If the user closes the dialog, abort any in-progress upload and warn them.
browser.windows.onRemoved.addListener((windowId: number) => {
  for (const [tabId, pending] of pendingUploads) {
    if (pending.dialogWindowId === windowId) {
      const wasUploading = !pending.abort.signal.aborted
      pending.abort.abort()
      pendingUploads.delete(tabId)
      if (wasUploading) {
        notifyUser(
          'Transfer cancelled — the upload was interrupted and the email was not sent. Your attachments are still in the compose window.',
        )
      }
      return
    }
  }
})

// If the compose tab is closed during upload, discard pending state.
browser.tabs.onRemoved.addListener((tabId: number) => {
  if (pendingUploads.has(tabId)) {
    const pending = pendingUploads.get(tabId)!
    pendingUploads.delete(tabId)
    bypassTabs.delete(tabId)
    if (pending.dialogWindowId) {
      browser.windows.remove(pending.dialogWindowId).catch(() => {})
    }
  }
})

// --- Helpers ---

async function getAppUrl(): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEY_APP_URL)
  return (result[STORAGE_KEY_APP_URL] as string | undefined) ?? DEFAULT_APP_URL
}

async function getExpiresDays(): Promise<number> {
  const result = await browser.storage.local.get(STORAGE_KEY_EXPIRES_DAYS)
  const raw: unknown = result[STORAGE_KEY_EXPIRES_DAYS]
  return typeof raw === 'number' ? raw : DEFAULT_EXPIRES_DAYS
}

async function getAutoSend(): Promise<boolean> {
  const result = await browser.storage.local.get(STORAGE_KEY_AUTO_SEND)
  const raw: unknown = result[STORAGE_KEY_AUTO_SEND]
  return typeof raw === 'boolean' ? raw : DEFAULT_AUTO_SEND
}

async function getEnabled(): Promise<boolean> {
  const result = await browser.storage.local.get(STORAGE_KEY_ENABLED)
  const raw: unknown = result[STORAGE_KEY_ENABLED]
  return typeof raw === 'boolean' ? raw : DEFAULT_ENABLED
}

function buildTransferUrl(appUrl: string, slug: string): string {
  // Defence in depth: even though slug is server-controlled, the API URL is user-configurable,
  // so a malicious backend could attempt to return a slug that breaks out of the path.
  const base = new URL(appUrl)
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`Invalid app URL protocol: ${base.protocol}`)
  }
  const path = `${TRANSFER_PATH_PREFIX}/${encodeURIComponent(slug)}`
  const url = new URL(path, base)
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error('Refusing to build a transfer URL outside of the configured app origin.')
  }
  return url.toString()
}

function broadcastToPopups(message: Message): void {
  browser.runtime.sendMessage(message).catch(() => {})
}

// Token is considered "near expiry" if it has less than this many seconds left.
const TOKEN_REFRESH_THRESHOLD_SECONDS = 60

function isTokenNearExpiry(expiresAt: number): boolean {
  return expiresAt - TOKEN_REFRESH_THRESHOLD_SECONDS < Math.floor(Date.now() / 1000)
}

function notifyUser(message: string): void {
  browser.notifications.create({
    type: 'basic',
    // PNG (not SVG): system notification renderers on Windows/macOS don't reliably
    // accept SVG icons.
    iconUrl: browser.runtime.getURL('assets/icons/icon-48.png'),
    title: 'Retyc',
    message,
  }).catch(() => {})
}

// --- onBeforeSend interception ---

browser.compose.onBeforeSend.addListener(
  async (tab: browser.tabs.Tab, details: browser.compose.ComposeDetails) => {
    if (typeof tab.id !== 'number') return
    const tabId = tab.id

    if (bypassTabs.has(tabId)) {
      bypassTabs.delete(tabId)
      return // Post-upload resend — let it through
    }

    // User-toggleable kill switch from the compose-popup. When off, send normally.
    if (!(await getEnabled())) return

    let attachments: browser.compose.ComposeAttachment[]
    try {
      attachments = await browser.compose.listAttachments(tabId)
    } catch {
      return
    }
    if (attachments.length === 0) return

    let tokens
    try {
      const sdk = await getSDK()
      tokens = await sdk.auth.getTokens()
      // Refresh proactively if the access token is about to expire — we cannot afford
      // an expired token mid-upload (the user would lose attachments and see a cryptic error).
      if (tokens && isTokenNearExpiry(tokens.expiresAt)) {
        try {
          tokens = await sdk.auth.refresh()
        } catch (err) {
          console.warn('[Retyc] Proactive refresh failed; will let interception proceed and surface the error to the user:', err)
        }
      }
    } catch (err) {
      console.warn('[Retyc] SDK unavailable, skipping Retyc interception:', err)
      notifyUser(
        'Retyc could not connect to the API — your attachments will be sent normally.',
      )
      return
    }

    if (!tokens) return

    // Reuse the details already provided by onBeforeSend — no extra round-trip.
    const recipients = extractRecipients(details)

    // No recipients → nothing to encrypt for; let the send proceed normally.
    if (recipients.length === 0) return

    // Concurrent send protection: if an upload is already pending for this tab,
    // cancel this duplicate send rather than overwriting the in-flight AbortController.
    if (pendingUploads.has(tabId)) return { cancel: true }

    pendingUploads.set(tabId, { attachments, recipients, abort: new AbortController() })

    try {
      const win = await browser.windows.create({
        url: browser.runtime.getURL(`dist/dialog.html?tabId=${tabId}`),
        type: 'popup',
        width: 520,
        height: 410,
      })

      const pending = pendingUploads.get(tabId)
      if (pending && win.id) pending.dialogWindowId = win.id
    } catch (err) {
      console.error('[Retyc] Failed to open upload dialog:', err)
      pendingUploads.delete(tabId)
    }

    return { cancel: true }
  },
)

function extractRecipients(details: browser.compose.ComposeDetails): string[] {
  const emails: string[] = []
  const fields: Array<browser.compose.ComposeRecipientList | undefined> = [
    details.to,
    details.cc,
    details.bcc,
  ]

  for (const field of fields) {
    if (!field) continue
    const arr = Array.isArray(field) ? field : [field]
    for (const entry of arr) {
      if (!entry) continue
      const email = typeof entry === 'string' ? entry : entry.email
      if (email) emails.push(email)
    }
  }

  return [...new Set(emails)]
}

// --- Upload orchestration ---

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Upload cancelled by user.')
}

async function performUpload(tabId: number, passphrase?: string): Promise<void> {
  const pending = pendingUploads.get(tabId)
  if (!pending) throw new Error('No pending upload found for this compose tab.')

  const { signal } = pending.abort

  const sdk = await getSDK()
  const appUrl = await getAppUrl()
  const expiresDays = await getExpiresDays()
  const expiresSeconds = expiresDays * 24 * 60 * 60

  const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB hard limit
  const totalBytes = pending.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `Total attachment size (${(totalBytes / 1e9).toFixed(1)} GB) exceeds the 5 GB limit.`,
    )
  }

  // Upload files sequentially to avoid holding all data in memory at once.
  const uploadFiles = []
  for (let idx = 0; idx < pending.attachments.length; idx++) {
    checkAbort(signal)

    const att = pending.attachments[idx]

    broadcastToPopups({
      type: 'UPLOAD_PROGRESS',
      payload: {
        tabId,
        fileName: att.name,
        fileIndex: idx,
        totalFiles: pending.attachments.length,
      } satisfies UploadProgressPayload,
    })

    const file = await browser.compose.getAttachmentFile(att.id)
    const arrayBuf = await file.arrayBuffer()
    checkAbort(signal)

    uploadFiles.push({
      name: att.name,
      mimeType: file.type || 'application/octet-stream',
      data: new Uint8Array(arrayBuf),
      size: arrayBuf.byteLength,
    })
  }

  checkAbort(signal)

  // Notify the dialog that all local file reads are done — the SDK upload may take
  // a long time (encryption + network) without giving us per-file progress hooks.
  broadcastToPopups({
    type: 'UPLOAD_PROGRESS',
    payload: {
      tabId,
      fileName: '',
      fileIndex: pending.attachments.length,
      totalFiles: pending.attachments.length,
      finalizing: true,
    } satisfies UploadProgressPayload,
  })

  const result = await sdk.transfers.upload({
    recipients: pending.recipients,
    expires: expiresSeconds,
    files: uploadFiles,
    ...(passphrase ? { passphrase } : {}),
  })

  // Check after the (potentially long) SDK upload before touching the compose window.
  checkAbort(signal)

  const transferUrl = buildTransferUrl(appUrl, result.slug)

  // Remove all original attachments from the compose window.
  for (const att of pending.attachments) {
    await browser.compose.removeAttachment(tabId, att.id).catch((err: unknown) => {
      console.warn(`[Retyc] Could not remove attachment "${att.name}":`, err)
    })
  }

  // Inject the Retyc link into the message body.
  const currentDetails = await browser.compose.getComposeDetails(tabId)
  await appendRetycLink(tabId, currentDetails, transferUrl)

  // Clean up before re-sending.
  pendingUploads.delete(tabId)

  broadcastToPopups({
    type: 'UPLOAD_DONE',
    payload: { tabId, transferUrl } satisfies UploadDonePayload,
  })

  const dialogWindowId = pending.dialogWindowId
  if (dialogWindowId) {
    // Await removal so the dialog is fully gone before we trigger the next send.
    await browser.windows.remove(dialogWindowId).catch(() => {})
  }

  const autoSend = await getAutoSend()

  // Register the bypass so the next send (manual or auto) skips interception.
  // Auto-send fires sendMessage immediately, so 5s is plenty. In manual 2-step mode
  // the user may take up to a minute to click Send themselves — give them that window.
  bypassTabs.add(tabId)
  setTimeout(() => bypassTabs.delete(tabId), autoSend ? 5_000 : 60_000)

  if (autoSend) {
    try {
      await browser.compose.sendMessage(tabId, { mode: 'sendNow' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Retyc] Auto-send failed:', err)
      notifyUser(`Auto-send failed (${msg}). Your message is ready — click Send manually.`)
    }
  }
}

async function appendRetycLink(
  tabId: number,
  details: browser.compose.ComposeDetails,
  transferUrl: string,
): Promise<void> {
  const safeUrl = escapeHtml(transferUrl)

  if (details.isPlainText) {
    const existing = details.plainTextBody ?? ''
    const addition = [
      '---',
      'Your files are available via Retyc:',
      transferUrl,
      'This transfer is end-to-end encrypted and will expire automatically.',
    ].join('\n')
    await browser.compose.setComposeDetails(tabId, {
      plainTextBody: `${existing}\n\n${addition}`,
    })
  } else {
    const existing = details.body ?? ''
    const addition = `
<br><br>
<hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">
<p style="font-family:sans-serif;font-size:14px;color:#444;margin:0">
  <strong>&#128230; Your files are available via Retyc:</strong><br>
  <a href="${safeUrl}" style="color:#1a3c6e">${safeUrl}</a><br>
  <small style="color:#888">This transfer is end-to-end encrypted and will expire automatically.</small>
</p>`
    await browser.compose.setComposeDetails(tabId, { body: existing + addition })
  }
}

function validateHttpUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// --- Message router ---

browser.runtime.onMessage.addListener(
  (rawMsg: unknown): Promise<unknown> | undefined => {
    const msg = rawMsg as Message

    switch (msg.type) {
      case 'GET_AUTH_STATUS':    return handleGetAuthStatus()
      case 'START_LOGIN':        return handleStartLogin()
      case 'LOGOUT':             return handleLogout()
      case 'REFRESH_TOKEN':      return handleRefreshToken()
      case 'GET_SETTINGS':       return handleGetSettings()
      case 'SAVE_SETTINGS':      return handleSaveSettings(msg.payload as SettingsPayload)
      case 'SET_ENABLED':        return handleSetEnabled(msg.payload as SetEnabledPayload)
      case 'GET_COMPOSE_INFO':   return Promise.resolve(handleGetComposeInfo(msg.payload as { tabId: number }))
      case 'CONFIRM_UPLOAD':     return handleConfirmUpload(msg.payload as ConfirmUploadPayload)
      case 'CANCEL_UPLOAD':      return Promise.resolve(handleCancelUpload(msg.payload as { tabId: number }))
      default:                   return undefined
    }
  },
)

async function handleGetAuthStatus(): Promise<AuthStatusResponse> {
  let authenticated = false
  let tokenExpiresAt: number | undefined
  const apiUrl = await getApiUrl()
  const appUrl = await getAppUrl()
  const expiresDays = await getExpiresDays()
  const autoSend = await getAutoSend()
  const enabled = await getEnabled()

  try {
    const sdk = await getSDK()
    const tokens = await sdk.auth.getTokens()
    if (tokens) {
      authenticated = true
      tokenExpiresAt = tokens.expiresAt

      // Fetch user info if not cached yet
      if (!_cachedUserInfo) {
        try {
          const me = await sdk.user.getMe()
          _cachedUserInfo = {
            fullName: me.user.full_name,
            email: me.user.email,
          }
        } catch { /* user info is optional */ }
      }
    }
  } catch { /* not authenticated or SDK unavailable */ }

  return {
    authenticated,
    apiUrl,
    appUrl,
    expiresDays,
    autoSend,
    enabled,
    userInfo: _cachedUserInfo ?? undefined,
    tokenExpiresAt,
  }
}

async function handleSetEnabled(payload: SetEnabledPayload): Promise<{ ok: boolean }> {
  try {
    await browser.storage.local.set({ [STORAGE_KEY_ENABLED]: payload.enabled })
    return { ok: true }
  } catch (err) {
    console.error('[Retyc] Failed to set enabled flag:', err)
    return { ok: false }
  }
}

async function handleRefreshToken(): Promise<RefreshTokenResponse> {
  try {
    const sdk = await getSDK()
    const tokens = await sdk.auth.refresh()
    return { ok: true, tokenExpiresAt: tokens.expiresAt }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleStartLogin(): Promise<DeviceFlowResponse | { error: string }> {
  try {
    const sdk = await getSDK()
    const flow = await sdk.auth.startDeviceFlow()

    flow.poll().catch((err: unknown) => {
      console.error('[Retyc] Device flow polling error:', err)
    })

    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      verificationUriComplete: flow.verificationUriComplete,
      expiresIn: flow.expiresIn,
    }
  } catch (err) {
    return { error: `Failed to start login: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function handleLogout(): Promise<{ ok: boolean }> {
  _cachedUserInfo = null
  try {
    const sdk = await getSDK()
    await sdk.auth.logout()
    return { ok: true }
  } catch (err) {
    console.error('[Retyc] Logout error:', err)
    return { ok: false }
  }
}

async function handleGetSettings(): Promise<SettingsPayload> {
  return {
    apiUrl: await getApiUrl(),
    appUrl: await getAppUrl(),
    expiresDays: await getExpiresDays(),
    autoSend: await getAutoSend(),
  }
}

async function handleSaveSettings(payload: SettingsPayload): Promise<{ ok: boolean; error?: string }> {
  if (!validateHttpUrl(payload.apiUrl)) return { ok: false, error: 'API URL must be a valid HTTP/HTTPS URL.' }
  if (!validateHttpUrl(payload.appUrl)) return { ok: false, error: 'App URL must be a valid HTTP/HTTPS URL.' }
  try {
    await browser.storage.local.set({
      [STORAGE_KEY_API_URL]: payload.apiUrl,
      [STORAGE_KEY_APP_URL]: payload.appUrl,
      [STORAGE_KEY_EXPIRES_DAYS]: payload.expiresDays,
      [STORAGE_KEY_AUTO_SEND]: payload.autoSend,
    })
    invalidateSDK()
    _cachedUserInfo = null  // user info belongs to the previous API context
    return { ok: true }
  } catch (err) {
    console.error('[Retyc] Save settings error:', err)
    return { ok: false }
  }
}

function handleGetComposeInfo(
  payload: { tabId: number },
): ComposeInfoResponse | { error: string } {
  const { tabId } = payload
  const pending = pendingUploads.get(tabId)
  if (!pending) return { error: 'No pending upload found for this tab.' }

  return {
    tabId,
    attachments: pending.attachments.map(a => ({
      id: String(a.id),
      name: a.name,
      size: a.size ?? 0,
    })),
    recipients: pending.recipients,
  }
}

function isAuthError(message: string): boolean {
  return (
    message.toLowerCase().includes('refresh token') ||
    message.toLowerCase().includes('log in again') ||
    (/\b401\b/.test(message) && message.toLowerCase().includes('auth'))
  )
}

async function handleConfirmUpload(
  payload: ConfirmUploadPayload,
): Promise<{ ok: boolean; needsPassphrase?: boolean; needsReauth?: boolean; error?: string }> {
  const { tabId, passphrase } = payload
  // Wipe the passphrase from the inbound message envelope. The runtime may keep a
  // reference to the original payload object until GC; clearing the property gives us
  // a best-effort guarantee that it won't sit around in memory longer than needed.
  ;(payload as { passphrase?: string }).passphrase = undefined
  try {
    await performUpload(tabId, passphrase)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[Retyc] Upload error:', err)

    // User closed the dialog — already notified via windows.onRemoved, nothing more to do.
    if (message === 'Upload cancelled by user.') return { ok: false }

    // Refresh token expired — clear stale session and ask user to log in again.
    if (isAuthError(message)) {
      pendingUploads.delete(tabId)
      try {
        const sdk = await getSDK()
        await sdk.auth.logout()
      } catch { /* best effort */ }
      broadcastToPopups({
        type: 'UPLOAD_ERROR',
        payload: { tabId, error: message } satisfies UploadErrorPayload,
      })
      return { ok: false, needsReauth: true, error: 'Your Retyc session has expired. Please log in again.' }
    }

    // API error 409 = passphrase required — keep pendingUploads so the user can retry.
    if (/\b409\b/.test(message)) {
      return {
        ok: false,
        needsPassphrase: true,
        error: 'A passphrase is required for recipients without a Retyc account.',
      }
    }

    pendingUploads.delete(tabId)
    broadcastToPopups({
      type: 'UPLOAD_ERROR',
      payload: { tabId, error: message } satisfies UploadErrorPayload,
    })
    return { ok: false, error: message }
  }
}

function handleCancelUpload(payload: { tabId: number }): { ok: boolean } {
  const { tabId } = payload
  const pending = pendingUploads.get(tabId)
  pendingUploads.delete(tabId)
  if (pending?.dialogWindowId) {
    void browser.windows.remove(pending.dialogWindowId).catch(() => { /* best effort */ })
  }
  return { ok: true }
}

