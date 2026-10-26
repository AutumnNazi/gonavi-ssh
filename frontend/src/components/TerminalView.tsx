import { useEffect, useRef, useState } from 'react'
import { Drawer, List, Space, Switch, Tag, Tooltip, message } from 'antd'
import { HistoryOutlined, SnippetsOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invokeAs, describeError } from '../bridge'
import { encodeText, createStreamDecoder } from '../b64'
import { t } from '../i18n'
import { isDark } from '../hostPrefs'
import type { QuickCommand, TerminalTab } from '../types'

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

// 终端视图：sessionKey 由上层创建，这里只负责 xterm 渲染、长轮询、
// 输入写入（可广播到同连接其他会话）、历史与快捷命令。
// xterm 生命周期 effect 只依赖 sessionKey：广播目标与回调经 ref 传递，
// 避免任何无关状态变化销毁重建终端实例。
export function TerminalView({ tab, allTabs, onCwd }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'running' | 'closed' | 'error'>('running')
  const [detail, setDetail] = useState('')
  const [broadcast, setBroadcast] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const sessionKey = tab.sessionKey ?? ''

  // 广播目标与写入队列放 ref：不进 effect 依赖。
  const broadcastRef = useRef(false)
  const allTabsRef = useRef(allTabs)
  const onCwdRef = useRef(onCwd)
  const pendingWrites = useRef<string[]>([])
  const pumping = useRef(false)
  const stoppedRef = useRef(false)
  broadcastRef.current = broadcast
  allTabsRef.current = allTabs
  onCwdRef.current = onCwd

  const targets = () =>
    broadcastRef.current
      ? allTabsRef.current
          .filter(x => x.connectionId === tab.connectionId && x.sessionKey && x.tabKey !== tab.tabKey)
          .map(x => x.sessionKey!)
      : []

  // 写请求串行队列：保证敲键顺序，且桥并发满（429）时退避重试而不是
  // 静默丢弃按键。会话已结束（not found）时清空队列。
  const enqueueWrite = (data: string) => {
    pendingWrites.current.push(data)
    if (pendingWrites.current.length > 200) {
      pendingWrites.current.splice(0, pendingWrites.current.length - 200)
    }
    void pumpWrites()
  }

  const pumpWrites = async () => {
    if (pumping.current) return
    pumping.current = true
    let failures = 0
    try {
      while (pendingWrites.current.length > 0 && !stoppedRef.current) {
        const text = pendingWrites.current[0]
        const keys = [sessionKey, ...targets()]
        const args =
          keys.length > 1
            ? { sessionKeys: keys, dataBase64: encodeText(text) }
            : { sessionKey, dataBase64: encodeText(text) }
        const cmd = keys.length > 1 ? 'terminal.writeMulti' : 'terminal.write'
        try {
          await invokeAs(cmd, args)
          pendingWrites.current.shift()
          failures = 0
        } catch (e) {
          const code = (e as { code?: number })?.code
          // 会话结束：丢弃剩余输入，由 read 的 eof 收尾。
          if (code === 4101) {
            pendingWrites.current = []
            return
          }
          failures++
          if (failures > 20) {
            pendingWrites.current = []
            return
          }
          await new Promise(r => setTimeout(r, Math.min(100 * failures, 1000)))
        }
      }
    } finally {
      pumping.current = false
    }
  }

  useEffect(() => {
    if (!sessionKey) return
    let stopped = false
    stoppedRef.current = false
    const decodeChunk = createStreamDecoder()

    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: isDark
        ? { background: '#1e1e1e' }
        : { background: '#ffffff', foreground: '#333333', cursor: '#333333' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()

    const dataSub = term.onData(d => enqueueWrite(d))
    const resizeSub = term.onResize(({ cols, rows }) => {
      invokeAs('terminal.resize', { sessionKey, cols, rows }).catch(() => {})
    })
    const observer = new ResizeObserver(() => fit.fit())
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
      while (!stopped) {
        try {
          const res = await invokeAs<ReadResult>('terminal.read', {
            sessionKey,
            maxBytes: 65536,
            waitMillis: 20000,
          })
          if (stopped) break
          retries = 0
          if (res.dataBase64) {
            const text = decodeChunk(res.dataBase64)
            term.write(text)
            osc7Re.lastIndex = 0
            const m = osc7Re.exec(text)
            if (m && m[1]) onCwdRef.current(m[1])
          }
          if (res.eof) {
            setStatus('closed')
            setDetail(res.hasExit ? t('term.exitCode', { code: res.exitCode ?? -1 }) : t('term.ended'))
            return
          }
        } catch (e) {
          if (stopped) return
          // 瞬时失败（桥并发满/超时）退避重试；连续失败才终止。
          if (retries >= RETRY_MAX) {
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
      stoppedRef.current = true
      pendingWrites.current = []
      if (injectTimer !== undefined) clearTimeout(injectTimer)
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
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

  const openHistory = async () => {
    try {
      const res = await invokeAs<{ lines: string[] }>('terminal.history', {
        sessionKey,
        limit: 200,
      })
      setHistory(res.lines ?? [])
    } catch (e) {
      message.error(describeError(e))
    }
    setHistoryOpen(true)
  }

  const sendRaw = (data: string) => enqueueWrite(data)

  if (!sessionKey) {
    return <div className="terminal-host"><div className="terminal-xterm" /></div>
  }

  return (
    <div className="terminal-host">
      <div className="terminal-toolbar">
        <Space size={12} wrap>
          <Tooltip title={t('term.broadcast')}>
            <Space size={4}>
              <Switch size="small" checked={broadcast} onChange={setBroadcast} />
              <span className="toolbar-label">{t('term.broadcast')}</span>
              {broadcast && targets().length > 0 && <Tag color="blue">{targets().length + 1}</Tag>}
            </Space>
          </Tooltip>
          <a onClick={openHistory}><HistoryOutlined /> {t('term.history')}</a>
          <a
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText()
                if (text) sendRaw(text)
              } catch { /* 剪贴板权限被拒时静默 */ }
            }}
          >
            <SnippetsOutlined /> {t('form.paste')}
          </a>
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
      <Drawer
        title={t('term.history')}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width={420}
      >
        <List
          size="small"
          dataSource={[...history].reverse()}
          renderItem={line => (
            <List.Item
              className="history-line"
              onClick={() => sendRaw(line)}
              title={line}
            >
              {line}
            </List.Item>
          )}
        />
      </Drawer>
    </div>
  )
}
