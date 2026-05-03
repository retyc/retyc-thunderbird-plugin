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

window.addEventListener('beforeunload', stopPolling)

document.getElementById('btn-login')?.addEventListener('click', () => { void startLogin() })
document.getElementById('btn-cancel-login')?.addEventListener('click', cancelLogin)
document.getElementById('btn-logout')?.addEventListener('click', () => { void logout() })
document.getElementById('settings-form')?.addEventListener('submit', (e) => { void saveSettings(e) })

loadStatus().catch((err: unknown) => console.error('[Retyc] options init failed:', err))
