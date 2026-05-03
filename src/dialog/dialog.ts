import '../shared/common.css'
import './dialog.css'
import { DEFAULT_EXPIRES_SECONDS } from '../shared/constants'
import type {
  Message,
  AuthStatusResponse,
  ComposeInfoResponse,
  UploadCapabilitiesResponse,
  UploadProgressPayload,
  UploadDonePayload,
  UploadErrorPayload,
} from '../shared/messages'

interface ExpiryOption { label: string; value: number }

const EXPIRY_OPTIONS: readonly ExpiryOption[] = [
  { label: '1 hour',   value: 3600 },
  { label: '12 hours', value: 43200 },
  { label: '1 day',    value: 86400 },
  { label: '3 days',   value: 259200 },
  { label: '7 days',   value: 604800 },
  { label: '30 days',  value: 2592000 },
  { label: '90 days',  value: 7776000 },
  { label: '1 year',   value: 31536000 },
] as const

function send<T>(msg: Message): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>
}

function show(id: string): void {
  document.querySelectorAll<HTMLElement>('.state').forEach(el => el.classList.add('hidden'))
  document.getElementById(id)?.classList.remove('hidden')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function getTabId(): number {
  const params = new URLSearchParams(window.location.search)
  const id = params.get('tabId')
  if (!id) throw new Error('Missing tabId in dialog URL.')
  const n = parseInt(id, 10)
  if (!Number.isFinite(n)) throw new Error('Invalid tabId in dialog URL.')
  return n
}

async function closeDialog(): Promise<void> {
  const win = await browser.windows.getCurrent()
  if (win.id) browser.windows.remove(win.id).catch(() => {})
}

let tabId: number

// Listen for progress/done/error from background (registered once, at top-level).
browser.runtime.onMessage.addListener((rawMsg: unknown) => {
  const msg = rawMsg as Message
  if (!msg.payload) return

  if (msg.type === 'UPLOAD_PROGRESS') {
    const p = msg.payload as UploadProgressPayload
    if (p.tabId !== tabId) return
    const fill = document.getElementById('progress-fill')!
    const status = document.getElementById('upload-status')!
    fill.classList.remove('indeterminate')
    if (p.phase === 'reading') {
      status.textContent = `Reading "${p.fileName}" (${p.fileIndex + 1}/${p.totalFiles})…`
      fill.style.width = '2%'
    } else {
      status.textContent =
        `Uploading "${p.fileName}" (${p.fileIndex + 1}/${p.totalFiles}) — ` +
        `${formatSize(p.uploadedBytes)} / ${formatSize(p.totalBytes)}`
      fill.style.width = `${Math.round(p.ratio * 100)}%`
    }
  }

  if (msg.type === 'UPLOAD_DONE') {
    const p = msg.payload as UploadDonePayload
    if (p.tabId !== tabId) return
    document.getElementById('progress-fill')!.style.width = '100%'
    show('state-done')
  }

  if (msg.type === 'UPLOAD_ERROR') {
    const p = msg.payload as UploadErrorPayload
    if (p.tabId !== tabId) return
    showError(p.error)
  }
})

function showError(message: string): void {
  document.getElementById('error-message')!.textContent = message
  show('state-error')
}

// Returns false when the API limit is shorter than our shortest preset — in that
// case the dialog should refuse to upload rather than fabricate an invalid option.
function populateExpirySelect(maxExpiration: number | null): boolean {
  const select = document.getElementById('expiry-select') as HTMLSelectElement
  const options = maxExpiration == null
    ? [...EXPIRY_OPTIONS]
    : EXPIRY_OPTIONS.filter(o => o.value <= maxExpiration)

  if (options.length === 0) return false

  select.innerHTML = ''
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = String(opt.value)
    el.textContent = opt.label
    select.appendChild(el)
  }

  // Default to 7 days when allowed; otherwise pick the longest available option.
  const desired = options.find(o => o.value === DEFAULT_EXPIRES_SECONDS)?.value
    ?? options[options.length - 1].value
  select.value = String(desired)
  return true
}

