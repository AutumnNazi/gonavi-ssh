import { useEffect, useRef, useState } from 'react'
import { Space, Switch, Tag, Tooltip, message } from 'antd'
import { CopyOutlined, SnippetsOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invokeAs, describeError } from '../bridge'
import { encodeText, createStreamDecoder } from '../b64'
import { createTerminalWriteQueue } from '../terminalWriteQueue'
import { t } from '../i18n'
import { hostPrefs, subscribeHostPrefs } from '../hostPrefs'
import { terminalOptions } from '../terminalTheme'
import type { QuickCommand, TerminalTab } from '../types'

interface WriteRequest {
  command: 'terminal.write' | 'terminal.writeMulti'
  args: { sessionKey?: string; sessionKeys?: string[]; dataBase64: string }
}

interface ReadResult {
  dataBase64: string
  eof: boolean
  hasExit: boolean
  exitCode?: number
}

// OSC 7（shell 工作目录通知）：xterm 输出流里匹配 file://host/path，
// 需用户在远端 shell 配置 PROMPT_COMMAND 才会发。
const osc7Re = /\x1b\]7;file:\/\/[^\x07\x1b\/]*([^\x07\x1b]*?)((\x1b\\)|\x07)/g

interface Props {
  tab: TerminalTab
  allTabs: TerminalTab[]
  /** 终端 cd 后回调当前远端目录（OSC7），供文件面板跟随。 */
  onCwd: (path: string) => void
}

// 轮询失败退避：瞬时错误（桥忙/超时）不应终止读取循环。
const RETRY_MAX = 8
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 5000
const INPUT_WARNING_INTERVAL_MS = 1500


