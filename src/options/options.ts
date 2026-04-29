import './options.css'
import type { Message, AuthStatusResponse, DeviceFlowResponse, SettingsPayload } from '../shared/messages'

function send<T>(msg: Message): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>
}

function showAuth(id: string): void {
  document.querySelectorAll<HTMLElement>('.auth-block').forEach(el => el.classList.add('hidden'))
  document.getElementById(id)?.classList.remove('hidden')
}

function showFeedback(message: string, type: 'success' | 'error'): void {
  const el = document.getElementById('save-feedback')!
  el.textContent = message
  el.className = `feedback ${type}`
  el.classList.remove('hidden')
  setTimeout(() => el.classList.add('hidden'), 5000)
}

let pollTimer: ReturnType<typeof setTimeout> | null = null

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function loadStatus(): Promise<void> {
  try {
    const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
    showAuth(status.authenticated ? 'auth-authenticated' : 'auth-unauthenticated')
    ;(document.getElementById('api-url') as HTMLInputElement).value = status.apiUrl
    ;(document.getElementById('app-url') as HTMLInputElement).value = status.appUrl
    ;(document.getElementById('expires-days') as HTMLInputElement).value = String(status.expiresDays)
    ;(document.getElementById('auto-send') as HTMLInputElement).checked = status.autoSend
  } catch (err) {
    showFeedback(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

async function startLogin(): Promise<void> {
  showAuth('auth-device-flow')
  try {
    const result = await send<DeviceFlowResponse & { error?: string }>({ type: 'START_LOGIN' })

    if (result.error) {
      showFeedback(result.error, 'error')
      showAuth('auth-unauthenticated')
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
        showAuth('auth-unauthenticated')
        return
      }
      const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
      if (status.authenticated) {
        stopPolling()
        showAuth('auth-authenticated')
        showFeedback('Successfully logged in to Retyc.', 'success')
      } else {
        pollTimer = setTimeout(tick, 3000)
      }
    }
    pollTimer = setTimeout(tick, 3000)
  } catch (err) {
    showFeedback(`Login failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    showAuth('auth-unauthenticated')
  }
}

function cancelLogin(): void {
  stopPolling()
  showAuth('auth-unauthenticated')
}

async function logout(): Promise<void> {
  stopPolling()
  await send({ type: 'LOGOUT' })
  showAuth('auth-unauthenticated')
  showFeedback('Logged out.', 'success')
}

function validateSecureUrl(value: string, label: string): string | null {
  if (!value) return `${label} is required.`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `${label} is not a valid URL.`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `${label} must use http or https.`
  }
  return null
}

function validateForm(): string | null {
  const apiUrl = (document.getElementById('api-url') as HTMLInputElement).value.trim()
  const appUrl = (document.getElementById('app-url') as HTMLInputElement).value.trim()
  const expiresDays = parseInt((document.getElementById('expires-days') as HTMLInputElement).value, 10)

  return (
    validateSecureUrl(apiUrl, 'API URL') ??
    validateSecureUrl(appUrl, 'App URL') ??
    (!Number.isFinite(expiresDays) || expiresDays < 1 || expiresDays > 365
      ? 'Expiry must be between 1 and 365 days.'
      : null)
  )
}

async function ensureOriginPermission(url: string): Promise<boolean> {
  const u = new URL(url)
  const origin = `${u.protocol}//${u.host}/*`
  const has = await browser.permissions.contains({ origins: [origin] })
  if (has) return true
  return browser.permissions.request({ origins: [origin] })
}

function isInsecureNonLocalhost(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return false
    const host = u.hostname
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]'
  } catch {
    return false
  }
}

async function saveSettings(e: Event): Promise<void> {
  e.preventDefault()

  const error = validateForm()
  if (error) { showFeedback(error, 'error'); return }

  const apiUrl = (document.getElementById('api-url') as HTMLInputElement).value.trim()
  const appUrl = (document.getElementById('app-url') as HTMLInputElement).value.trim()

  if (isInsecureNonLocalhost(apiUrl)) {
    showFeedback(
      'Warning: API URL uses http:// on a non-localhost host. OAuth tokens will transit unencrypted.',
      'error',
    )
    // Continue — do not block, user may have a deliberate dev setup.
  }

  // Request host permission upfront. The plugin only ships api.retyc.com by default;
  // any other host must be granted at save time (user gesture from form submit).
  let granted: boolean
  try {
    granted = await ensureOriginPermission(apiUrl)
  } catch (err) {
    showFeedback(`Permission request failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    return
  }
  if (!granted) {
    showFeedback('Host permission denied. Settings not saved — the plugin cannot reach this API URL without it.', 'error')
    return
  }

  const payload: SettingsPayload = {
    apiUrl,
    appUrl,
    expiresDays: parseInt((document.getElementById('expires-days') as HTMLInputElement).value, 10),
    autoSend: (document.getElementById('auto-send') as HTMLInputElement).checked,
  }

  try {
    const result = await send<{ ok: boolean }>({ type: 'SAVE_SETTINGS', payload })
    showFeedback(result.ok ? 'Settings saved.' : 'Failed to save settings.', result.ok ? 'success' : 'error')
  } catch (err) {
    showFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

window.addEventListener('beforeunload', stopPolling)

document.getElementById('btn-login')?.addEventListener('click', () => { void startLogin() })
document.getElementById('btn-cancel-login')?.addEventListener('click', cancelLogin)
document.getElementById('btn-logout')?.addEventListener('click', () => { void logout() })
document.getElementById('settings-form')?.addEventListener('submit', (e) => { void saveSettings(e) })

loadStatus().catch((err: unknown) => console.error('[Retyc] options init failed:', err))
