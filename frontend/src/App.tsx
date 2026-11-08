import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Layout, message, Modal, Tabs, Input } from 'antd'
import { CloseOutlined, CodeOutlined, FolderOpenOutlined, SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import {
  ProfilePanel,
  type ProfileView,
} from './components/ProfilePanel'
import { TerminalView } from './components/TerminalView'
import { SftpPanel } from './components/SftpPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { FileTreePanel, type TreeJump } from './components/FileTreePanel'
import { invokeAs, describeError } from './bridge'
import { encodeText } from './b64'
import { quoteShellArg } from './fsFormat'
import { t } from './i18n'
import { usePanelResize } from './usePanelResize'
import type {
  Challenge,
  ConnectionInfo,
  PluginSettings,
  TerminalTab,
  TransferStatus,
} from './types'

const { Content } = Layout

let tabSeq = 0

// 连接打开流程：conn.open 立即返回 → 轮询状态（needInput 时弹窗收动态码）
// → ready 后开终端会话与 tab。超时 150s 放弃。
export default function App() {
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeKey, setActiveKey] = useState<string>()
  const [mainTab, setMainTab] = useState('terminals')
  // 挑战按连接排队：多个连接同时进入 needInput 时逐个处理，
  // 不会互相覆盖导致前一个连接无人应答直到超时。
  const [challengeQueue, setChallengeQueue] = useState<{ conn: ConnectionInfo; ch: Challenge }[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [settings, setSettings] = useState<PluginSettings | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  // 文件浏览跳转目标：终端目录（跟随开关打开时）或命中的跳转命令。
  const [treeJump, setTreeJump] = useState<TreeJump | null>(null)
  // 文件浏览的本地覆盖：null＝跟随设置，true＝跳转命令临时显示，false＝刚被收起。
  // 跳转要能在设置关着的时候也让用户看见目标目录，但不该改掉持久化设置；
  // 收起则要立刻生效——设置读不到（settings 还是 null）时也不能点了没反应。
  const [treeOverride, setTreeOverride] = useState<boolean | null>(null)
  const [fileTreeWidth, setFileTreeWidth] = useState(260)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('gonavi.ssh.sidebarWidth'))
      if (Number.isFinite(saved) && saved >= 200 && saved <= 10000) return saved
    } catch { /* 宿主未开放本地存储时使用默认布局。 */ }
    return 240
  })
  const sidebarReserve = mainTab === 'files' ? 600 : 400
  const sidebarResize = usePanelResize(sidebarWidth, 200, sidebarReserve, 240, value => {
    setSidebarWidth(value)
    try { window.localStorage.setItem('gonavi.ssh.sidebarWidth', String(value)) } catch { /* 当前窗口仍保留宽度。 */ }
  })
  const connecting = useRef<Set<string>>(new Set())

  const challenge = challengeQueue[0] ?? null

  const refreshProfiles = useCallback(async () => {
    try {
      const res = await invokeAs<{ profiles: ProfileView[] }>('profile.list', {})
      setProfiles(res.profiles ?? [])
    } catch (e) {
      message.error(`${describeError(e)}`)
    }
  }, [])

  const refreshConnections = useCallback(async () => {
    try {
      const res = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', {})
      setConnections(res.connections ?? [])
    } catch {
      // 状态刷新失败不打扰用户。
    }
  }, [])

  const refreshSettings = useCallback(async () => {
    try {
      const res = await invokeAs<{ settings: PluginSettings }>('settings.get', {})
      setSettings(res.settings)
    } catch {
      /* 设置加载失败不阻塞 UI */
    }
  }, [])

  // 设置是布尔项的"未配置"默认值来源：showFileTree 缺省不显示（nil＝关）。
  const showFileTree = treeOverride ?? settings?.showFileTree === true
  const followTree = !!settings?.cwdFollow
  // 文件浏览服务当前活动终端：它跟着活动标签的连接走，不另选档案。
  const activeTab = tabs.find(tab => tab.tabKey === activeKey) ?? tabs[tabs.length - 1]

  // 「在终端中 cd 到此目录」：把一行 cd 写进活动终端。路径必须引起来——远端目录名
  // 带空格是常态，裸拼会被 shell 拆成多条参数。
  const cdToRemotePath = useCallback(async (remotePath: string) => {
    if (!activeTab?.sessionKey) {
      message.warning(t('app.noTerminal'))
      return
    }
    try {
      await invokeAs('terminal.write', {
        sessionKey: activeTab.sessionKey,
        dataBase64: encodeText(`cd ${quoteShellArg(remotePath)}\n`),
      })
    } catch (e) {
      message.error(`${describeError(e)}`)
    }
  }, [activeTab])

  // 设置面板与文件浏览底部勾选框都写这里：一处持久化，两处显示同源。
  const applySettings = useCallback(
    async (patch: Partial<PluginSettings>) => {
      if (!settings) return
      try {
        await invokeAs('settings.set', { settings: { ...settings, ...patch } })
        await refreshSettings()
      } catch (e) {
        message.error(`${describeError(e)}`)
      }
    },
    [settings, refreshSettings],
  )

  // 设置里的显示开关一变就把本地覆盖清掉：该开关重新打开时文件浏览要能自己
  // 回来，收起不会变成永久隐藏。
  useEffect(() => {
    setTreeOverride(null)
  }, [settings?.showFileTree])

  // 跳转命令命中（终端里整行输入 #name 回车）——只负责面板这一侧。
  //
  // 终端那侧的 cd 由 TerminalView 在识别到整行的当下就把输入替换掉发出去，不经过
  // 这里：那样才不会有"先发用户输入、再补一条命令"的缝隙，cd 也就不会和远端打印
  // 提示符赛跑、在屏幕上多印一行。
  //
  // 跟随时**直接**跳，不能只等 OSC7 上报——已经在目标目录时 cd 是空操作、cwd 不变，
  // 上报根本不会发生，面板会一动不动。没开跟随时面板不动：它的位置归那个开关管。
  const jumpTree = useCallback((path: string) => {
    if (!followTree) return
    setTreeOverride(true)
    setTreeJump(prev => ({ path, seq: (prev?.seq ?? 0) + 1 }))
  }, [followTree])

  const collapseTree = useCallback(() => {
    setTreeOverride(false)
    void applySettings({ showFileTree: false })
  }, [applySettings])

  // OSC7 上报的目录：始终喂给「文件」页做初始路径，只有跟随打开时才动文件浏览，
  // 否则用户在文件页翻到别处会被终端不停拽回来。
  //
  // 只在目录**真的变了**的时候动面板。上报钩子挂在 PROMPT_COMMAND 上，用户每敲
  // 一条命令、每回一次车都会上报一次；拿没变的目录去"跟随"，等于每次回车都把面板
  // 重载一遍——选中项被清空、跳转被顶掉，人在终端里干活却一直波及旁边这块面板。
  const lastCwdRef = useRef<string | null>(null)
  const handleCwd = useCallback(
    (path: string) => {
      setCwd(path)
      if (lastCwdRef.current === path) return
      lastCwdRef.current = path
      if (followTree) setTreeJump(prev => ({ path, seq: (prev?.seq ?? 0) + 1 }))
    },
    [followTree],
  )

  // 打开跟随的那一刻让面板就位：面板可能停在 a、终端在 b，开启后应当立刻跟到 b，
  // 而不是干等下一次 cd。
  useEffect(() => {
    if (!followTree) return
    const current = lastCwdRef.current
    if (!current) return
    setTreeJump(prev => ({ path: current, seq: (prev?.seq ?? 0) + 1 }))
  }, [followTree])

  // 关窗会让还没跑完的传输停在 interrupted，重开窗口时提示一次，
  // 用户才知道要去文件页点续传，而不是以为传输失败要重来。
  const notifyInterruptedTransfers = useCallback(async () => {
    try {
      const res = await invokeAs<{ tasks: TransferStatus[] }>('transfer.list', {})
      const count = (res.tasks ?? []).filter(task => task.state === 'interrupted').length
      if (count > 0) message.warning(t('app.interruptedNotice', { count }), 8)
    } catch {
      /* 提示失败不阻塞其他初始化 */
    }
  }, [])

  // 清理上一次窗口会话的残留连接（宿主在窗口关闭时也会触发 teardown，
  // 这里覆盖窗口进程异常退出等场景），随后加载当前状态。
  useEffect(() => {
    let cancelled = false
    invokeAs('session.teardown', {})
      .catch(() => {})
      .then(() => {
        if (cancelled) return
        refreshProfiles()
        refreshConnections()
        refreshSettings()
        notifyInterruptedTransfers()
      })
    return () => { cancelled = true }
  }, [refreshProfiles, refreshConnections, refreshSettings, notifyInterruptedTransfers])

  const openTerminalTab = useCallback(async (conn: ConnectionInfo, profile: ProfileView | null) => {
    try {
      const sess = await invokeAs<{ sessionKey: string }>('terminal.open', {
        connectionId: conn.connectionId,
        cols: 120,
        rows: 30,
      })
      const tab: TerminalTab = {
        tabKey: `tab-${Date.now()}-${tabSeq++}`,
        connectionId: conn.connectionId,
        profileId: profile?.id ?? conn.profileId,
        title: profile?.name ?? conn.addr ?? conn.connectionId,
        sessionKey: sess.sessionKey,
      }
      setTabs(prev => [...prev, tab])
      setActiveKey(tab.tabKey)
      setMainTab('terminals')
    } catch (e) {
      message.error(`${describeError(e)}`)
    }
  }, [])

  const waitReady = useCallback(
    async (connectionId: string, profile: ProfileView): Promise<'ready' | 'aborted'> => {
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        const res = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', { connectionId })
        const conn = res.connections?.[0]
        if (!conn) break
        setConnections(prev => {
          const idx = prev.findIndex(c => c.connectionId === connectionId)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = conn
            return next
          }
          return [...prev, conn]
        })
        if (conn.state === 'ready') return 'ready'
        if (conn.state === 'failed') {
          message.error(`${profile.name}: ${conn.error ?? '连接失败'}`)
          return 'aborted'
        }
        if (conn.state === 'cancelled') return 'aborted'
        if (conn.state === 'needInput' && conn.challenge) {
          setChallengeQueue(prev => {
            // 去重：同一连接不重复入队。
            if (prev.some(c => c.conn.connectionId === conn.connectionId)) return prev
            return [...prev, { conn, ch: conn.challenge! }]
          })
          return 'aborted' // 答案提交后由 submitChallenge 续跑
        }
        await new Promise(r => setTimeout(r, 600))
      }
      return 'aborted'
    },
    [],
  )

  const submitChallenge = useCallback(async () => {
    const ctx = challenge
    if (!ctx) return
    setChallengeQueue(prev => prev.slice(1))
    const filled = answers.map(a => a ?? '')
    setAnswers([])
    // 提交答案、继续等 ready、ready 后取最新状态开终端：整段收在一个 try 里。
    // 弹窗的 onOk 和输入框回车都直接调用本函数，谁都不接管返回的 promise，
    // 中途任何一次桥接调用失败都会变成未处理的拒绝，启动期错误面板随即盖住
    // 整个窗口——和表单校验那处一样，失败必须就地报给用户。
    try {
      await invokeAs('conn.answer', {
        connectionId: ctx.conn.connectionId,
        // 后端按 prompts 数量取答案；UI 只填了第一个时其余送空串。
        answers: filled.length > 0 ? filled : [''],
      })
      // 继续等待 ready（可能还有下一轮提问）。
      const profile = profiles.find(p => p.id === ctx.conn.profileId) ?? null
      const result = await waitReady(ctx.conn.connectionId, profile ?? ({ id: ctx.conn.profileId, name: ctx.conn.addr ?? '' } as ProfileView))
      if (result === 'ready') {
        const fresh = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', {
          connectionId: ctx.conn.connectionId,
        })
        if (fresh.connections?.[0]) {
          await openTerminalTab(fresh.connections[0], profile)
        }
      }
    } catch (e) {
      message.error(`${describeError(e)}`)
    }
  }, [challenge, answers, profiles, waitReady, openTerminalTab])

  const cancelChallenge = useCallback(async () => {
    const ctx = challenge
    setChallengeQueue(prev => prev.slice(1))
    setAnswers([])
    if (ctx) {
      await invokeAs('conn.cancel', { connectionId: ctx.conn.connectionId }).catch(() => {})
      refreshConnections()
    }
  }, [challenge, refreshConnections])

  const openConnection = useCallback(
    async (profile: ProfileView) => {
      if (connecting.current.has(profile.id)) return
      connecting.current.add(profile.id)
      try {
        const st = await invokeAs<ConnectionInfo>('conn.open', { profileId: profile.id })
        setConnections(prev => [...prev.filter(c => c.connectionId !== st.connectionId), st])
        if (st.state === 'ready') {
          await openTerminalTab(st, profile)
        } else if (st.state === 'connecting') {
          const result = await waitReady(st.connectionId, profile)
          if (result === 'ready') {
            const fresh = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', {
              connectionId: st.connectionId,
            })
            if (fresh.connections?.[0]) await openTerminalTab(fresh.connections[0], profile)
          }
        } else if (st.state === 'needInput' && st.challenge) {
          setChallengeQueue(prev =>
            prev.some(c => c.conn.connectionId === st.connectionId)
              ? prev
              : [...prev, { conn: st, ch: st.challenge! }],
          )
        } else if (st.state === 'failed') {
          message.error(`${profile.name}: ${st.error ?? '连接失败'}`)
        }
        refreshConnections()
      } catch (e) {
        message.error(`${describeError(e)}`)
      } finally {
        connecting.current.delete(profile.id)
      }
    },
    [openTerminalTab, waitReady, refreshConnections],
  )

  const closeTab = useCallback((tabKey: string) => {
    setTabs(prev => {
      const tab = prev.find(t => t.tabKey === tabKey)
      if (tab?.sessionKey) {
        invokeAs('terminal.close', { sessionKey: tab.sessionKey }).catch(() => {})
      }
      return prev.filter(t => t.tabKey !== tabKey)
    })
  }, [])

  // 宿主窗口标题栏上的关闭按钮插件拦不到，这里给出窗口内的关闭入口：
  // 还有传输在跑时先确认一次，避免用户以为关窗后传输还在继续。
  const closeWindow = useCallback(() => {
    window.gonaviPlugin?.close().catch(() => {})
  }, [])

  const requestClose = useCallback(async () => {
    let running = 0
    try {
      const res = await invokeAs<{ tasks: TransferStatus[] }>('transfer.list', {})
      running = (res.tasks ?? []).filter(
        task => task.state === 'running' || task.state === 'queued',
      ).length
    } catch {
      // 查不到传输状态就直接关：一次失败的状态查询不该把窗口扣住。
    }
    if (running === 0) {
      closeWindow()
      return
    }
    Modal.confirm({
      title: t('app.closeTitle'),
      content: t('app.closeBody', { count: running }),
      okText: t('app.closeConfirm'),
      okButtonProps: { danger: true },
      cancelText: t('app.closeStay'),
      onOk: () => closeWindow(),
    })
  }, [closeWindow])

  return (
    <AntApp style={{ height: '100%' }}>
      <Layout hasSider className="app-root">
        <aside id="connection-sidebar" className="app-sider" style={{ width: sidebarWidth, maxWidth: `max(200px, calc(100% - ${sidebarReserve}px))` }} hidden={sidebarCollapsed} aria-label={t('conn.title')}>
          <div className="sidebar-scroll"><ProfilePanel
            profiles={profiles}
            connections={connections}
            activeProfileId={activeTab?.profileId}
            onChanged={refreshProfiles}
            onConnect={profile => {
              const existing = tabs.find(tab => tab.profileId === profile.id && connections.some(conn => conn.connectionId === tab.connectionId && conn.state === 'ready' && conn.alive))
              if (existing) { setActiveKey(existing.tabKey); setMainTab('terminals'); return }
              return openConnection(profile)
            }}
            onConnectionsChanged={refreshConnections}
          /></div>
          <div {...sidebarResize} className="panel-resizer" aria-label={t('conn.resize')} title={t('tree.resizeHint')} />
        </aside>
        <Content className="app-content">
          <Tabs
            className="main-tabs"
            activeKey={mainTab}
            onChange={setMainTab}
            tabBarExtraContent={{
              left: <Button className="sidebar-toggle" size="small" type="text" icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                title={t(sidebarCollapsed ? 'conn.showSidebar' : 'conn.hideSidebar')} aria-label={t(sidebarCollapsed ? 'conn.showSidebar' : 'conn.hideSidebar')}
                aria-expanded={!sidebarCollapsed} aria-controls="connection-sidebar" onClick={() => setSidebarCollapsed(value => !value)} />,
              right: <Button size="small" type="text" icon={<CloseOutlined />} title={t('app.closeWindow')} aria-label={t('app.closeWindow')} onClick={() => void requestClose()} />,
            }}
            items={[
              {
                key: 'terminals',
                icon: <CodeOutlined aria-hidden />,
                label: t('tab.terminals'),
                children: (
                  <div className="terminals-wrap">
                    {showFileTree && activeTab && (
                      <FileTreePanel
                        width={fileTreeWidth}
                        onWidthChange={setFileTreeWidth}
                        connectionId={activeTab?.connectionId ?? null}
                        jump={treeJump}
                        follow={followTree}
                        onFollowChange={next => void applySettings({ cwdFollow: next })}
                        downloadDir={settings?.downloadDir ?? ''}
                        onDownloadDirChange={next => void applySettings({ downloadDir: next })}
                        onCollapse={collapseTree}
                        onCdTo={remotePath => void cdToRemotePath(remotePath)}
                      />
                    )}
                    <div className="terminals-main">
                      {tabs.length === 0 ? (
                        <div className="empty-hint"><CodeOutlined aria-hidden /><span>{t('sftp.selectConn')}</span></div>
                      ) : (
                        <Tabs
                          className="session-tabs"
                          hideAdd
                          type="editable-card"
                          activeKey={activeKey}
                          onChange={setActiveKey}
                          onEdit={(key, action) => {
                            if (action === 'remove') closeTab(key as string)
                          }}
                          items={tabs.map(tab => ({
                            key: tab.tabKey,
                            label: tab.title,
                            children: (
                              <TerminalView
                                key={tab.tabKey}
                                tab={tab}
                                allTabs={tabs}
                                onCwd={handleCwd}
                                onJump={jumpTree}
                                // 跟随开关长在文件浏览面板上，面板没显示就没有可跟随的
                                // 东西——这时还往远端注钩子，用户只会平白看到它在远端
                                // 执行了一串 shell 代码。
                                followCwd={followTree && showFileTree}
                                quickCommands={settings?.quickCommands ?? []}
                                localEcho={settings?.localEcho}
                                treeCommands={settings?.treeCommands ?? []}
                              />
                            ),
                          }))}
                        />
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: 'files',
                icon: <FolderOpenOutlined aria-hidden />,
                label: t('tab.files'),
                children: (
                  <SftpPanel
                    profiles={profiles}
                    connections={connections}
                    onConnectionsChanged={refreshConnections}
                    initialRemotePath={cwd}
                    onCdTo={remotePath => void cdToRemotePath(remotePath)}
                  />
                ),
              },
              {
                key: 'settings',
                icon: <SettingOutlined aria-hidden />,
                label: t('tab.settings'),
                children: (
                  <SettingsPanel
                    settings={settings}
                    // 设置项改完即落盘、面板里没有保存按钮：这里只把新值拉回来，
                    // 免得每次改动都弹一次"已保存"。
                    onSaved={() => refreshSettings()}
                  />
                ),
              },
            ]}
          />
        </Content>
      </Layout>

      <Modal
        title={t('prompt.title')}
        open={challenge !== null}
        onOk={submitChallenge}
        onCancel={cancelChallenge}
        okText={t('prompt.submit')}
        cancelText={t('prompt.cancel')}
        destroyOnClose
      >
        <p>{challenge?.ch.instruction || t('prompt.instruction')}</p>
        <p className="challenge-prompt">{challenge?.ch.stage}</p>
        {/* 键盘交互可能一次问多题（如密码+OTP）：按 prompts 数量生成输入框。
            Modal 子树在关闭时也会渲染，所有挑战字段必须可选链访问。 */}
        {(challenge?.ch.prompts?.length ? challenge.ch.prompts : ['']).map((prompt, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            {challenge?.ch.prompts?.length ? <label className="challenge-label">{prompt}</label> : null}
            <Input.Password
              autoFocus={i === 0}
              value={answers[i] ?? ''}
              onChange={e => {
                const next = [...answers]
                next[i] = e.target.value
                setAnswers(next)
              }}
              onPressEnter={i === (challenge?.ch.prompts?.length ?? 1) - 1 ? submitChallenge : undefined}
              placeholder={prompt}
            />
          </div>
        ))}
      </Modal>
    </AntApp>
  )
}
