// 后端命令响应的类型镜像（见 internal/server）。

export type AuthMethod = 'password' | 'key' | 'agent' | 'none'

export interface JumpView {
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  keyPath?: string
  hasPassword: boolean
  hasPassphrase: boolean
  hasSudoPassword?: boolean
  corruptSecrets?: boolean
}

export interface ProfileView {
  id: string
  name: string
  host: string
  port: number
  user: string
  authMethod: AuthMethod
  keyPath?: string
  jumps?: JumpView[]
  hasPassword: boolean
  hasPassphrase: boolean
}

export type ConnState = 'connecting' | 'needInput' | 'ready' | 'failed' | 'cancelled'

export interface Challenge {
  stage: string
  name: string
  instruction?: string
  prompts: string[]
  echo?: boolean[]
}

export interface ConnectionInfo {
  connectionId: string
  profileId: string
  addr?: string
  state: ConnState
  alive?: boolean
  error?: string
  challenge?: Challenge
  lastActiveMs?: number
}

export interface FsEntry {
  name: string
  path: string
  size: number
  mode: string
  isDir: boolean
  isLink: boolean
  mtime: string
}

export interface TransferStatus {
  id: string
  connectionId: string
  direction: 'upload' | 'download'
  remotePath: string
  localPath: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  bytesDone: number
  totalBytes: number
  error?: string
  rateBps?: number
}

export interface QuickCommand {
  name: string
  command: string
}

export interface PluginSettings {
  readOnly: boolean
  sudoAllowlist: string[]
  readOnlyExecAllowlist?: string[]
  dangerousPatterns?: string[]
  localPathAllowlist?: string[]
  quickCommands: QuickCommand[]
  historyLimit: number
  historyEnabled?: boolean
  cwdFollow?: boolean
}

export interface TerminalTab {
  tabKey: string
  connectionId: string
  profileId: string
  title: string
  sessionKey?: string
}
