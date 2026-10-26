// 宿主注入的插件窗口桥：宿主在入口脚本前安装 window.gonaviPlugin，
// 只暴露 invoke/ready/close 三个能力（见 GoNavi sdk.md 的 PluginWindowBridge）。

export interface GonaviPluginIdentity {
  pluginId: string
  version?: string
  generation?: number
}

export interface GonaviPluginBridge {
  ready: Promise<GonaviPluginIdentity>
  invoke(
    commandId: string,
    args?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  /** 原生文件选择（宿主子进程对话框），返回本机绝对路径或 null=取消。 */
  pickFile?(options?: { title?: string }): Promise<string | null>
  /** 原生目录选择。 */
  pickFolder?(options?: { title?: string }): Promise<string | null>
  close(): Promise<void>
}

declare global {
  interface Window {
    gonaviPlugin?: GonaviPluginBridge
  }
}

export function bridge(): GonaviPluginBridge {
  const b = window.gonaviPlugin
  if (!b) {
    throw new Error('宿主桥不可用：请从 GoNavi 插件窗口打开本页面（不能直接在浏览器中访问）')
  }
  return b
}

export async function invokeAs<T>(
  commandId: string,
  args?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return (await bridge().invoke(commandId, args, options)) as T
}

// 插件错误结构（后端 *plugin.Error 的 JSON 形态）。
export interface PluginInvokeError {
  code: number
  message: string
}

export function isPluginError(e: unknown): e is PluginInvokeError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as PluginInvokeError).code === 'number' &&
    typeof (e as PluginInvokeError).message === 'string'
  )
}

export function describeError(e: unknown): string {
  if (isPluginError(e)) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
