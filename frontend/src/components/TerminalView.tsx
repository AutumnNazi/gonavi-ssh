import { useEffect, useRef, useState } from 'react'
import { Dropdown, Switch, Tag, Tooltip, message } from 'antd'
import { CodeOutlined, CopyOutlined, DownOutlined, SnippetsOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invokeAs, describeError } from '../bridge'
import { encodeText, createStreamDecoder } from '../b64'
import { createTerminalWriteQueue } from '../terminalWriteQueue'
import { createLocalEcho } from '../terminalEcho'
import { createEchoRedactor } from '../terminalRedact'
import { createInputLine, matchCommandJump, type CommandJump } from '../terminalCommandJump'
import { quoteShellArg } from '../fsFormat'
import { subscribeTerminalRead } from '../terminalReadHub'
import { t } from '../i18n'
import { hostPrefs, subscribeHostPrefs } from '../hostPrefs'
import { terminalOptions } from '../terminalTheme'
import type { QuickCommand, TerminalTab } from '../types'

interface WriteRequest {
  command: 'terminal.write' | 'terminal.writeMulti'
  args: { sessionKey?: string; sessionKeys?: string[]; dataBase64: string }
}

// OSC 7（shell 工作目录通知）：xterm 输出流里匹配 file://host/path，
// 需用户在远端 shell 配置 PROMPT_COMMAND 才会发。
const osc7Re = /\x1b\]7;file:\/\/[^\x07\x1b\/]*([^\x07\x1b]*?)((\x1b\\)|\x07)/g

interface Props {
  tab: TerminalTab
  allTabs: TerminalTab[]
  /** 终端 cd 后回调当前远端目录（OSC7），供文件面板跟随。 */
  onCwd: (path: string) => void
  /** 命中了设置里的「命令 → 目录」映射：让文件浏览跳到该目录。 */
  onJump: (path: string) => void
  /**
   * 目录跟随：打开时向远端 shell 注入 OSC7 上报钩子。
   * 由上层给定（跟随开关 × 文件浏览是否显示）——面板收起来就没东西可跟随，
   * 不该还往远端注入。
   */
  followCwd: boolean
  /** 设置项由上层推下来（不是终端自己去拉一次）：改完设置当场生效，不用重开终端。 */
  quickCommands: QuickCommand[]
  /** 本地预测回显开关；缺省（undefined）视为关闭。 */
  localEcho?: boolean
  /** 「命令 → 目录」跳转映射。 */
  treeCommands: CommandJump[]
}

const INPUT_WARNING_INTERVAL_MS = 1500

// 注入 OSC7 钩子分两步（见下面的注入 effect）：先写一行 `read -s`，让远端把下一行
// 当「不回显的输入」读走，再把钩子交给它。会回显的只有这行 read，它短得远不到终端
// 宽度、不会触发远端行编辑器的折行重绘，逐字节的消除吃得准；钩子本身到远端时内核
// 已经关掉回显，屏幕上根本不会有它。
const INJECT_HOOK_FN = '__g7'
const INJECT_HOOK_VAR = '__gn'
// read -s 是 shell 内置的静默读：它自己关掉这个会话的回显、读完就还回去，
// 不改远端任何设置。case 只认我们自己注入的那行——用户抢先敲的字被 read 读走时
// 绝不 eval 他的半截命令。
const INJECT_READER =
  `read -rs ${INJECT_HOOK_VAR};case "$${INJECT_HOOK_VAR}" in ${INJECT_HOOK_FN}*)eval "$${INJECT_HOOK_VAR}";;esac;unset ${INJECT_HOOK_VAR}`
// 要交给远端 shell 执行的那行。shell 收到的是字面 "\033"（printf 自行解释为 ESC）；
// 整行用单引号串拼接，因为 ${PROMPT_COMMAND:+...} 是远端 shell 的展开式，写成 JS
// 模板字符串会被本地插值吞掉。
// 把注入用的那行 read 从远端命令历史里删掉。
//
// 绕了几圈才落到这个写法，走过的坑都记在这儿：
//   1. `history -d -1`：负数 offset 是 bash 4.3 才有的，CentOS 7 那代（4.2）直接
//      报错；错误又被 2>/dev/null 吞掉，成了不留痕迹的静默失败。
//   2. `$(history | awk ...)`：命令替换开的是非交互子 shell，那里的 history 是
//      空的，永远取不到编号。
//   3. `$HISTCMD`：新版 bash 上够用，但它取的是「当前命令行」的语义，老版本行为
//      没把握，不值得赌。
// 所以先把 history 落到临时文件——读文件不受子 shell 限制——再从里面按内容找出
// 最后一条的编号，用正数删除，不依赖任何版本特性。
const BASH_HISTORY_CLEANUP =
  'f=$(mktemp 2>/dev/null||echo /tmp/.g7$$);history>"$f" 2>/dev/null;' +
  'n=$(awk \'index($0,"read -rs __gn"){v=$1}END{print v}\' "$f" 2>/dev/null);' +
  'rm -f "$f";[ -n "$n" ]&&history -d "$n" 2>/dev/null'
