export type MessageType =
  | 'GET_AUTH_STATUS'
  | 'START_LOGIN'
  | 'LOGOUT'
  | 'REFRESH_TOKEN'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'SET_ENABLED'
  | 'GET_COMPOSE_INFO'
  | 'CONFIRM_UPLOAD'
  | 'CANCEL_UPLOAD'
  | 'UPLOAD_PROGRESS'
  | 'UPLOAD_DONE'
  | 'UPLOAD_ERROR'

export interface UserInfo {
  fullName: string | null
  email: string
}

export interface AuthStatusResponse {
  authenticated: boolean
  expiresDays: number
  autoSend: boolean
  enabled: boolean
  userInfo?: UserInfo
  tokenExpiresAt?: number  // Unix seconds
}

export interface SetEnabledPayload {
  enabled: boolean
}

export interface RefreshTokenResponse {
  ok: boolean
  tokenExpiresAt?: number
  error?: string
}

export interface DeviceFlowResponse {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
}

export interface SettingsPayload {
  expiresDays: number
  autoSend: boolean
}

export interface ComposeInfoResponse {
  tabId: number
  attachments: Array<{ id: string; name: string; size: number }>
  recipients: string[]
}

export interface ConfirmUploadPayload {
  tabId: number
  passphrase?: string
}

export type UploadPhase = 'reading' | 'uploading'

export interface UploadProgressPayload {
  tabId: number
  phase: UploadPhase
  fileName: string
  fileIndex: number   // 0-based
  totalFiles: number
  uploadedBytes: number
  totalBytes: number
  ratio: number       // 0..1
}

export interface UploadDonePayload {
  tabId: number
  transferUrl: string
}

export interface UploadErrorPayload {
  tabId: number
  error: string
}

export interface Message<T = unknown> {
  type: MessageType
  payload?: T
}
