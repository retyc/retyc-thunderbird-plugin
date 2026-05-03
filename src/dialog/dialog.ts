import './dialog.css'
import type {
  Message,
  AuthStatusResponse,
  ComposeInfoResponse,
  UploadProgressPayload,
  UploadDonePayload,
  UploadErrorPayload,
} from '../shared/messages'

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

  try {
    const info = await send<ComposeInfoResponse & { error?: string }>({
      type: 'GET_COMPOSE_INFO',
      payload: { tabId },
    })

    if ('error' in info && info.error) {
      showError(info.error)
      return
    }

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
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

async function confirmUpload(): Promise<void> {
  const btnConfirm = document.getElementById('btn-confirm') as HTMLButtonElement
  const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
  btnConfirm.disabled = true
  btnCancel.disabled = true

  const passphraseInput = document.getElementById('passphrase-input') as HTMLInputElement
  const passphrase = passphraseInput.value.trim() || undefined
  passphraseInput.value = '' // Clear from DOM immediately regardless of outcome

  if (passphrase !== undefined && passphrase.length < 8) {
    btnConfirm.disabled = false
    btnCancel.disabled = false
    show('state-confirm')
    showPassphraseError('Passphrase must be at least 8 characters.')
    passphraseInput.focus()
    return
  }

  show('state-uploading')

  try {
    const result = await send<{ ok: boolean; needsPassphrase?: boolean; needsReauth?: boolean; error?: string }>({
      type: 'CONFIRM_UPLOAD',
      payload: { tabId, passphrase },
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
  let el = document.getElementById('passphrase-error')
  if (!el) {
    el = document.createElement('p')
    el.id = 'passphrase-error'
    el.className = 'passphrase-error-msg'
    document.querySelector('.passphrase-block')?.appendChild(el)
  }
  el.textContent = message
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
document.getElementById('btn-toggle-pass')?.addEventListener('click', () => {
  const input = document.getElementById('passphrase-input') as HTMLInputElement
  input.type = input.type === 'password' ? 'text' : 'password'
})

init().catch((err: unknown) => console.error('[Retyc] dialog init failed:', err))