function showMaxSizeHint(maxShareSize: number | null): void {
  if (maxShareSize == null) return
  const hint = document.getElementById('max-size-hint')!
  hint.textContent = `(max ${formatSize(maxShareSize)})`
  hint.classList.remove('hidden')
}

function showSizeOverLimit(totalBytes: number, maxShareSize: number): void {
  const banner = document.getElementById('size-over-limit')!
  banner.textContent =
    `Total attachment size (${formatSize(totalBytes)}) exceeds your account limit ` +
    `of ${formatSize(maxShareSize)}. Remove some attachments and try again.`
  banner.classList.remove('hidden')
  ;(document.getElementById('btn-confirm') as HTMLButtonElement).disabled = true
}

async function init(): Promise<void> {
  show('state-loading')

  try {
    tabId = getTabId()
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    return
  }

  // Adapt confirm button label to the current auto-send setting.
  try {
    const status = await send<AuthStatusResponse>({ type: 'GET_AUTH_STATUS' })
    const btn = document.getElementById('btn-confirm')!
    btn.textContent = status.autoSend ? 'Upload & Send' : 'Upload'
  } catch { /* keep default label */ }

  // Fetch compose info and capabilities in parallel. Capabilities are tolerant of
  // failure (we keep the full preset list), but compose info is required.
  let info: ComposeInfoResponse & { error?: string }
  let caps: (UploadCapabilitiesResponse & { error?: string }) | null
  try {
    [info, caps] = await Promise.all([
      send<ComposeInfoResponse & { error?: string }>({
        type: 'GET_COMPOSE_INFO',
        payload: { tabId },
      }),
      send<UploadCapabilitiesResponse & { error?: string }>({ type: 'GET_UPLOAD_CAPABILITIES' })
        .catch(() => null),
    ])
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    return
  }

  if ('error' in info && info.error) {
    showError(info.error)
    return
  }

  const maxExpiration = caps && !('error' in caps && caps.error) ? caps.maxShareExpirationTime : null
  const maxShareSize  = caps && !('error' in caps && caps.error) ? caps.maxShareSize : null

  if (!populateExpirySelect(maxExpiration)) {
    showError(
      'Your Retyc account does not allow shares with the available expiry presets. ' +
      'Please contact your administrator.',
    )
    return
  }
  showMaxSizeHint(maxShareSize)

  // Render recipients
  document.getElementById('recipients')!.textContent =
    info.recipients.length > 0 ? info.recipients.join(', ') : '(no recipients)'

  // Render file list
  const list = document.getElementById('file-list')!
  list.innerHTML = ''
  for (const att of info.attachments) {
    const li = document.createElement('li')
    li.className = 'file-item'
    const nameSpan = document.createElement('span')
    nameSpan.className = 'file-name'
    nameSpan.textContent = att.name
    const sizeSpan = document.createElement('span')
    sizeSpan.className = 'file-size'
    sizeSpan.textContent = formatSize(att.size)
    li.appendChild(nameSpan)
    li.appendChild(sizeSpan)
    list.appendChild(li)
  }

  show('state-confirm')

  // Client-side size guard so the user cannot start an upload that the API will
  // reject. The background re-validates as a defence in depth.
  const totalBytes = info.attachments.reduce((sum, a) => sum + a.size, 0)
  if (maxShareSize != null && totalBytes > maxShareSize) {
    showSizeOverLimit(totalBytes, maxShareSize)
  }
}

