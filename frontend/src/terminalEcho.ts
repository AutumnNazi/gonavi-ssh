// 本地预测回显：高延迟链路上让按键立即上屏，不等远端 PTY 把字符回传。
//
// 纯 SSH 没有远端屏幕快照（mosh 那种能回滚是因为它自带服务端状态），画错了
// 无法撤销，所以判定必须保守，宁可偶尔不预测，也不能画错：
//   1) 只预测可打印 ASCII（0x20-0x7E）：中文/IME、控制字符（回车、Tab、方向键、
//      Ctrl-C）、粘贴序列一律不预测，交给远端回显；
//   2) 只在远端「安静」时预测：刚有输出的终端可能正在重绘，此时的插入会落到
//      错误位置（这也是 stty -echo 之外最伤的一种错法）；
//   3) 未确认缓冲有上限：远端迟迟不回显（如 read -s 密码输入）时不再继续堆字符；
//   4) 预测与远端回显一旦不一致，清空缓冲并停止预测一小段时间。
//
// 待确认缓冲与「此刻还画不画」是两件事，必须解耦：缓冲只能靠匹配抵消或
// 明确分歧清空，否则远端回显回来就成了双显。
//
// 已知代价：远端本就不回显的输入（read -s 密码、屏幕程序）会被本地画在屏幕上，
// 判定测不出「远端不会回显」这件事，只能靠分歧后的冷静期收敛。

export interface LocalEchoOptions {
  /** 注入时钟（毫秒），便于测试。 */
  now?: () => number
  /** 远端最近有输出的静默窗口；不足此时长不预测。 */
  quietMs?: number
  /** 出现分歧后停止预测的时长。 */
  cooldownMs?: number
  /** 待确认缓冲上限（字符数）。 */
  maxPending?: number
  /** 单次输入串的预测上限（粘贴保护）。 */
  maxPredict?: number
}

export interface LocalEcho {
  /** 用户按键：返回应当立即本地绘制的文本；不该预测时返回空串。 */
  predict(data: string, allowed: boolean): string
  /** 远端输出：抵消已判定的预测，返回真正要写进终端的文本。 */
  consume(remote: string): string
  /** 会话重建/结束：丢弃未判定的预测（新屏幕重新开始）。 */
  reset(): void
  /** 当前待确认的预测内容（测试与排查用）。 */
  pending(): string
}

const DEFAULTS = {
  quietMs: 60,
  cooldownMs: 3000,
  maxPending: 96,
  maxPredict: 32,
}

/** 是否全部为可打印 ASCII（空格到 ~）。 */
function printableAscii(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return data.length > 0
}

export function createLocalEcho(options: LocalEchoOptions = {}): LocalEcho {
  const now = options.now ?? (() => Date.now())
  const quietMs = options.quietMs ?? DEFAULTS.quietMs
  const cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs
  const maxPending = options.maxPending ?? DEFAULTS.maxPending
  const maxPredict = options.maxPredict ?? DEFAULTS.maxPredict

  let settled = 0 // 上次远端输出的时刻
  let cooldownUntil = 0 // 分歧后的冷静期截止时刻
  let pending = '' // 已本地绘制、尚未被远端回显确认的字符

  return {
    predict(data, allowed) {
      if (!allowed || !printableAscii(data) || data.length > maxPredict) return ''
      const at = now()
      if (at < cooldownUntil) return ''
      if (at - settled < quietMs) return ''
      if (pending.length + data.length > maxPending) return ''
      pending += data
      return data
    },

    consume(remote) {
      settled = now()
      // 空分片不改判定；没有未确认预测时远端输出原样放行。
      if (remote === '' || pending === '') return remote
      let i = 0
      while (i < remote.length && i < pending.length && remote[i] === pending[i]) i++
      if (i === pending.length) {
        // 预测被完整回显：屏幕已经画过，远端这段一个字节都不用再写。
        pending = ''
        return remote.slice(i)
      }
      if (i > 0 && i === remote.length) {
        // 远端只回显了预测的前缀（分片）：已确认部分出缓冲，剩下的继续等。
        pending = pending.slice(i)
        return ''
      }
      // 真分歧：剩下的预测远端不会回显了。清空缓冲（否则后续回显会被误抵消），
      // 冷静一会儿不再预测，并把分歧点之后的远端输出照常画出来。
      // 已经画在屏幕上的那截预测无法撤销（纯 SSH 没有远端快照），
      // 只能靠后续远端输出或 Ctrl-L 重绘覆盖。
      pending = ''
      cooldownUntil = now() + cooldownMs
      return remote.slice(i)
    },

    reset() {
      pending = ''
      cooldownUntil = 0
      settled = 0 // 新屏幕不受上一会话的静默窗口限制
    },

    pending: () => pending,
  }
}
