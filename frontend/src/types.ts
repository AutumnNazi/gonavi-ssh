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
	corruptSecrets?: boolean
	corruptJumps?: boolean
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
  direction: 'upload' | 'download' | 'serverToServer'
  remotePath: string
  localPath: string
  peerConnectionId?: string
  peerPath?: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
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
  /** 终端本地预测回显；缺省（undefined）视为关闭。 */
  localEcho?: boolean
  /** 终端页左侧显示远端文件浏览；缺省（undefined）视为关闭。 */
  showFileTree?: boolean
  /** 终端命令 → 目录的跳转映射：整行输入 #name 并回车，文件浏览跳到 path。 */
  treeCommands?: TreeCommand[]
  /** 文件浏览下载文件的落地目录；缺省（undefined）＝还没挑过。 */
  downloadDir?: string
}

export interface TreeCommand {
  name: string
  path: string
}

export interface TerminalTab {
  tabKey: string
  connectionId: string
  profileId: string
  title: string
  sessionKey?: string
}
