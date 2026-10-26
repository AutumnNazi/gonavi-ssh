import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  List,
  message,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { invokeAs, describeError } from '../bridge'
import { decodeText, encodeText } from '../b64'
import { t } from '../i18n'
import type { ConnectionInfo, FsEntry, ProfileView, TransferStatus } from '../types'

interface Props {
  profiles: ProfileView[]
  connections: ConnectionInfo[]
  onConnectionsChanged: () => void
  initialRemotePath?: string | null
}

const BACKSLASH = String.fromCharCode(92)
const CONNECT_WAIT_MS = 20000

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}

// 路径分段（面包屑）：Windows 盘符/UNC 与 POSIX 分别解析。
function splitPathSegments(path: string, homeHint?: boolean): { label: string; full: string }[] {
  if (!path) return []
  if (path === '.' || path === './') return [{ label: homeHint ? '~' : '.', full: '.' }]
  const win = /^[a-zA-Z]:[\\/]/.test(path) || /^[a-zA-Z]:$/.test(path)
  if (win) {
    const norm = path.split('/').join(BACKSLASH).replace(/[\\]+$/, '')
    const out: { label: string; full: string }[] = []
    let acc = ''
    for (const part of norm.split(BACKSLASH).filter(Boolean)) {
      acc = acc === '' ? part + BACKSLASH : acc.replace(/[\\]+$/, '') + BACKSLASH + part
      out.push({ label: part, full: acc })
    }
    return out
  }
  if (path.startsWith(BACKSLASH + BACKSLASH)) {
    const out: { label: string; full: string }[] = []
    let acc = BACKSLASH + BACKSLASH
    for (const part of path.split(/[\\/]/).filter(Boolean)) {
      acc = acc === BACKSLASH + BACKSLASH ? acc + part : acc + BACKSLASH + part
      out.push({ label: part, full: acc })
    }
    return out
  }
  const out: { label: string; full: string }[] = [{ label: '/', full: '/' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += '/' + part
    out.push({ label: part, full: acc })
  }
  return out
}

function PathBreadcrumb({
  path,
  emptyLabel,
  homeHint,
  onNavigate,
}: {
  path: string
  emptyLabel?: string
  homeHint?: boolean
  onNavigate: (p: string) => void
}) {
  const segs = splitPathSegments(path, homeHint)
  if (segs.length === 0) {
    return <span className="crumb root" onClick={() => onNavigate('')}>{emptyLabel ?? '—'}</span>
  }
  return (
    <div className="path-breadcrumb">
      {segs.map((seg, i) => (
        <span key={i} className="crumb">
          <span className="crumb-icon">📁</span>
          <a title={seg.full} onClick={() => onNavigate(seg.full)}>{seg.label}</a>
          {i < segs.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  )
}

// 一栏的浏览历史：index 用 ref 保证回调里读到最新值。
function useNavHistory() {
  const list = useRef<string[]>([])
  const idx = useRef(-1)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const sync = () => {
    setCanBack(idx.current > 0)
    setCanForward(idx.current >= 0 && idx.current < list.current.length - 1)
  }
  const push = (path: string) => {
    list.current = [...list.current.slice(0, idx.current + 1), path]
    idx.current = list.current.length - 1
    sync()
  }
  const back = (): string | null => {
    if (idx.current <= 0) return null
    idx.current--
    sync()
    return list.current[idx.current]
  }
  const forward = (): string | null => {
    if (idx.current >= list.current.length - 1) return null
    idx.current++
    sync()
    return list.current[idx.current]
  }
  return { push, back, forward, canBack, canForward }
}

export function SftpPanel({ profiles, connections, onConnectionsChanged, initialRemotePath }: Props) {
  const [leftProfileId, setLeftProfileId] = useState('')
  const [rightProfileId, setRightProfileId] = useState('')
  const [rightMode, setRightMode] = useState<'local' | 'remote'>('local')

  const [leftPath, setLeftPath] = useState(initialRemotePath ?? '')
  const [rightPath, setRightPath] = useState('')
  const leftNav = useNavHistory()
  const rightNav = useNavHistory()

  const [leftEntries, setLeftEntries] = useState<FsEntry[]>([])
  const [leftMore, setLeftMore] = useState(false)
  const [leftOffset, setLeftOffset] = useState(0)
  const [leftSel, setLeftSel] = useState<FsEntry | null>(null)

  const [localEntries, setLocalEntries] = useState<FsEntry[]>([])
  const [localSel, setLocalSel] = useState<FsEntry | null>(null)

  const [rightEntries, setRightEntries] = useState<FsEntry[]>([])
  const [rightSel, setRightSel] = useState<FsEntry | null>(null)

  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [preview, setPreview] = useState<{ path: string; content: string; dirty: string; side: 'left' | 'right' } | null>(null)
  const [du, setDu] = useState<string | null>(null)
  const [editLeftPath, setEditLeftPath] = useState(false)
  const [editRightPath, setEditRightPath] = useState(false)
  const [busyProfile, setBusyProfile] = useState('')
  const localHomeRef = useRef('')

  const leftConn = connections.find(c => c.profileId === leftProfileId && c.state === 'ready' && c.alive)
  const rightConn =
    rightMode === 'remote'
      ? connections.find(c => c.profileId === rightProfileId && c.state === 'ready' && c.alive)
      : undefined

  // 默认档案：优先已连接。
  useEffect(() => {
    if (profiles.length === 0) return
    if (!leftProfileId || !profiles.some(p => p.id === leftProfileId)) {
      const ready = profiles.find(p => connections.some(c => c.profileId === p.id && c.state === 'ready' && c.alive))
      setLeftProfileId((ready ?? profiles[0]).id)
    }
    if (rightMode === 'remote' && (!rightProfileId || !profiles.some(p => p.id === rightProfileId))) {
      const other = profiles.find(p => p.id !== leftProfileId)
      setRightProfileId(other?.id ?? '')
    }
  }, [profiles, connections, leftProfileId, rightProfileId, rightMode])

  // 自动连接：未连接档案 → conn.open + 轮询 ready。
  const ensureConn = useCallback(async (profileId: string) => {
    if (!profileId) return
    if (connections.some(c => c.profileId === profileId && c.state === 'ready' && c.alive)) return
    setBusyProfile(profileId)
    try {
      const st = await invokeAs<ConnectionInfo>('conn.open', { profileId })
      const deadline = Date.now() + CONNECT_WAIT_MS
      if (st.state === 'ready') {
        onConnectionsChanged()
        return
      }
      while (Date.now() < deadline) {
        const res = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', {
          connectionId: st.connectionId,
        })
        const conn = res.connections?.[0]
        if (conn?.state === 'ready') {
          onConnectionsChanged()
          return
        }
        if (conn?.state === 'needInput') {
          message.warning(t('sftp.needAuth'))
          onConnectionsChanged()
          return
        }
        if (conn?.state === 'failed' || conn?.state === 'cancelled') {
          message.error(conn.error ?? t('form.testFailed'))
          onConnectionsChanged()
          return
        }
        await new Promise(r => setTimeout(r, 500))
      }
      message.error(t('sftp.connecting'))
    } catch (e) {
      message.error(describeError(e))
    } finally {
      setBusyProfile('')
    }
  }, [connections, onConnectionsChanged])

  // 左栏加载
  const loadLeft = useCallback(async (path: string, offset = 0) => {
    if (!leftConn) return
    try {
      const res = await invokeAs<{ entries: FsEntry[]; more: boolean }>('sftp.list', {
        connectionId: leftConn.connectionId, path: path || '.', offset, limit: 500,
      })
      if (offset === 0) setLeftEntries(res.entries ?? [])
      else setLeftEntries(prev => [...prev, ...(res.entries ?? [])])
      setLeftMore(res.more)
      setLeftOffset(offset)
    } catch (e) {
      message.error(describeError(e))
    }
  }, [leftConn])

  const openLeft = useCallback((path: string) => {
    setLeftPath(path)
    setEditLeftPath(false)
    leftNav.push(path)
    void loadLeft(path, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLeft])

  // 右栏加载（local / remote B）
  const loadLocal = useCallback(async (path: string) => {
    try {
      const res = await invokeAs<{ entries: FsEntry[]; home: string }>('fs.listLocal', { path })
      setLocalEntries(res.entries ?? [])
      localHomeRef.current = res.home ?? ''
      return res.home ?? ''
    } catch (e) {
      message.error(describeError(e))
      return ''
    }
  }, [])

  const loadRight = useCallback(async (path: string) => {
    if (!rightConn) return
    try {
      const res = await invokeAs<{ entries: FsEntry[] }>('sftp.list', {
        connectionId: rightConn.connectionId, path: path || '.', offset: 0, limit: 500,
      })
      setRightEntries(res.entries ?? [])
    } catch (e) {
      message.error(describeError(e))
    }
  }, [rightConn])

  const openRight = useCallback((path: string, push = true) => {
    setRightPath(path)
    setEditRightPath(false)
    if (push) rightNav.push(path)
    if (rightMode === 'local') void loadLocal(path)
    else void loadRight(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightMode, loadLocal, loadRight])

  // 档案切换 → 自动连接；连接就绪 → 载入目录。
  useEffect(() => { if (leftProfileId) void ensureConn(leftProfileId) }, [leftProfileId, ensureConn])
  useEffect(() => {
    if (rightMode === 'remote' && rightProfileId) void ensureConn(rightProfileId)
  }, [rightMode, rightProfileId, ensureConn])
  useEffect(() => {
    if (leftConn) openLeft(leftPath || '.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftConn?.connectionId])
  useEffect(() => {
    if (rightMode === 'remote') {
      if (rightConn) openRight('.')
    } else if (rightPath === '' || !rightPath) {
      // 首次进入本机模式：加载用户主目录。
      void loadLocal('').then(home => {
        if (home) { setRightPath(home); rightNav.push(home) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightMode, rightConn?.connectionId])

  const peerSame = rightMode === 'remote' && leftProfileId !== '' && leftProfileId === rightProfileId

  // 传输队列轮询（链式，防堆积）。
  useEffect(() => {
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (stopped) return
      if (!inFlight) {
        inFlight = true
        try {
          const res = await invokeAs<{ tasks: TransferStatus[] }>('transfer.list', {})
          if (!stopped) setTransfers(res.tasks ?? [])
        } catch { /* 忽略 */ }
        inFlight = false
      }
      if (!stopped) timer = setTimeout(tick, 1000)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])

  // 传输：本机 ↔ 远端 / 远端 ↔ 远端。
  const transferToPeer = async (side: 'left' | 'right') => {
    if (peerSame) { message.warning(t('sftp.peerSame')); return }
    const sel = side === 'left' ? leftSel : (rightMode === 'local' ? localSel : rightSel)
    if (!sel || sel.isDir) { message.warning(t('sftp.sendToPeer')); return }
    if (!leftConn) return
    try {
      if (side === 'left') {
        if (rightMode === 'local') {
          await invokeAs('transfer.start', {
            connectionId: leftConn.connectionId, direction: 'download',
            remotePath: sel.path, localPath: joinLocal(rightPath, sel.name),
          })
        } else if (rightConn) {
          await invokeAs('transfer.start', {
            connectionId: leftConn.connectionId, direction: 'serverToServer',
            remotePath: sel.path,
            targetConnectionId: rightConn.connectionId,
            targetPath: joinRemote(rightPath, sel.name),
          })
        }
      } else if (rightMode === 'local') {
        await invokeAs('transfer.start', {
          connectionId: leftConn.connectionId, direction: 'upload',
          localPath: sel.path, remotePath: joinRemote(leftPath, sel.name),
        })
      } else if (rightConn) {
        await invokeAs('transfer.start', {
          connectionId: rightConn.connectionId, direction: 'serverToServer',
          remotePath: sel.path,
          targetConnectionId: leftConn.connectionId,
          targetPath: joinRemote(leftPath, sel.name),
        })
      }
      message.success(t('sftp.sendToPeer'))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const uploadFromPicker = async () => {
    if (!leftConn) return
    const pickFile = window.gonaviPlugin?.pickFile?.bind(window.gonaviPlugin)
    if (pickFile) {
      try {
        const picked = await pickFile({ title: t('sftp.upload') })
        if (picked === null) return
        if (picked) {
          const name = picked.split(/[\\/]/).pop() || 'file'
          await invokeAs('transfer.start', {
            connectionId: leftConn.connectionId, direction: 'upload',
            localPath: picked, remotePath: joinRemote(leftPath, name),
          })
          message.success(t('state.upload'))
          return
        }
      } catch (e) {
        message.error(describeError(e))
        return
      }
    }
    await transferToPeer('right')
  }

  const doPreview = async (entry: FsEntry, side: 'left' | 'right') => {
    const conn = side === 'left' ? leftConn : rightConn
    if (!conn) return
    try {
      const res = await invokeAs<{ dataBase64: string }>('sftp.preview', {
        connectionId: conn.connectionId, path: entry.path, maxBytes: 262144,
      })
      const text = decodeText(res.dataBase64)
      const nul = [...text].filter(c => c === '\u0000').length
      if (nul > text.length / 100) {
        message.warning(`${entry.name}: binary`)
        return
      }
      setPreview({ path: entry.path, content: text, dirty: text, side })
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const savePreview = async () => {
    if (!preview) return
    const conn = preview.side === 'left' ? leftConn : rightConn
    if (!conn) return
    try {
      await invokeAs('sftp.writeFile', {
        connectionId: conn.connectionId, path: preview.path, dataBase64: encodeText(preview.dirty),
      })
      message.success(t('sftp.saveFile'))
      setPreview(null)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const simplePrompt = (title: string): Promise<string | null> =>
    new Promise(resolve => {
      let value = ''
      Modal.confirm({
        title,
        content: <Input onChange={e => { value = e.target.value }} />,
        onOk: () => resolve(value),
        onCancel: () => resolve(null),
      })
    })

  const remoteAction = async (action: string, args: Record<string, unknown>) => {
    if (!leftConn) return
    try {
      await invokeAs(action, { connectionId: leftConn.connectionId, ...args })
      void loadLeft(leftPath, 0)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const showDu = async () => {
    if (!leftConn) return
    try {
      const res = await invokeAs<{ totalBytes: number; availBytes: number }>('sftp.du', {
        connectionId: leftConn.connectionId, path: leftPath,
      })
      setDu(`${leftPath}: ${fmtBytes(res.totalBytes - res.availBytes)} / ${fmtBytes(res.totalBytes)}`)
    } catch (e) {
      setDu(describeError(e))
    }
  }

  const copyPath = async (path: string) => {
    const full = path || localHomeRef.current
    if (!full) return
    try {
      await navigator.clipboard.writeText(full)
      message.success(`${t('sftp.copyPath')}: ${full}`)
    } catch {
      message.warning(full)
    }
  }

  const entryList = (
    entries: FsEntry[],
    selected: FsEntry | null,
    onSelect: (e: FsEntry) => void,
    onOpen: (e: FsEntry) => void,
    more?: { show: boolean; onLoad: () => void },
  ) => (
    <List
      size="small"
      className="fs-list"
      dataSource={entries}
      renderItem={e => (
        <List.Item
          className={`fs-item ${selected?.path === e.path ? 'fs-selected' : ''}`}
          onClick={() => onSelect(e)}
          onDoubleClick={() => onOpen(e)}
        >
          <span className="fs-icon">{e.isDir ? '📁' : e.isLink ? '🔗' : '📄'}</span>
          <span className="fs-name" title={e.name}>{e.name}</span>
          <span className="fs-meta">{e.isDir ? '' : fmtBytes(e.size)}</span>
        </List.Item>
      )}
      footer={more?.show ? <Button size="small" type="link" onClick={more.onLoad}>more…</Button> : undefined}
    />
  )

  const profileOptions = useMemo(
    () => profiles.map(p => ({
      value: p.id,
      label: `${p.name} · ${p.user}@${p.host}:${p.port}`,
    })),
    [profiles],
  )

  if (profiles.length === 0) {
    return <div className="empty-hint">{t('sftp.noProfiles')}</div>
  }

  const rightEntriesView = rightMode === 'local' ? localEntries : rightEntries
  const rightSelected = rightMode === 'local' ? localSel : rightSel
  const rightSubject = rightMode === 'local' ? (localHomeRef.current || t('sftp.computer')) : (rightConn?.addr ?? '')

  return (
    <div className="sftp-wrap">
      <div className="sftp-columns">
        {/* 左栏：远程 A */}
        <div className="fs-pane fs-pane-remote">
          <div className="fs-pane-head">
            <Space size={6} className="pane-title">
              <Tag color="blue" style={{ marginRight: 0 }}>{t('sftp.remote')}</Tag>
              <Select
                size="small"
                value={leftProfileId || undefined}
                placeholder={t('sftp.pickProfile')}
                style={{ minWidth: 190 }}
                options={profileOptions}
                onChange={setLeftProfileId}
                loading={busyProfile === leftProfileId}
              />
            </Space>
            <Space size={4} wrap>
              <Button size="small" icon={<ArrowLeftOutlined />} disabled={!leftNav.canBack}
                title={t('sftp.back')} onClick={() => { const p = leftNav.back(); if (p !== null) openLeft(p) }} />
              <Button size="small" icon={<ArrowRightOutlined />} disabled={!leftNav.canForward}
                title={t('sftp.forward')} onClick={() => { const p = leftNav.forward(); if (p !== null) openLeft(p) }} />
              <Button size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
                onClick={() => openLeft(parentRemote(leftPath))} />
              <Button size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')}
                onClick={() => loadLeft(leftPath, 0)} />
              <Button size="small" icon={<FolderAddOutlined />} title={t('sftp.mkdir')}
                onClick={async () => {
                  const name = await simplePrompt(t('sftp.mkdir'))
                  if (name) await remoteAction('sftp.mkdir', { path: joinRemote(leftPath, name) })
                }} />
              <Button size="small" icon={<SwapOutlined />} title={t('sftp.sendToPeer')}
                disabled={!leftConn} onClick={() => transferToPeer('left')} />
              <Button size="small" icon={<DeleteOutlined />} title={t('sftp.remove')} danger
                disabled={!leftSel}
                onClick={async () => {
                  if (!leftSel) return
                  if (leftSel.isDir) await remoteAction('sftp.removeRecursive', { path: leftSel.path })
                  else await remoteAction('sftp.remove', { path: leftSel.path })
                }} />
              <Button size="small" onClick={showDu} disabled={!leftConn}>{t('sftp.du')}</Button>
            </Space>
          </div>
          {editLeftPath ? (
            <Input
              size="small"
              autoFocus
              value={leftPath}
              onChange={e => setLeftPath(e.target.value)}
              onPressEnter={() => openLeft(leftPath)}
              onBlur={() => setEditLeftPath(false)}
            />
          ) : (
            <div className="path-bar">
              {leftConn ? (
                <PathBreadcrumb path={leftPath || '.'} homeHint onNavigate={openLeft} />
              ) : (
                <span className="crumb root">
                  {busyProfile === leftProfileId ? t('sftp.connecting') : t('sftp.pickProfile')}
                </span>
              )}
              <Tooltip title={t('sftp.copyPath')}>
                <CopyOutlined className="path-edit" onClick={() => copyPath(leftPath || '.')} />
              </Tooltip>
              <EditOutlined className="path-edit" title={t('sftp.editPath')} onClick={() => setEditLeftPath(true)} />
            </div>
          )}
          {du && <div className="fs-du">{du}</div>}
          <div className="fs-scroll">
            {entryList(leftEntries, leftSel, setLeftSel, e => {
              if (e.isDir) openLeft(e.path)
              else void doPreview(e, 'left')
            }, { show: leftMore, onLoad: () => loadLeft(leftPath, leftOffset + 500) })}
          </div>
        </div>

        {/* 右栏：本机 / 远程 B */}
        <div className={`fs-pane ${rightMode === 'local' ? 'fs-pane-local' : 'fs-pane-remote'}`}>
          <div className="fs-pane-head">
            <Space size={6} className="pane-title">
              <Segmented
                size="small"
                value={rightMode}
                onChange={v => {
                  setRightMode(v as 'local' | 'remote')
                  setRightPath('')
                }}
                options={[
                  { label: t('sftp.modeLocal'), value: 'local' },
                  { label: t('sftp.modeRemote'), value: 'remote' },
                ]}
              />
              {rightMode === 'local' ? (
                <Tag color="green" style={{ marginRight: 0 }}>{t('sftp.local')}</Tag>
              ) : (
                <Select
                  size="small"
                  value={rightProfileId || undefined}
                  placeholder={t('sftp.pickProfile')}
                  style={{ minWidth: 170 }}
                  options={profileOptions}
                  onChange={setRightProfileId}
                  loading={busyProfile === rightProfileId}
                  status={peerSame ? 'error' : undefined}
                />
              )}
            </Space>
            <Space size={4} wrap>
              <Button size="small" icon={<ArrowLeftOutlined />} disabled={!rightNav.canBack}
                title={t('sftp.back')} onClick={() => { const p = rightNav.back(); if (p !== null) openRight(p) }} />
              <Button size="small" icon={<ArrowRightOutlined />} disabled={!rightNav.canForward}
                title={t('sftp.forward')} onClick={() => { const p = rightNav.forward(); if (p !== null) openRight(p) }} />
              <Button size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
                onClick={() => openRight(rightMode === 'local' ? parentLocal(rightPath) : parentRemote(rightPath))} />
              <Button size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')}
                onClick={() => (rightMode === 'local' ? loadLocal(rightPath) : loadRight(rightPath))} />
              {rightMode === 'local' ? (
                <Button size="small" icon={<ArrowUpOutlined />} title={t('sftp.upload')}
                  disabled={!leftConn} onClick={uploadFromPicker} />
              ) : (
                <Button size="small" icon={<SwapOutlined />} title={t('sftp.sendToPeer')}
                  disabled={!rightConn || peerSame} onClick={() => transferToPeer('right')} />
              )}
            </Space>
          </div>
          {editRightPath ? (
            <Input
              size="small"
              autoFocus
              value={rightPath}
              onChange={e => setRightPath(e.target.value)}
              onPressEnter={() => openRight(rightPath)}
              onBlur={() => setEditRightPath(false)}
            />
          ) : (
            <div className="path-bar">
              {rightMode === 'remote' && !rightConn ? (
                <span className="crumb root">
                  {busyProfile === rightProfileId ? t('sftp.connecting') : t('sftp.pickProfile')}
                </span>
              ) : (
                <PathBreadcrumb
                  path={rightPath}
                  emptyLabel={rightSubject || t('sftp.computer')}
                  homeHint={rightMode === 'remote'}
                  onNavigate={openRight}
                />
              )}
              <Tooltip title={t('sftp.copyPath')}>
                <CopyOutlined className="path-edit" onClick={() => copyPath(rightPath)} />
              </Tooltip>
              <EditOutlined className="path-edit" title={t('sftp.editPath')} onClick={() => setEditRightPath(true)} />
            </div>
          )}
          <div className="fs-scroll">
            {entryList(
              rightEntriesView,
              rightSelected,
              e => (rightMode === 'local' ? setLocalSel(e) : setRightSel(e)),
              e => {
                if (e.isDir) openRight(e.path)
                else if (rightMode === 'remote') void doPreview(e, 'right')
              },
            )}
          </div>
        </div>
      </div>

      <div className="transfers-pane">
        <Typography.Text strong>{t('sftp.transfers')}</Typography.Text>
        <div className="fs-scroll transfers-list">
          {transfers.length === 0 ? (
            <div className="fs-empty">{t('sftp.transferIdle')}</div>
          ) : (
            transfers.slice(0, 12).map(tr => {
              const pct = tr.totalBytes > 0 ? Math.round((tr.bytesDone / tr.totalBytes) * 100) : 0
              const label =
                tr.direction === 'upload' ? t('state.upload')
                  : tr.direction === 'download' ? t('state.download')
                    : `${t('state.upload')} ⇄`
              const pathText =
                tr.direction === 'upload' ? tr.localPath
                  : tr.direction === 'serverToServer' ? `${tr.remotePath} → ${tr.peerPath}`
                    : tr.remotePath
              return (
                <div key={tr.id} className="transfer-row">
                  <Tag color={tr.direction === 'serverToServer' ? 'purple' : tr.direction === 'upload' ? 'blue' : 'green'}>
                    {label}
                  </Tag>
                  <span className="transfer-path" title={pathText}>{pathText}</span>
                  <span className="transfer-state">{t(`state.${tr.state}`)}</span>
                  {tr.state === 'running' && (
                    <>
                      <Progress percent={pct} size="small" style={{ width: 160 }} />
                      <span className="transfer-rate">{fmtBytes(tr.rateBps ?? 0)}/s</span>
                    </>
                  )}
                  {tr.state === 'failed' && tr.error && (
                    <Tooltip title={tr.error}><span className="transfer-err">!</span></Tooltip>
                  )}
                  {(tr.state === 'running' || tr.state === 'queued') && (
                    <a onClick={() => invokeAs('transfer.cancel', { taskId: tr.id }).catch(() => {})}>
                      {t('sftp.cancelTransfer')}
                    </a>
                  )}
                  {(tr.state === 'failed' || tr.state === 'cancelled') && (
                    <a onClick={() => invokeAs('transfer.retry', { taskId: tr.id, connectionId: tr.connectionId }).catch(e => message.error(describeError(e)))}>
                      {t('sftp.retry')}
                    </a>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <Modal
        title={`${t('sftp.preview')}: ${preview?.path ?? ''}`}
        open={preview !== null}
        onCancel={() => setPreview(null)}
        onOk={savePreview}
        okText={t('sftp.saveFile')}
        width={760}
      >
        <Input.TextArea
          rows={20}
          value={preview?.dirty ?? ''}
          onChange={e => setPreview(p => (p ? { ...p, dirty: e.target.value } : p))}
          style={{ fontFamily: 'Consolas, monospace' }}
        />
      </Modal>
    </div>
  )
}

function joinRemote(dir: string, name: string): string {
  if (!dir || dir === '.') return name
  return dir.replace(/\/+$/, '') + '/' + name
}

function parentRemote(path: string): string {
  if (!path || path === '/') return path
  const idx = path.replace(/\/+$/, '').lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function joinLocal(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

function parentLocal(path: string): string {
  if (!path) return ''
  if (/^[a-zA-Z]:[\\/]?$/.test(path)) return ''
  const uncParts = path.split(/[\\/]/).filter(Boolean)
  if (path.startsWith('\\\\') && uncParts.length <= 2) return ''
  let p = path.replace(/[\\/]+$/, '')
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (idx < 0) return ''
  let parent = p.slice(0, idx)
  if (/^[a-zA-Z]:$/.test(parent)) parent += '\\'
  if (parent === '') parent = path.startsWith('/') ? '/' : ''
  return parent
}