const OSC7_HOOK =
  '__g7(){ printf \'\\033]7;file://%s%s\\033\\\\\' "$(hostname)" "$PWD"; }; ' +
  'if [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND="__g7;${PROMPT_COMMAND:+$PROMPT_COMMAND;}"; ' +
  'elif [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __g7; fi; ' +
  // 第一步那行 read 是当着用户的面敲进远端 shell 的，会被记进命令历史——按 ↑ 翻得到，
  // 共享同一账号的人同样看得见。此刻它还是最后一条，顺手删掉：插件在别人的 shell 里
  // 不该留痕。删不删得掉都不影响后面的事，失败就算了。
  'if [ -n "$BASH_VERSION" ]; then ' + BASH_HISTORY_CLEANUP + '; ' +
  'elif [ -n "$ZSH_VERSION" ]; then fc -d -1 2>/dev/null; fi'
// 第一笔等 shell 启动窗口过去；第二笔隔 INJECT_GAP_MS 发出，远端收到时也隔了这么久
// （同一连接顺序保序），足够它把 read 跑起来——与链路往返时延无关。
const INJECT_DELAY_MS = 800
const INJECT_GAP_MS = 300
// reader 已经发出、但钩子因为"用户抢先打字"而没送出去时的收尾：reader 那行是当着
// 用户敲进远端 shell 的，不补一刀就一直留在他的命令历史里。以 __g7 开头是为了让
// reader 的 case 认它——那条白名单只放行这个前缀。它同样被 read 读走，所以自己不
// 会产生新的历史条目。
const INJECT_CLEANUP =
  '__g7=;if [ -n "$BASH_VERSION" ]; then ' + BASH_HISTORY_CLEANUP + '; ' +
  'elif [ -n "$ZSH_VERSION" ]; then fc -d -1 2>/dev/null; fi'


