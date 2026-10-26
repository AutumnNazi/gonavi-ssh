const MAX_PENDING_WRITES = 512
const MAX_WRITE_RETRIES = 40

export function createTerminalWriteQueue<T>(write: (item: T, signal: AbortSignal) => Promise<unknown>, warn: () => void) {
  const pending: T[] = []
  let pumping = false
  let stopped = false
  const controller = new AbortController()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resumeRetry: (() => void) | undefined

  function stop() {
    stopped = true
    pending.length = 0
    controller.abort()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    resumeRetry?.()
    resumeRetry = undefined
  }

  async function pump() {
    if (pumping || stopped) return
    pumping = true
    try {
      while (pending.length > 0 && !stopped) {
        // 在途项先移出待发数组，容量拒绝不能动到已接受的输入。
        const item = pending.shift()!
        let failures = 0
        while (!stopped) {
          try {
            await write(item, controller.signal)
            break
          } catch (e) {
            if (stopped) break
            // 只有宿主明确拒绝、尚未发送的请求才能重试同一在途项。
            const code = (e as { code?: unknown })?.code
            if (code === 4101) {
              warn()
              stop()
              return
            }
            if (code !== 'too_many_requests') {
              warn()
              break
            }
            if (++failures > MAX_WRITE_RETRIES) {
              warn()
              stop()
              return
            }
            await new Promise<void>(resolve => {
              resumeRetry = resolve
              retryTimer = setTimeout(resolve, Math.min(100 * failures, 1000))
            })
            retryTimer = undefined
            resumeRetry = undefined
          }
        }
      }
    } finally {
      pumping = false
    }
  }

  return {
    enqueue(item: T): boolean {
      if (stopped || pending.length >= MAX_PENDING_WRITES) {
        warn()
        return false
      }
      pending.push(item)
      void pump()
      return true
    },
    hasWork: () => !stopped && (pumping || pending.length > 0),
    stop,
  }
}