// 终端视图：sessionKey 由上层创建，这里只负责 xterm 渲染、长轮询、
// 输入写入（可广播到同连接其他会话）与快捷命令。
// xterm 生命周期 effect 只依赖 sessionKey：广播目标与回调经 ref 传递，
// 避免任何无关状态变化销毁重建终端实例。
export function TerminalView({ tab, allTabs, onCwd }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [status, setStatus] = useState<'running' | 'closed' | 'error'>('running')
  const inputStateRef = useRef<'running' | 'closed' | 'error'>('running')
  const [detail, setDetail] = useState('')
  const [broadcast, setBroadcast] = useState(false)
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const sessionKey = tab.sessionKey ?? ''

  // 广播目标与写入队列放 ref：不进 effect 依赖。
  const broadcastRef = useRef(false)
  const allTabsRef = useRef(allTabs)
  const onCwdRef = useRef(onCwd)
  const writeQueueRef = useRef<ReturnType<typeof createTerminalWriteQueue<WriteRequest>> | null>(null)
  const nextInputWarningRef = useRef(0)
  broadcastRef.current = broadcast
  allTabsRef.current = allTabs
  onCwdRef.current = onCwd

  const targets = () =>
    broadcastRef.current
      ? allTabsRef.current
          .filter(x => x.connectionId === tab.connectionId && x.sessionKey && x.tabKey !== tab.tabKey)
          .map(x => x.sessionKey!)
      : []

  const warnInputDropped = (reason?: 'ended' | 'unavailable') => {
    if (reason) {
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
  const enqueueWrite = (data: string) => {
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
      if (text && isCurrent()) queue.enqueue({
        command: keys.length > 1 ? 'terminal.writeMulti' : 'terminal.write',
        args: keys.length > 1 ? { sessionKeys: keys, dataBase64: encodeText(text) } : { sessionKey, dataBase64: encodeText(text) },
      })
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

    const dataSub = term.onData(d => enqueueWrite(d))
    const resizeSub = term.onResize(({ cols, rows }) => {
      invokeAs('terminal.resize', { sessionKey, cols, rows }).catch(() => {})
    })
    let wasVisible = !!hostRef.current?.getClientRects().length
    const observer = new ResizeObserver(() => {
      const visible = !!hostRef.current?.getClientRects().length
      if (visible) {
        fit.fit()
        if (!wasVisible && (document.activeElement === document.body || hostRef.current?.contains(document.activeElement))) term.focus()
      }
      wasVisible = visible
    })
    observer.observe(hostRef.current!)
    term.focus()

    // 目录跟随（opt-in）：向远端 shell 注入 OSC7 上报钩子（bash/zsh）。
    // 延迟发送避开 shell 启动窗口；注入行会显示在终端里——这是开关
    // 打开时的预期可见行为。fish 不支持，保持被动监听。
    let injectTimer: ReturnType<typeof setTimeout> | undefined
    if (cwdFollowRef.current) {
      injectTimer = setTimeout(() => {
        if (stopped) return
        // shell 收到的是字面 "\033"（printf 自行解释为 ESC）；单引号串
        // 避免 JS 模板插值吞掉 ${PROMPT_COMMAND:+...}。
        enqueueWrite(
          '__g7(){ printf \'\\033]7;file://%s%s\\033\\\\\' "$(hostname)" "$PWD"; }; ' +
          'if [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND="__g7;${PROMPT_COMMAND:+$PROMPT_COMMAND;}"; ' +
          'elif [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __g7; fi\r',
        )
      }, 800)
    }

    async function pollLoop() {
      let retries = 0
      while (!stopped && inputStateRef.current === 'running') {
        // 写优先：桥并发预算被长轮询占满时，先把槽位让给按键，
        // 避免 write 被持续拒绝。
        if (writeQueue.hasWork()) {
          const until = Date.now() + 1500
          while (writeQueue.hasWork() && !stopped && Date.now() < until) {
            await new Promise(r => setTimeout(r, 50))
          }
        }
        if (stopped || inputStateRef.current !== 'running') break
        try {
          const res = await invokeAs<ReadResult>('terminal.read', {
            sessionKey,
            maxBytes: 65536,
            waitMillis: 20000,
          })
          if (stopped || inputStateRef.current !== 'running') break
          retries = 0
          if (res.dataBase64) {
            const text = decodeChunk(res.dataBase64)
            term.write(text)
            osc7Re.lastIndex = 0
            const m = osc7Re.exec(text)
            if (m && m[1]) onCwdRef.current(m[1])
          }
          if (res.eof) {
            inputStateRef.current = 'closed'
            writeQueue.stop()
            setStatus('closed')
            setDetail(res.hasExit ? t('term.exitCode', { code: res.exitCode ?? -1 }) : t('term.ended'))
            return
          }
        } catch (e) {
          if (stopped || inputStateRef.current !== 'running') return
          // 瞬时失败（桥并发满/超时）退避重试；连续失败才终止。
          if (retries >= RETRY_MAX) {
            inputStateRef.current = 'error'
            writeQueue.stop()
            setStatus('error')
            setDetail(describeError(e))
            term.write(`\r\n\x1b[31m${describeError(e)}\x1b[0m\r\n`)
            return
          }
          const delay = Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_CAP_MS)
          retries++
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    pollLoop()

    return () => {
      stopped = true
      writeQueue.stop()
      if (writeQueueRef.current === writeQueue) writeQueueRef.current = null
      if (injectTimer !== undefined) clearTimeout(injectTimer)
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

  // 快捷命令与目录跟随开关来自插件设置。
  const cwdFollowRef = useRef(false)
  useEffect(() => {
    invokeAs<{ settings: { quickCommands: QuickCommand[]; cwdFollow?: boolean } }>('settings.get', {})
      .then(res => {
        setQuickCommands(res.settings?.quickCommands ?? [])
        cwdFollowRef.current = !!res.settings?.cwdFollow
      })
      .catch(() => {})
  }, [])

  const sendRaw = (data: string) => enqueueWrite(data)

  if (!sessionKey) {
    return <div className="terminal-host"><div className="terminal-xterm" /></div>
  }

  return (
    <div className="terminal-host">
      <div className="terminal-toolbar">
        <Space size={12} wrap>
          <Tooltip title={t('term.broadcastScope')}>
            <Space size={4}>
              <Switch size="small" checked={broadcast} onChange={setBroadcast} aria-label={t('term.broadcast')} />
              <span className="toolbar-label">{t('term.broadcast')}</span>
              {broadcast && targets().length > 0 && <Tag color="blue">{targets().length + 1}</Tag>}
            </Space>
          </Tooltip>
          <Tooltip title={t('term.selectionHelp')}>
            <button type="button" className="terminal-action" aria-label={t('term.copy')} disabled={!hasSelection} onClick={event => void copySelection(event.currentTarget)}>
              <CopyOutlined /> {t('term.copy')}
            </button>
          </Tooltip>
          <button type="button" className="terminal-action" aria-label={t('form.paste')}
            onClick={event => pasteClipboard(event.currentTarget)}
          >
            <SnippetsOutlined /> {t('form.paste')}
          </button>
          <Space size={4}>
            <ThunderboltOutlined />
            {quickCommands.map((q, i) => (
              <Tag key={i} className="quick-cmd" onClick={() => sendRaw(q.command + '\r')}>
                {q.name}
              </Tag>
            ))}
            <Tag className="quick-cmd" color="red" onClick={() => sendRaw('\x03')}>
              {t('term.ctrlc')}
            </Tag>
          </Space>
        </Space>
      </div>
      <div ref={hostRef} className="terminal-xterm" />
      {status !== 'running' && (
        <div className="terminal-overlay"><span>{detail}</span></div>
      )}
    </div>
  )
}