// 终端视图：sessionKey 由上层创建，这里只负责 xterm 渲染、长轮询、
// 输入写入（可广播到同连接其他会话）与快捷命令。
// xterm 生命周期 effect 只依赖 sessionKey：广播目标与回调经 ref 传递，
// 避免任何无关状态变化销毁重建终端实例。
export function TerminalView({
  tab,
  allTabs,
  onCwd,
  onJump,
  followCwd,
  quickCommands,
  localEcho,
  treeCommands,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [status, setStatus] = useState<'running' | 'closed' | 'error'>('running')
  const inputStateRef = useRef<'running' | 'closed' | 'error'>('running')
  const [detail, setDetail] = useState('')
  const [broadcast, setBroadcast] = useState(false)
  const sessionKey = tab.sessionKey ?? ''

  // 广播目标与写入队列放 ref：不进 effect 依赖。
  const broadcastRef = useRef(false)
  const allTabsRef = useRef(allTabs)
  const onCwdRef = useRef(onCwd)
  const onJumpRef = useRef(onJump)
  const writeQueueRef = useRef<ReturnType<typeof createTerminalWriteQueue<WriteRequest>> | null>(null)
  // 本地预测回显：按键先画上屏，远端回显回来再抵消（见 terminalEcho.ts）。
  // 实例随组件存活，会话重建时 reset，不能跟着 sessionKey 之外的依赖走。
  const echoRef = useRef<ReturnType<typeof createLocalEcho> | null>(null)
  if (!echoRef.current) echoRef.current = createLocalEcho()
  // 注入起头那行 read 的回显消除（见 terminalRedact.ts）：远端会把敲进去的整行吐回来。
  const redactRef = useRef<ReturnType<typeof createEchoRedactor> | null>(null)
  if (!redactRef.current) redactRef.current = createEchoRedactor()
  // 设置项缺省为关：本地回显会跟远端回显抢屏幕，没开过的用户不该看到差别。
  const localEchoRef = useRef(false)
  // 跳转命令识别：旁听输入行，整行命中 #前缀 映射时通知上层（不参与远端行编辑）。
  const lineRef = useRef<ReturnType<typeof createInputLine> | null>(null)
  if (!lineRef.current) lineRef.current = createInputLine()
  const jumpsRef = useRef<CommandJump[]>([])
  const nextInputWarningRef = useRef(0)
  // 会话建立后用户在终端里敲过东西没有。注入钩子要避开他正在敲的整行——
  // 注入的字节会跟他的半截命令拼成一条，远端拿去执行的就是谁也没写过的命令。
  const userTypingRef = useRef(false)
  // 写入侧彻底失败（会话结束或桥不可用）后终端已定格在提示层上，
  // 由 effect 注入退订函数，别让中枢继续为它占着桥额度。
  const stopReadingRef = useRef<() => void>(() => {})
  broadcastRef.current = broadcast
  allTabsRef.current = allTabs
  onCwdRef.current = onCwd
  onJumpRef.current = onJump
  // 这两个在 onData 的闭包里读：闭包捕获的是建立时的值，必须每渲染同步一次，
  // 否则用户改完设置得重开终端才生效。
  // 只有明确打开才预测：字段缺失＝老设置文件／没开过，按关闭处理。
  localEchoRef.current = localEcho === true
  jumpsRef.current = treeCommands ?? []

  const targets = () =>
    broadcastRef.current
      ? allTabsRef.current
          .filter(x => x.connectionId === tab.connectionId && x.sessionKey && x.tabKey !== tab.tabKey)
          .map(x => x.sessionKey!)
      : []

  const warnInputDropped = (reason?: 'ended' | 'unavailable') => {
    if (reason) {
      // 输入已经不可用：读取也没有意义了（会话结束或桥不再接受调用）。
      stopReadingRef.current()
      const state = reason === 'ended' ? 'closed' : 'error'
      inputStateRef.current = state
      setStatus(state)
      setDetail(t(reason === 'ended' ? 'term.ended' : 'term.inputUnavailable'))
    }
    const now = Date.now()
    if (now < nextInputWarningRef.current) return
    nextInputWarningRef.current = now + INPUT_WARNING_INTERVAL_MS
    const key = inputStateRef.current === 'closed' ? 'term.inputClosed'
      : inputStateRef.current === 'error' ? 'term.inputUnavailable' : 'term.inputDropped'
    message.warning(t(key))
  }

  // 请求与广播目标入队时固定；重试不会改变在途项或重复发送已知结果。
  // fromUser 区分「用户自己敲/点的」与「插件自己注入的」：只有前者的存在会让
  // 注入让路。
  const enqueueWrite = (data: string, fromUser = true) => {
    if (fromUser) userTypingRef.current = true
    if (inputStateRef.current !== 'running') { warnInputDropped(); return false }
    const queue = writeQueueRef.current
    if (!queue) {
      warnInputDropped()
      return false
    }
    const keys = [sessionKey, ...targets()]
    const args = keys.length > 1
      ? { sessionKeys: keys, dataBase64: encodeText(data) }
      : { sessionKey, dataBase64: encodeText(data) }
    return queue.enqueue({ command: keys.length > 1 ? 'terminal.writeMulti' : 'terminal.write', args })
  }

  const copySelection = async (action?: HTMLElement) => {
    const term = termRef.current
    const host = hostRef.current
    const text = term?.getSelection()
    if (!term || !host || !text || !host.getClientRects().length) return
    const focusAtStart = document.activeElement
    const isCurrent = () => termRef.current === term && hostRef.current === host && !!host.getClientRects().length
    try {
      await navigator.clipboard.writeText(text)
      if (isCurrent()) message.success(t('term.copied'))
    } catch {
      if (isCurrent()) message.error(t('term.copyFailed'))
    } finally {
      // 复制等待期间关闭/切换终端或转去其他输入框时，不再恢复旧焦点。
      if (isCurrent() && document.activeElement === focusAtStart &&
        (host.contains(focusAtStart) || (action !== undefined && focusAtStart === action))) term.focus()
    }
  }

  const pasteClipboard = async (action?: HTMLElement) => {
    if (inputStateRef.current !== 'running') { warnInputDropped(); return }
    const term = termRef.current
    const host = hostRef.current
    const queue = writeQueueRef.current
    if (!term || !host || !queue || !host.getClientRects().length) return
    const focusAtStart = document.activeElement
    const keys = [sessionKey, ...targets()]
    const isCurrent = () => inputStateRef.current === 'running' && termRef.current === term && hostRef.current === host &&
      writeQueueRef.current === queue && !!host.getClientRects().length
    try {
      const text = await navigator.clipboard.readText()
      if (text && isCurrent()) {
        // 粘贴走的是队列直连（不经过 enqueueWrite），这里补记用户输入。
        userTypingRef.current = true
        queue.enqueue({
          command: keys.length > 1 ? 'terminal.writeMulti' : 'terminal.write',
          args: keys.length > 1 ? { sessionKeys: keys, dataBase64: encodeText(text) } : { sessionKey, dataBase64: encodeText(text) },
        })
      }
    } catch {
      if (isCurrent()) message.error(t('term.pasteFailed'))
    } finally {
      if (isCurrent() && document.activeElement === focusAtStart &&
        (host.contains(focusAtStart) || (action !== undefined && focusAtStart === action))) term.focus()
    }
  }

  useEffect(() => {
    if (!sessionKey) return
    let stopped = false
    inputStateRef.current = 'running'
    // 新会话的屏幕从零开始：上一会话没等到回显的预测必须作废，
    // 否则新屏幕会把旧预测的字符当成自己的回显抵消掉。
    echoRef.current!.reset()
    redactRef.current!.reset()
    lineRef.current!.reset()
    injectedRef.current = false
    userTypingRef.current = false
    setStatus('running')
    setDetail('')
    const writeQueue = createTerminalWriteQueue<WriteRequest>(
      (item, signal) => invokeAs(item.command, item.args, { signal }),
      reason => {
        if (!stopped && writeQueueRef.current === writeQueue) warnInputDropped(reason)
      },
    )
    writeQueueRef.current = writeQueue
    const decodeChunk = createStreamDecoder()

    const term = new Terminal({
      ...terminalOptions(hostPrefs),
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    const unsubscribePrefs = subscribeHostPrefs(prefs => {
      const options = terminalOptions(prefs)
      const metricsChanged = term.options.fontFamily !== options.fontFamily || term.options.fontSize !== options.fontSize
      term.options.theme = options.theme
      term.options.fontFamily = options.fontFamily
      term.options.fontSize = options.fontSize
      if (metricsChanged && hostRef.current?.getClientRects().length) fit.fit()
    })
    setHasSelection(false)
    const selectionSub = term.onSelectionChange(() => setHasSelection(!!term.getSelection()))
    term.attachCustomKeyEventHandler(event => {
      const copyKey = event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c'
      if (!copyKey || (!event.shiftKey && !term.getSelection())) return true
      if (event.type === 'keydown') {
        event.preventDefault()
        void copySelection()
      }
      return false
    })

    // 本地预测回显的水龙头：设置里关掉、广播模式下都不绘制（广播时同一
    // 击键进多个会话，本地画的那一份无从抵消）。输入态与“送不送得出去”
    // 由下一步的 accepted 管，这里不重复判定。
    const canPredict = () => localEchoRef.current && !broadcastRef.current
    // 高延迟链路上按键先画上屏，不等远端回显；但必须“先入队、接受了才画”
    // ——没送出去的输入远端永远不会回显，画上屏就是错字。不可打印字符、
    // 远端刚有输出、刚分歧过等判定都在 terminalEcho.ts 里。
    const dataSub = term.onData(d => {
      // 先本地解析这一笔（纯计算，无副作用），好决定到底往远端发什么。
      //
      // 不能先把回车发出去、再补一条 cd：两次写入之间有个缝隙，补的 cd 会和远端
      // 打印新提示符赛跑。cd 跑赢了，内核就先把它回显一次（此时提示符还没打印），
      // readline 打印提示符时又把它重绘一次——屏幕上凭空多出一行没头没尾的 cd。
      const submitted = lineRef.current!.feed(d)
      const jump = submitted !== null ? matchCommandJump(submitted, jumpsRef.current) : null
      // 命中跳转：把用户打的这行换掉。Ctrl-U 抹掉远端行编辑器里已经敲进去的那些
      // 字符（它们照常发过去了，屏幕上也显示着），紧接着执行 cd，一次发完；井号那行
      // 本来也只是条注释，没送到远端也不损失什么。
      const payload = jump ? `\x15cd ${quoteShellArg(jump)}\r` : d
      const accepted = enqueueWrite(payload)
      if (accepted) {
        const drawn = echoRef.current!.predict(d, canPredict())
        if (drawn) term.write(drawn)
        if (jump) onJumpRef.current(jump)
      }
      // 返回值即"这次输入是否被接受"（xterm 本身不用它，用例据此判断拒绝路径）。
      return accepted
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      invokeAs('terminal.resize', { sessionKey, cols, rows }).catch(() => {})
    })
    let wasVisible = !!hostRef.current?.getClientRects().length
    // 尺寸不变的重复通知无需 fit；同一帧内的尺寸变化合并处理。
    let lastFitWidth = 0
    let lastFitHeight = 0
    let fitPending = false
    const observer = new ResizeObserver(() => {
      const el = hostRef.current
      const rect = el?.getBoundingClientRect()
      const visible = !!el?.getClientRects().length
      if (visible && rect) {
        // fit 放到下一帧，避免在 ResizeObserver 回调内同步改变布局。
        const changed = rect.width !== lastFitWidth || rect.height !== lastFitHeight
        if (changed && !fitPending) {
          fitPending = true
          requestAnimationFrame(() => {
            fitPending = false
            const current = hostRef.current
            if (stopped || !current?.getClientRects().length) return
            const size = current.getBoundingClientRect()
            lastFitWidth = size.width
            lastFitHeight = size.height
            fit.fit()
          })
        }
        if (!wasVisible && (document.activeElement === document.body || el?.contains(document.activeElement))) term.focus()
      }
      wasVisible = visible
    })
    observer.observe(hostRef.current!)
    term.focus()

    // 读取交给窗口级中枢：本窗口所有标签共用一条 readMulti 长轮询，
    // 标签数量不再吃掉宿主桥的并发额度（上限 8，超出的写入会被拒）。
    // 会话已经结束或出错的终端不再接受中枢回调——迟到的分片不能把
    // 失败状态改写成“已结束”，也不能再往终端里写字。
    const stillReading = () => !stopped && inputStateRef.current === 'running'
    const unsubscribeRead = subscribeTerminalRead(sessionKey, {
      onData: dataBase64 => {
        if (!stillReading()) return
        // 先剥掉注入命令自己的回显（那行代码不该出现在屏幕上），再把剩下的
        // 与已画的预测逐字节抵消：抵消掉的部分不再写第二遍，其余的（命令输出、
        // 换行、分歧点之后的内容）照常绘制。
        const text = echoRef.current!.consume(redactRef.current!.filter(decodeChunk(dataBase64)))
        if (!text) return
        term.write(text)
        osc7Re.lastIndex = 0
        const m = osc7Re.exec(text)
        if (m && m[1]) onCwdRef.current(m[1])
      },
      onEnd: (hasExit, exitCode) => {
        if (!stillReading()) return
        inputStateRef.current = 'closed'
        writeQueue.stop()
        setStatus('closed')
        setDetail(hasExit ? t('term.exitCode', { code: exitCode ?? -1 }) : t('term.ended'))
      },
      onUnavailable: e => {
        if (!stillReading()) return
        inputStateRef.current = 'error'
        writeQueue.stop()
        setStatus('error')
        setDetail(describeError(e))
        term.write(`\r\n\x1b[31m${describeError(e)}\x1b[0m\r\n`)
      },
    })
    stopReadingRef.current = unsubscribeRead

    return () => {
      stopped = true
      unsubscribeRead()
      if (stopReadingRef.current === unsubscribeRead) stopReadingRef.current = () => {}
      writeQueue.stop()
      if (writeQueueRef.current === writeQueue) writeQueueRef.current = null
      unsubscribePrefs()
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      selectionSub.dispose()
      if (termRef.current === term) termRef.current = null
      term.dispose()
    }
    // 依赖只有 sessionKey：会话生命周期才是重建终端的唯一正当理由。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  // 目录跟随（opt-in）：向远端 shell 注入 OSC7 上报钩子（bash/zsh）。
  // 不写在会话 effect 里——开关可能在会话建立之后才打开，那样只有新终端才生效。
  // fish 等不支持的 shell 保持被动监听（远端自己发了 OSC7 一样能跟随）。
  //
  // 注入分两步，为的是让那行两百多字符的钩子**根本不产生回显**：
  // 先写一行短的 `read -s`，让远端把下一行当「不回显的输入」读走，再把钩子交给它。
  // 远端会照原样回显的只有那行 read（短，宽度内不会折行，逐字节的消除吃得准）；
  // 钩子是在 ECHO 已经关掉之后才到远端的，内核不回显，屏幕上自然没有它。
  // 早先的做法是直接把钩子打在命令行上、事后擦掉回显：那行超过终端宽度，远端行
  // 编辑器会折行重绘（插 \r 重画整行），逐字节对不上就整行露出来——回显消除在这
  // 种链路上必然失守。
  const injectedRef = useRef(false)
  useEffect(() => {
    if (!sessionKey || !followCwd || injectedRef.current) return
    injectedRef.current = true
    let hookTimer: ReturnType<typeof setTimeout> | undefined
    // 延迟发送避开 shell 启动窗口。
    const timer = setTimeout(() => {
      if (inputStateRef.current !== 'running') return
      // 用户已经在敲命令了：注入的字节会拼进他那半截命令里，而这行 read 期间他
      // 自己也看不见被吞了什么。这一会话就别注入了，跟随这一会话不生效。
      if (userTypingRef.current) return
      if (!enqueueWrite(INJECT_READER + '\r', false)) return
      // 只记命令正文：末尾那个回车留给远端回显照常处理（PTY 可能回显 \r、\r\n
      // 或 \n，连它一起吃掉的话换行也没了，提示符会被挤到上一行去）。
      redactRef.current!.hide(INJECT_READER)
      // 两笔写入相隔 INJECT_GAP_MS 发出，到达远端也相隔这么久（同一连接、顺序
      // 保序），远端有足够时间把 read 跑起来——不依赖链路往返时延。
      hookTimer = setTimeout(() => {
        if (inputStateRef.current !== 'running') return
        // 这段时间里用户抢先打了字：他的整行会被 read 静默读走，交给 case 挡掉
        // 不会执行；此时再送钩子就会拼进他正在敲的命令里，所以只回一个回车把
        // read 放走。
        // 用户抢先打字时钩子不送了（会拼进他的命令），但 reader 已经进了历史，
        // 得让那条清理命令替它收尾。
        enqueueWrite(userTypingRef.current ? INJECT_CLEANUP + '\r' : OSC7_HOOK + '\r', false)
      }, INJECT_GAP_MS)
    }, INJECT_DELAY_MS)
    return () => { clearTimeout(timer); if (hookTimer) clearTimeout(hookTimer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, followCwd])

  const sendRaw = (data: string) => enqueueWrite(data)

  if (!sessionKey) {
    return <div className="terminal-host"><div className="terminal-xterm" /></div>
  }

  return (
    <div className="terminal-host">
      <div ref={hostRef} className="terminal-xterm" />
      <div className="terminal-toolbar">
        <div className="terminal-tools">
          <Tooltip title={t('term.selectionHelp')}>
            <button type="button" className="terminal-action" aria-label={t('term.copy')} disabled={!hasSelection} onClick={event => void copySelection(event.currentTarget)}>
              <CopyOutlined />
            </button>
          </Tooltip>
          <button type="button" className="terminal-action" title={t('form.paste')} aria-label={t('form.paste')}
            onClick={event => pasteClipboard(event.currentTarget)}
          >
            <SnippetsOutlined />
          </button>
          <button type="button" className="terminal-action" onClick={() => sendRaw('\x03')}>
            {t('term.ctrlc')}
          </button>
        </div>
        {quickCommands.length > 0 && (
          <Dropdown trigger={['click']} autoFocus menu={{
            items: quickCommands.map((q, i) => ({ key: String(i), label: <span className="saved-command-name" title={q.command}>{q.name}</span> })),
            onClick: ({ key, domEvent }) => {
              // 焦点交还终端前消费菜单按键，避免 Enter 再向远端发送一次回车。
              domEvent?.preventDefault()
              domEvent?.stopPropagation()
              const command = quickCommands[Number(key)]
              if (command) { sendRaw(command.command + '\r'); termRef.current?.focus() }
            },
          }}>
            <button type="button" className="terminal-action terminal-command-trigger" title={t('settings.quick')} aria-label={t('settings.quick')}>
              <CodeOutlined /><span className="terminal-command-label">{t('settings.quick')}</span><DownOutlined className="terminal-command-chevron" />
            </button>
          </Dropdown>
        )}
        <Tooltip title={t('term.broadcastScope')}>
          <div className={`terminal-broadcast${broadcast ? ' is-active' : ''}`}>
            <span className="toolbar-label">{t('term.broadcast')}</span>
            <Switch size="small" checked={broadcast} onChange={setBroadcast} aria-label={t('term.broadcast')} />
            {broadcast && targets().length > 0 && <Tag color="blue">{targets().length + 1}</Tag>}
          </div>
        </Tooltip>
      </div>
      {status !== 'running' && (
        <div className="terminal-overlay"><span>{detail}</span></div>
      )}
    </div>
  )
}
