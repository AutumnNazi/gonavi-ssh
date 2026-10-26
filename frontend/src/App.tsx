import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Layout, message, Modal, Tabs, Input } from 'antd'
import {
  ProfilePanel,
  type ProfileView,
} from './components/ProfilePanel'
import { TerminalView } from './components/TerminalView'
import { SftpPanel } from './components/SftpPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { invokeAs, describeError } from './bridge'
import { t } from './i18n'
import type { Challenge, ConnectionInfo, PluginSettings, TerminalTab } from './types'

const { Sider, Content } = Layout

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
      })
    return () => { cancelled = true }
  }, [refreshProfiles, refreshConnections, refreshSettings])

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
    try {
      await invokeAs('conn.answer', {
        connectionId: ctx.conn.connectionId,
        // 后端按 prompts 数量取答案；UI 只填了第一个时其余送空串。
        answers: filled.length > 0 ? filled : [''],
      })
    } catch (e) {
      message.error(`${describeError(e)}`)
    }
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

  return (
    <AntApp style={{ height: '100%' }}>
      <Layout className="app-root">
        <Sider width={300} theme="light" className="app-sider">
          <ProfilePanel
            profiles={profiles}
            connections={connections}
            onChanged={refreshProfiles}
            onConnect={openConnection}
            onConnectionsChanged={refreshConnections}
          />
        </Sider>
        <Content className="app-content">
          <Tabs
            className="main-tabs"
            activeKey={mainTab}
            onChange={setMainTab}
            items={[
              {
                key: 'terminals',
                label: t('tab.terminals'),
                children: (
                  <div className="terminals-wrap">
                    {tabs.length === 0 ? (
                      <div className="empty-hint">{t('conn.empty')}</div>
                    ) : (
                      <Tabs
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
                              onCwd={setCwd}
                            />
                          ),
                        }))}
                      />
                    )}
                  </div>
                ),
              },
              {
                key: 'files',
                label: t('tab.files'),
                children: (
                  <SftpPanel
                    profiles={profiles}
                    connections={connections}
                    onConnectionsChanged={refreshConnections}
                    initialRemotePath={cwd}
                  />
                ),
              },
              {
                key: 'settings',
                label: t('tab.settings'),
                children: (
                  <SettingsPanel
                    settings={settings}
                    onSaved={() => {
                      refreshSettings()
                      message.success(t('settings.saved'))
                    }}
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
