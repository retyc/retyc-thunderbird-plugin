import type { TokenStore } from '@retyc/sdk'
import type { TokenSet } from '@retyc/sdk'
import { STORAGE_KEY_TOKENS } from '../shared/constants'

export class BrowserStorageTokenStore implements TokenStore {
  async get(): Promise<TokenSet | null> {
    const result = await browser.storage.local.get(STORAGE_KEY_TOKENS)
    const raw: unknown = result[STORAGE_KEY_TOKENS]
    if (!raw || typeof raw !== 'object') return null
    const t = raw as Record<string, unknown>
    if (
      typeof t.accessToken !== 'string' ||
      typeof t.refreshToken !== 'string' ||
      typeof t.expiresAt !== 'number' ||
      typeof t.tokenType !== 'string'
    ) {
      await this.clear()
      return null
    }
    return raw as TokenSet
  }

  async set(tokens: TokenSet): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY_TOKENS]: tokens })
  }

  async clear(): Promise<void> {
    await browser.storage.local.remove(STORAGE_KEY_TOKENS)
  }
}
