// 终端读取中枢：窗口内所有终端标签共用一条 terminal.readMulti 长轮询。
//
// 原因：宿主的插件窗口桥只允许 8 个在途调用（超出的立即回 too_many_requests），
// 而每个标签的长轮询要占满 20 秒。标签开到 8 个左右额度就被读占完，按键写入
// 被反复拒绝，输入开始卡顿甚至丢键。合并成一条读取循环后，标签数量不再影响
// 写入额度；某会话有输出时批量调用立即返回，各标签的实时性也不受影响。
import { invokeAs } from './bridge'

/** 批量读返回的单会话事件，字段与后端 terminal.readMulti 对齐。 */
interface ReadEvent {
  sessionKey: string
  dataBase64?: string
  eof?: boolean
  hasExit?: boolean
  exitCode?: number
}

export interface TerminalReadSink {
  /** 原始 base64 分片：由调用方用自己的流解码器解码，避免跨会话串码。 */
  onData(dataBase64: string): void
  /** 会话结束（已取空尾部输出）：此后不再有该会话的事件。 */
  onEnd(hasExit: boolean, exitCode?: number): void
  /** 连续失败到放弃：调用方展示错误并停止输入。 */
  onUnavailable(error: unknown): void
}

const READ_MAX_BYTES = 65536
const WAIT_MILLIS = 20000
// 瞬时错误（桥忙/超时）退避重试；连续失败才放弃，与单标签轮询时的策略一致。
const RETRY_MAX = 8
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 5000

const sinks = new Map<string, Set<TerminalReadSink>>()
// ended 记录已报 eof 的会话：不能再出现在后续请求里，否则宿主立刻回同一个
// eof，循环变成忙等（每次都要占一个在途调用）。
const ended = new Set<string>()
let running = false
// 在途批次：新会话加入时要打断它重发，否则新标签得等这次长轮询返回
// （最长 20 秒）才可能拿到第一屏输出。
let inFlight: { controller: AbortController; sessionKeys: string[] } | undefined

/**
 * 订阅一个终端会话的输出。返回退订函数；同一会话可以挂多个订阅者
 * （标签重建的短暂重叠期会同时存在两个）。
 */
export function subscribeTerminalRead(sessionKey: string, sink: TerminalReadSink): () => void {
  let listeners = sinks.get(sessionKey)
  if (!listeners) {
    listeners = new Set()
    sinks.set(sessionKey, listeners)
  }
  listeners.add(sink)
  // 重建同一会话（sessionKey 唯一，仅在测试里遇到）时允许重新读取。
  ended.delete(sessionKey)
  const flight = inFlight
  if (flight && !flight.sessionKeys.includes(sessionKey)) flight.controller.abort()
  void pump()
  return () => {
    const current = sinks.get(sessionKey)
    if (!current) return
    current.delete(sink)
    if (current.size === 0) sinks.delete(sessionKey)
  }
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  let retries = 0
  try {
    while (sinks.size > 0) {
      const sessionKeys = [...sinks.keys()].filter(key => !ended.has(key))
      if (sessionKeys.length === 0) break
      const controller = new AbortController()
      inFlight = { controller, sessionKeys }
      try {
        const res = await invokeAs<{ events?: ReadEvent[] }>('terminal.readMulti', {
          sessionKeys,
          maxBytes: READ_MAX_BYTES,
          waitMillis: WAIT_MILLIS,
        }, { signal: controller.signal })
        retries = 0
        for (const event of res?.events ?? []) deliver(event)
      } catch (e) {
        // 自己打断的调用不是故障：立刻带上新的会话集合重发（数据仍在
        // 插件侧缓冲里，不会丢）。
        if (controller.signal.aborted) continue
        if (retries >= RETRY_MAX) {
          failAll(e)
          break
        }
        await delay(Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_CAP_MS))
        retries++
      } finally {
        if (inFlight?.controller === controller) inFlight = undefined
      }
    }
  } finally {
    running = false
  }
}

function deliver(event: ReadEvent): void {
  const listeners = sinks.get(event.sessionKey)
  if (!listeners || listeners.size === 0) return
  // 回调里可能退订或再订阅，先快照再派发。
  const targets = [...listeners]
  if (event.dataBase64) {
    for (const sink of targets) sink.onData(event.dataBase64)
  }
  if (event.eof) {
    ended.add(event.sessionKey)
    for (const sink of targets) sink.onEnd(!!event.hasExit, event.exitCode)
  }
}

// 桥连续不可用：全体终端一起停下并报错，而不是无声重试。
function failAll(error: unknown): void {
  const targets = [...sinks.values()].flatMap(listeners => [...listeners])
  sinks.clear()
  for (const sink of targets) sink.onUnavailable(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
