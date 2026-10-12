import { Buffer } from 'buffer'

// The SDK's browser build still relies on a global `Buffer` (Node API) when
// reading file data. This module must be imported before anything that loads
// the SDK.
;(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer
