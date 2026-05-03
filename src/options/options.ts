import '../shared/common.css'
import './options.css'
import type {
  Message,
  AuthStatusResponse,
  DeviceFlowResponse,
  RefreshTokenResponse,
  SettingsPayload,
  UserQuotaResponse,
} from '../shared/messages'

function send<T>(msg: Message): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>
}

function showAuthBlock(id: string | null): void {
  document.querySelectorAll<HTMLElement>('.auth-block').forEach(el => el.classList.add('hidden'))
  if (id) document.getElementById(id)?.classList.remove('hidden')
}

function setSectionVisible(id: string, visible: boolean): void {
  document.getElementById(id)?.classList.toggle('hidden', !visible)
}

function showFeedback(message: string, type: 'success' | 'error'): void {
  const el = document.getElementById('save-feedback')!
  el.textContent = message
  el.className = `feedback ${type}`
  el.classList.remove('hidden')
  setTimeout(() => el.classList.add('hidden'), 5000)
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
// Holds either the periodic tick (setInterval) when we're inside the live-update
// window, or a one-shot setTimeout that fires when we cross into it.
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let currentTokenExpiresAt: number | null = null

// Below this many seconds, refresh the displayed expiry every TICK_INTERVAL_MS.
const LIVE_UPDATE_THRESHOLD_SECONDS = 600
const TICK_INTERVAL_MS = 30_000

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function stopExpiryTimer(): void {
  if (expiryTimer !== null) {
    // clearTimeout works for setInterval handles too in browsers.
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

function formatExpiry(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'Token expired'
  if (seconds < 60) return `Expires in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Expires in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours < 24) return mins > 0 ? `Expires in ${hours}h ${mins}m` : `Expires in ${hours}h`
  const days = Math.floor(hours / 24)
  return `Expires in ${days}d`
}

function updateExpiryDisplay(): void {
  const el = document.getElementById('account-expires')
  if (!el) return
  if (currentTokenExpiresAt === null) {
    el.textContent = ''
    return
  }
  el.textContent = formatExpiry(currentTokenExpiresAt)
}

function armExpiryTimer(): void {
  stopExpiryTimer()
  if (currentTokenExpiresAt === null) return
  const remaining = currentTokenExpiresAt - Math.floor(Date.now() / 1000)
  if (remaining <= 0) return  // already expired — no need to keep ticking
  if (remaining < LIVE_UPDATE_THRESHOLD_SECONDS) {
    expiryTimer = setInterval(() => {
      updateExpiryDisplay()
      // Self-stop once the token has expired so we don't keep firing forever.
      if (currentTokenExpiresAt === null ||
          currentTokenExpiresAt - Math.floor(Date.now() / 1000) <= 0) {
        stopExpiryTimer()
      }
    }, TICK_INTERVAL_MS)
  } else {
    // Stay quiet until we cross the threshold, then re-arm to start the 30s ticks.
    const delayMs = (remaining - LIVE_UPDATE_THRESHOLD_SECONDS) * 1000
    expiryTimer = setTimeout(armExpiryTimer, delayMs)
  }
}

function setTokenExpiry(expiresAt: number | undefined): void {
  currentTokenExpiresAt = typeof expiresAt === 'number' ? expiresAt : null
  updateExpiryDisplay()
  armExpiryTimer()
}

function formatSize(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function renderQuota(quota: UserQuotaResponse): void {
  const block = document.getElementById('quota-block')!
  block.classList.remove('hidden')

  const storagePct = quota.maxStorage > 0
    ? Math.min(100, Math.round((quota.usedStorage / quota.maxStorage) * 100))
    : 0
  document.getElementById('quota-storage-text')!.textContent =
    `${formatSize(quota.usedStorage)} / ${formatSize(quota.maxStorage)}`
  const storageBar = document.getElementById('quota-storage-bar')!
  storageBar.style.width = `${storagePct}%`
  storageBar.classList.toggle('danger', storagePct >= 90)

  const transfersRow = document.getElementById('quota-transfers-row')!
  if (quota.maxCountShare !== null) {
    transfersRow.classList.remove('hidden')
    const pct = quota.maxCountShare > 0
      ? Math.min(100, Math.round((quota.countShare / quota.maxCountShare) * 100))
      : 0
    document.getElementById('quota-transfers-text')!.textContent =
      `${quota.countShare} / ${quota.maxCountShare}`
    const bar = document.getElementById('quota-transfers-bar')!
    bar.style.width = `${pct}%`
    bar.classList.toggle('danger', pct >= 90)
  } else {
    transfersRow.classList.add('hidden')
  }
}

function clearQuota(): void {
  document.getElementById('quota-block')?.classList.add('hidden')
}

function renderAuthenticated(status: AuthStatusResponse): void {
  setSectionVisible('account-section', true)
  setSectionVisible('auth-section', false)
  showAuthBlock(null)

  const fullName = status.userInfo?.fullName ?? ''
  const email = status.userInfo?.email ?? ''
  const fullNameEl = document.getElementById('account-fullname')!
  fullNameEl.textContent = fullName
  fullNameEl.style.display = fullName ? '' : 'none'
  document.getElementById('account-email')!.textContent = email

  setTokenExpiry(status.tokenExpiresAt)
}

function renderUnauthenticated(): void {
  setSectionVisible('account-section', false)
  setSectionVisible('auth-section', true)
  showAuthBlock('auth-unauthenticated')
  setTokenExpiry(undefined)
  clearQuota()
}

function renderDeviceFlow(): void {
  setSectionVisible('account-section', false)
  setSectionVisible('auth-section', true)
  showAuthBlock('auth-device-flow')
}

async function loadQuota(): Promise<void> {
  try {
    const result = await send<UserQuotaResponse | { error: string }>({ type: 'GET_USER_QUOTA' })
    if ('error' in result) return  // quota is informational; stay silent on failure
    renderQuota(result)
  } catch { /* silent */ }
}

async function loadStatus(): Promise<void> {
  try {
    const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
    if (status.authenticated) {
      renderAuthenticated(status)
      void loadQuota()
    } else {
      renderUnauthenticated()
    }
    ;(document.getElementById('auto-send') as HTMLInputElement).checked = status.autoSend
  } catch (err) {
    showFeedback(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`, 'error')
    renderUnauthenticated()
  }
}

async function refreshToken(): Promise<void> {
  const btn = document.getElementById('btn-refresh') as HTMLButtonElement
  btn.disabled = true
  const originalText = btn.textContent
  btn.textContent = '…'
  try {
    const result = await send<RefreshTokenResponse>({ type: 'REFRESH_TOKEN' })
    if (result.ok && result.tokenExpiresAt) {
      setTokenExpiry(result.tokenExpiresAt)
      showFeedback('Token refreshed.', 'success')
    } else if (!result.ok) {
      showFeedback(result.error ?? 'Refresh failed', 'error')
    }
  } catch (err) {
    showFeedback(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

async function startLogin(): Promise<void> {
  renderDeviceFlow()
  try {
    const result = await send<DeviceFlowResponse & { error?: string }>({ type: 'START_LOGIN' })

    if (result.error) {
      showFeedback(result.error, 'error')
      renderUnauthenticated()
      return
    }

    const urlEl = document.getElementById('verification-url') as HTMLAnchorElement
    urlEl.href = result.verificationUriComplete ?? result.verificationUri
    urlEl.textContent = result.verificationUri
    document.getElementById('user-code')!.textContent = result.userCode

    const deadline = Date.now() + result.expiresIn * 1000
    const tick = async (): Promise<void> => {
      if (pollTimer === null) return
      if (Date.now() > deadline) {
        stopPolling()
        showFeedback('Authentication timed out. Please try again.', 'error')
        renderUnauthenticated()
        return
      }
      const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
      if (status.authenticated) {
        stopPolling()
        renderAuthenticated(status)
        void loadQuota()
        showFeedback('Successfully logged in to Retyc.', 'success')
      } else {
        pollTimer = setTimeout(tick, 3000)
      }
    }
    pollTimer = setTimeout(tick, 3000)
  } catch (err) {
    showFeedback(`Login failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    renderUnauthenticated()
  }
}

function cancelLogin(): void {
  stopPolling()
  renderUnauthenticated()
}

async function logout(): Promise<void> {
  stopPolling()
  await send({ type: 'LOGOUT' })
  renderUnauthenticated()
  showFeedback('Logged out.', 'success')
}

async function saveSettings(e: Event): Promise<void> {
  e.preventDefault()

  const payload: SettingsPayload = {
    autoSend: (document.getElementById('auto-send') as HTMLInputElement).checked,
  }

  try {
    const result = await send<{ ok: boolean }>({ type: 'SAVE_SETTINGS', payload })
    showFeedback(result.ok ? 'Settings saved.' : 'Failed to save settings.', result.ok ? 'success' : 'error')
  } catch (err) {
    showFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

window.addEventListener('beforeunload', () => {
  stopPolling()
  stopExpiryTimer()
})

document.getElementById('btn-login')?.addEventListener('click', () => { void startLogin() })
document.getElementById('btn-cancel-login')?.addEventListener('click', cancelLogin)
document.getElementById('btn-logout')?.addEventListener('click', () => { void logout() })
document.getElementById('btn-refresh')?.addEventListener('click', () => { void refreshToken() })
document.getElementById('settings-form')?.addEventListener('submit', (e) => { void saveSettings(e) })

loadStatus().catch((err: unknown) => console.error('[Retyc] options init failed:', err))
