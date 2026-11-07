// 终端输入行的识别：把按键流拼成"当前行"，回车时交给调用方判断。
//
// 用途只有一个——设置里配了「命令 → 目录」映射时，用户整行输入带前缀的
// 命令并回车，文件浏览直接跳到对应目录。识别全在本地做，不依赖远端 shell
// 是否上报，也不需要解析任意命令（只认整行精确匹配，避免把 `cd /tmp` 这类
// 真实目录请求误当成映射）。
//
// 前缀是硬要求：跳转命令不是远端真实存在的命令，不加前缀就等于把用户
// 手打的真命令（`cd`、`ls`、脚本名）也拿去和映射比对，撞名时会把真实
// 执行意图吃掉。加了前缀就不一样——`#` 开头的行远端 bash/zsh 当注释忽略，
// 既不会执行也不会报错，映射没命中时那行发过去也是零副作用。
//
// 只做"够用"的行编辑：退格、Ctrl-C/Ctrl-U 取消、方向键等转义序列丢弃。
// 远端有自己的行编辑（readline/zle），这里只是旁听，不参与编辑语义——
// 认不出来时最多是不跳转，不会影响发出去的输入本身。

// 跳转命令前缀。挑 `#` 是因为远端 bash/zsh 把井号开头的行当注释：用户不打
// 这个前缀就还是普通命令，打了又不巧没配映射时，那行发过去也不会有任何反应。
export const JUMP_PREFIX = '#'

export interface CommandJump {
  /** 配置里的命令名（终端里要带前缀输入，带不带前缀填都认）。 */
  name: string
  /** 命中后文件浏览要跳到的目录。 */
  path: string
}

export interface InputLine {
  /**
   * 喂入一段用户输入（xterm 的 onData 原始字节）。
   * 返回本次提交出来的整行；没有回车则为 null（空行回车返回空串）。
   */
  feed(data: string): string | null
  /** 当前未提交的整行内容（排查与测试用）。 */
  current(): string
  /** 会话重建：丢掉半截行。 */
  reset(): void
}

// 转义序列状态：ESC 之后的内容不进入行缓冲。
const ESC = '\x1b'

export function createInputLine(): InputLine {
  let line = ''
  // 0=正常；1=刚收到 ESC；2=CSI 参数/中间字节中（等终止字节）；3=ESC 后单字节序列
  let escape = 0

  return {
    feed(data) {
      let submitted: string | null = null
      for (const char of data) {
        if (escape === 1) {
          escape = char === '[' ? 2 : 3
          continue
        }
        if (escape === 2) {
          // CSI 终止字节 0x40-0x7E，参数与中间字节继续吞。
          if (char >= '@' && char <= '~') escape = 0
          continue
        }
        if (escape === 3) {
          escape = 0
          continue
        }
        const code = char.codePointAt(0) ?? 0
        if (char === ESC) {
          escape = 1
          continue
        }
        if (char === '\r' || char === '\n') {
          submitted = line
          line = ''
          continue
        }
        if (char === '\x7f' || char === '\b') {
          // 按字符退格：代理对（emoji 等）要整个删掉，不能删一半。
          const chars = [...line]
          chars.pop()
          line = chars.join('')
          continue
        }
        if (char === '\x03' || char === '\x15') {
          // Ctrl-C / Ctrl-U：远端会丢弃这一行，映射也不该命中。
          line = ''
          continue
        }
        if (code < 0x20) continue
        line += char
      }
      return submitted
    },
    current: () => line,
    reset() {
      line = ''
      escape = 0
    },
  }
}

/**
 * 整行（去两侧空白）为「前缀 + 配置的命令名」时给出目录，否则 null。
 * 没有前缀的行一律不认：那可能是用户真的在终端里敲命令。
 */
export function matchCommandJump(submitted: string, jumps: CommandJump[] | undefined): string | null {
  const line = submitted.trim()
  if (!line.startsWith(JUMP_PREFIX)) return null
  const name = line.slice(JUMP_PREFIX.length).trim()
  if (!name || !jumps) return null
  for (const jump of jumps) {
    if (!jump.name || !jump.path) continue
    // 配置里填 `logs` 或 `#logs` 都认——照着设置提示把井号一起填进去太常见了。
    if (jump.name.trim().replace(/^#+\s*/, '') === name) return jump.path
  }
  return null
}
