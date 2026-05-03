import '../shared/common.css'
import './popup.css'
import type { Message, AuthStatusResponse, DeviceFlowResponse, RefreshTokenResponse } from '../shared/messages'

function send<T>(msg: Message): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>
}

function show(id: string): void {
  document.querySelectorAll<HTMLElement>('.state').forEach(el => el.classList.add('hidden'))
  document.getElementById(id)?.classList.remove('hidden')
}

function showError(msg: string): void {
  const box = document.getElementById('error-box')!
  document.getElementById('error-msg')!.textContent = msg
  box.classList.remove('hidden')
  setTimeout(() => box.classList.add('hidden'), 6000)
}

let pollTimer: ReturnType<typeof setTimeout> | null = null

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
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

function renderAuthenticatedState(status: AuthStatusResponse): void {
  show('authenticated')

  const fullNameEl = document.getElementById('user-fullname')!
  const emailEl = document.getElementById('user-email')!
  const expiresEl = document.getElementById('token-expires')!

  if (status.userInfo) {
    fullNameEl.textContent = status.userInfo.fullName ?? ''
    fullNameEl.style.display = status.userInfo.fullName ? '' : 'none'
    emailEl.textContent = status.userInfo.email
  } else {
    fullNameEl.style.display = 'none'
    emailEl.textContent = ''
  }

  expiresEl.textContent = status.tokenExpiresAt ? formatExpiry(status.tokenExpiresAt) : ''
}

async function init(): Promise<void> {
  show('loading')
  try {
    const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
    if (status.authenticated) {
      renderAuthenticatedState(status)
    } else {
      show('unauthenticated')
    }
  } catch (err) {
    showError(`Error: ${err instanceof Error ? err.message : String(err)}`)
    show('unauthenticated')
  }
}

async function refreshToken(): Promise<void> {
  const btn = document.getElementById('btn-refresh') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = '…'
  try {
    const result = await send<RefreshTokenResponse>({ type: 'REFRESH_TOKEN' })
    if (result.ok && result.tokenExpiresAt) {
      document.getElementById('token-expires')!.textContent = formatExpiry(result.tokenExpiresAt)
    } else if (!result.ok) {
      showError(result.error ?? 'Refresh failed')
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  } finally {
    btn.disabled = false
    btn.textContent = '↻'
  }
}

async function startLogin(): Promise<void> {
  show('loading')
  try {
    const result = await send<DeviceFlowResponse & { error?: string }>({ type: 'START_LOGIN' })

    if (result.error) {
      showError(result.error)
      show('unauthenticated')
      return
    }

    show('device-flow')
    const urlEl = document.getElementById('verification-url') as HTMLAnchorElement
    urlEl.href = result.verificationUriComplete ?? result.verificationUri
    urlEl.textContent = result.verificationUri
    document.getElementById('user-code')!.textContent = result.userCode

    const deadline = Date.now() + result.expiresIn * 1000
    const tick = async (): Promise<void> => {
      if (pollTimer === null) return
      if (Date.now() > deadline) {
        stopPolling()
        showError('Authentication timed out. Please try again.')
        show('unauthenticated')
        return
      }
      const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
      if (status.authenticated) {
        stopPolling()
        show('authenticated')
      } else {
        pollTimer = setTimeout(tick, 3000)
      }
    }
    pollTimer = setTimeout(tick, 3000)
  } catch (err) {
    showError(`Login failed: ${err instanceof Error ? err.message : String(err)}`)
    show('unauthenticated')
  }
}

function cancelLogin(): void {
  stopPolling()
  show('unauthenticated')
}

async function logout(): Promise<void> {
  await send({ type: 'LOGOUT' })
  show('unauthenticated')
}

window.addEventListener('unload', stopPolling)

document.getElementById('btn-refresh')?.addEventListener('click', () => { void refreshToken() })
document.getElementById('btn-login')?.addEventListener('click', () => { void startLogin() })
document.getElementById('btn-cancel-login')?.addEventListener('click', cancelLogin)
document.getElementById('btn-logout')?.addEventListener('click', () => { void logout() })
document.getElementById('btn-settings')?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage()
  window.close()
})

init().catch((err: unknown) => console.error('[Retyc] popup init failed:', err))