async function confirmUpload(): Promise<void> {
  const btnConfirm = document.getElementById('btn-confirm') as HTMLButtonElement
  const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
  btnConfirm.disabled = true
  btnCancel.disabled = true

  const usePassphraseEl = document.getElementById('use-passphrase') as HTMLInputElement
  const passphraseInput = document.getElementById('passphrase-input') as HTMLInputElement
  const expirySelect = document.getElementById('expiry-select') as HTMLSelectElement

  const wantsPassphrase = usePassphraseEl.checked
  const passphraseRaw = passphraseInput.value.trim()
  passphraseInput.value = '' // Clear from DOM immediately regardless of outcome

  const expirySeconds = parseInt(expirySelect.value, 10)
  // The select is always populated with valid presets, so this is purely defensive.
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) {
    showError('Invalid expiry duration. Please reopen the dialog.')
    return
  }

  let passphrase: string | undefined
  if (wantsPassphrase) {
    if (passphraseRaw.length < 8) {
      btnConfirm.disabled = false
      btnCancel.disabled = false
      show('state-confirm')
      showPassphraseError('Passphrase must be at least 8 characters.')
      passphraseInput.focus()
      return
    }
    passphrase = passphraseRaw
  }

  show('state-uploading')

  try {
    const result = await send<{ ok: boolean; needsPassphrase?: boolean; needsReauth?: boolean; error?: string }>({
      type: 'CONFIRM_UPLOAD',
      payload: { tabId, expirySeconds, passphrase },
    })

    if (!result.ok) {
      if (result.needsReauth) {
        show('state-reauth')
        return
      }
      if (result.needsPassphrase) {
        // Go back to confirm state so the user can enter a passphrase and retry.
        show('state-confirm')
        btnConfirm.disabled = false
        btnCancel.disabled = false
        // Force the toggle on so the input is visible for retry.
        usePassphraseEl.checked = true
        togglePassphraseBlock()
        showPassphraseError(result.error ?? 'A passphrase is required.')
        passphraseInput.focus()
      } else if (result.error) {
        showError(result.error)
      }
    }
    // On success, background broadcasts UPLOAD_DONE and closes this window.
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

function showPassphraseError(message: string): void {
  const el = document.getElementById('passphrase-error')!
  el.textContent = message
  el.classList.remove('hidden')
  ;(document.getElementById('passphrase-input') as HTMLInputElement)
    .setAttribute('aria-invalid', 'true')
}

function clearPassphraseError(): void {
  const el = document.getElementById('passphrase-error')
  if (!el) return
  el.textContent = ''
  el.classList.add('hidden')
  ;(document.getElementById('passphrase-input') as HTMLInputElement)
    .removeAttribute('aria-invalid')
}

function togglePassphraseBlock(): void {
  const usePassphraseEl = document.getElementById('use-passphrase') as HTMLInputElement
  const block = document.getElementById('passphrase-block')!
  const input = document.getElementById('passphrase-input') as HTMLInputElement
  if (usePassphraseEl.checked) {
    block.classList.remove('hidden')
    input.focus()
  } else {
    block.classList.add('hidden')
    input.value = ''
    clearPassphraseError()
  }
}

async function cancelUpload(): Promise<void> {
  try {
    await send({ type: 'CANCEL_UPLOAD', payload: { tabId } })
  } catch { /* best effort */ }
  await closeDialog()
}

document.getElementById('btn-confirm')?.addEventListener('click', () => { void confirmUpload() })
document.getElementById('btn-cancel')?.addEventListener('click', () => { void cancelUpload() })
document.getElementById('btn-close-error')?.addEventListener('click', () => { void cancelUpload() })
document.getElementById('btn-close-reauth')?.addEventListener('click', () => { void closeDialog() })
document.getElementById('btn-open-settings')?.addEventListener('click', () => {
  void browser.runtime.openOptionsPage()
  void closeDialog()
})
document.getElementById('btn-toggle-pass')?.addEventListener('click', (e) => {
  const input = document.getElementById('passphrase-input') as HTMLInputElement
  const btn = e.currentTarget as HTMLButtonElement
  const showing = input.type === 'text'
  // Flip state.
  input.type = showing ? 'password' : 'text'
  btn.setAttribute('aria-pressed', String(!showing))
  btn.setAttribute('aria-label', showing ? 'Show passphrase' : 'Hide passphrase')
})
document.getElementById('use-passphrase')?.addEventListener('change', togglePassphraseBlock)
document.getElementById('passphrase-input')?.addEventListener('input', clearPassphraseError)

init().catch((err: unknown) => console.error('[Retyc] dialog init failed:', err))
