import './compose-popup.css'
import type { Message, AuthStatusResponse } from '../shared/messages'

function send<T>(msg: Message): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>
}

function show(id: string): void {
  document.querySelectorAll<HTMLElement>('.state').forEach(el => el.classList.add('hidden'))
  document.getElementById(id)?.classList.remove('hidden')
}

function renderEnabledState(enabled: boolean): void {
  const label = document.getElementById('status-label')!
  const detail = document.getElementById('status-detail')!
  if (enabled) {
    label.textContent = 'Retyc is active and enabled'
    label.className = 'status-label enabled'
    detail.textContent = 'Attachments will be uploaded to Retyc when you send this email.'
    detail.className = 'status-detail'
  } else {
    label.textContent = 'Retyc is active and disabled'
    label.className = 'status-label disabled'
    detail.textContent = 'Attachments will be sent normally — Retyc interception is off.'
    detail.className = 'status-detail disabled'
  }
}

async function init(): Promise<void> {
  show('state-loading')
  try {
    const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
    if (!status.authenticated) {
      show('state-unauth')
      return
    }
    show('state-ready')
    const toggle = document.getElementById('enabled-toggle') as HTMLInputElement
    toggle.checked = status.enabled
    renderEnabledState(status.enabled)
    toggle.addEventListener('change', () => { void onToggleEnabled(toggle) })
  } catch {
    show('state-unauth')
  }
}

async function onToggleEnabled(toggle: HTMLInputElement): Promise<void> {
  const next = toggle.checked
  toggle.disabled = true
  try {
    const result = await send<{ ok: boolean }>({ type: 'SET_ENABLED', payload: { enabled: next } })
    if (!result.ok) {
      // Roll back the visual toggle if persistence failed.
      toggle.checked = !next
      return
    }
    renderEnabledState(next)
  } finally {
    toggle.disabled = false
  }
}

document.getElementById('btn-settings')?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage()
  window.close()
})

document.getElementById('btn-open-popup')?.addEventListener('click', () => {
  // Open the Options page (which hosts the login flow). Chaining popup-from-popup
  // via browserAction.openPopup() is unreliable in Thunderbird — the parent popup
  // closes before the target one can render, so the action silently no-ops.
  void browser.runtime.openOptionsPage()
  window.close()
})

init().catch((err: unknown) => console.error('[Retyc] compose-popup init failed:', err))
