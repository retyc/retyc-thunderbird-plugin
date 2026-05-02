import { RetycSDK } from '@retyc/sdk'
import { BrowserStorageTokenStore } from './token-store'

declare const __RETYC_API_URL__: string

const _store = new BrowserStorageTokenStore()
let _sdk: RetycSDK | null = null

export async function getSDK(): Promise<RetycSDK> {
  if (_sdk) return _sdk
  const sdk = new RetycSDK({ apiUrl: __RETYC_API_URL__, tokenStore: _store })
  // Preload OIDC config so token refresh works immediately after extension reload,
  // even if startDeviceFlow was never called in this session.
  await sdk.preload()
  _sdk = sdk
  return _sdk
}

export function invalidateSDK(): void {
  _sdk = null
}
