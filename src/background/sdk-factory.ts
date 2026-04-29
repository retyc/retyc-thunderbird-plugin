import { RetycSDK } from '@retyc/sdk'
import { BrowserStorageTokenStore } from './token-store'
import { DEFAULT_API_URL, STORAGE_KEY_API_URL } from '../shared/constants'

let _sdk: RetycSDK | null = null
let _currentApiUrl: string | null = null
const _store = new BrowserStorageTokenStore()

export async function getSDK(): Promise<RetycSDK> {
  const apiUrl = await getApiUrl()
  if (_sdk && _currentApiUrl === apiUrl) return _sdk

  const sdk = new RetycSDK({ apiUrl, tokenStore: _store })
  // Pre-load OIDC config so token refresh works immediately after extension reload,
  // even if startDeviceFlow was never called in this session.
  await sdk.preload()
  _sdk = sdk
  _currentApiUrl = apiUrl
  return _sdk
}

export async function getApiUrl(): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEY_API_URL)
  return (result[STORAGE_KEY_API_URL] as string | undefined) ?? DEFAULT_API_URL
}

export function invalidateSDK(): void {
  _sdk = null
  _currentApiUrl = null
}
