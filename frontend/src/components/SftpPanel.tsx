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
  CloseOutlined,
  CopyOutlined,
  DashboardOutlined,
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

type Side = 'left' | 'right'
type PaneKind = 'local' | 'remote'

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

// 一栏的浏览历史（index 用 ref，reset 用于切换本机/服务器时清空）。
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
  const reset = () => {
    list.current = []
    idx.current = -1
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
  return { push, reset, back, forward, canBack, canForward }
}

export function SftpPanel({ profiles, connections, onConnectionsChanged, initialRemotePath }: Props) {
  // 对称双栏：左默认本机、右默认服务器（符合常见 FTP 客户端习惯）。
  const [leftKind, setLeftKind] = useState<PaneKind>('local')
  const [leftProfileId, setLeftProfileId] = useState('')
  const [leftPath, setLeftPath] = useState('')
  const [leftEntries, setLeftEntries] = useState<FsEntry[]>([])
  const [leftSel, setLeftSel] = useState<FsEntry | null>(null)
  const [leftMore, setLeftMore] = useState(false)
  const [leftOffset, setLeftOffset] = useState(0)
  const [editLeftPath, setEditLeftPath] = useState(false)
  const leftNav = useNavHistory()

  const [rightKind, setRightKind] = useState<PaneKind>('remote')
  const [rightProfileId, setRightProfileId] = useState('')
  const [rightPath, setRightPath] = useState(initialRemotePath ?? '')
  const [rightEntries, setRightEntries] = useState<FsEntry[]>([])
  const [rightSel, setRightSel] = useState<FsEntry | null>(null)
  const [rightMore, setRightMore] = useState(false)
  const [rightOffset, setRightOffset] = useState(0)
  const [editRightPath, setEditRightPath] = useState(false)
  const rightNav = useNavHistory()

  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [preview, setPreview] = useState<{ path: string; content: string; dirty: string; side: Side } | null>(null)
  const [du, setDu] = useState<{ side: Side; text: string } | null>(null)
  const [busyProfile, setBusyProfile] = useState('')

  const leftConn = leftKind === 'remote'
    ? connections.find(c => c.profileId === leftProfileId && c.state === 'ready' && c.alive)
    : undefined
  const rightConn = rightKind === 'remote'
    ? connections.find(c => c.profileId === rightProfileId && c.state === 'ready' && c.alive)
    : undefined

  const profileOptions = useMemo(
    () => profiles.map(p => ({
      value: p.id,
      label: `${p.name} · ${p.user}@${p.host}:${p.port}`,
    })),
    [profiles],
  )

  // 默认档案：左本机无需；右栏优先已连接。
  useEffect(() => {
    if (profiles.length === 0) return
    if (rightKind === 'remote' && (!rightProfileId || !profiles.some(p => p.id === rightProfileId))) {
      const ready = profiles.find(p => connections.some(c => c.profileId === p.id && c.state === 'ready' && c.alive))
      setRightProfileId((ready ?? profiles[0]).id)
    }
    if (leftKind === 'remote' && (!leftProfileId || !profiles.some(p => p.id === leftProfileId))) {
      const other = profiles.find(p => p.id !== rightProfileId) ?? profiles[0]
      setLeftProfileId(other.id)
    }
  }, [profiles, connections, rightKind, leftKind, rightProfileId, leftProfileId])

  // 自动连接：选中的档案未连接时发起连接并轮询就绪。
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

  // 通用加载：远端走 sftp.list，本机走 fs.listLocal（空路径返回 home）。
  const loadSide = useCallback(async (side: Side, path: string, offset = 0) => {
    const kind = side === 'left' ? leftKind : rightKind
    const conn = side === 'left' ? leftConn : rightConn
    if (kind === 'remote' && !conn) return
    try {
      if (kind === 'local') {
        const res = await invokeAs<{ entries: FsEntry[]; home: string }>('fs.listLocal', { path })
        if (side === 'left') {
          setLeftEntries(res.entries ?? [])
          if (!path && res.home) {
            setLeftPath(res.home)
            leftNav.push(res.home)
          }
        } else {
          setRightEntries(res.entries ?? [])
          if (!path && res.home) {
            setRightPath(res.home)
            rightNav.push(res.home)
          }
        }
        return
      }
      const res = await invokeAs<{ entries: FsEntry[]; more: boolean }>('sftp.list', {
        connectionId: conn!.connectionId, path: path || '.', offset, limit: 500,
      })
      if (side === 'left') {
        if (offset === 0) setLeftEntries(res.entries ?? [])
        else setLeftEntries(prev => [...prev, ...(res.entries ?? [])])
        setLeftMore(res.more)
        setLeftOffset(offset)
      } else {
        if (offset === 0) setRightEntries(res.entries ?? [])
        else setRightEntries(prev => [...prev, ...(res.entries ?? [])])
        setRightMore(res.more)
        setRightOffset(offset)
      }
    } catch (e) {
      message.error(describeError(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftKind, rightKind, leftConn, rightConn])

  // 打开路径（记录历史）。
  const openSide = useCallback((side: Side, path: string) => {
    if (side === 'left') {
      setLeftPath(path)
      setEditLeftPath(false)
      leftNav.push(path)
    } else {
      setRightPath(path)
      setEditRightPath(false)
      rightNav.push(path)
    }
    void loadSide(side, path, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSide])

  const navSide = (side: Side, dir: 'back' | 'forward') => {
    const nav = side === 'left' ? leftNav : rightNav
    const target = dir === 'back' ? nav.back() : nav.forward()
    if (target == null) return
    if (side === 'left') setLeftPath(target)
    else setRightPath(target)
    void loadSide(side, target, 0)
  }

  // 切换本机/服务器：清空该栏历史与内容，避免两边路径混入同一份历史。
  const switchKind = (side: Side, kind: PaneKind) => {
    if (side === 'left') {
      setLeftKind(kind)
      setLeftPath('')
      setLeftEntries([])
      setLeftSel(null)
      leftNav.reset()
      setDu(null)
      if (kind === 'remote' && leftProfileId) void ensureConn(leftProfileId)
      else if (kind === 'local') void loadSide('left', '', 0)
    } else {
      setRightKind(kind)
      setRightPath('')
      setRightEntries([])
      setRightSel(null)
      rightNav.reset()
      if (kind === 'remote' && rightProfileId) void ensureConn(rightProfileId)
      else if (kind === 'local') void loadSide('right', '', 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  // 连接就绪 / 模式切换后加载目录。
  useEffect(() => {
    if (leftKind === 'remote' && leftConn) {
      openSide('left', leftPath || '.')
    } else if (leftKind === 'local' && leftEntries.length === 0) {
      void loadSide('left', '', 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftConn?.connectionId, leftKind])
  useEffect(() => {
    if (rightKind === 'remote') {
      if (rightProfileId) void ensureConn(rightProfileId)
      if (rightConn) openSide('right', rightPath || '.')
    } else if (rightEntries.length === 0) {
      void loadSide('right', '', 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightConn?.connectionId, rightKind, rightProfileId])
  useEffect(() => {
    if (leftKind === 'remote' && leftProfileId) void ensureConn(leftProfileId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftKind, leftProfileId])
  useEffect(() => {
    // 终端目录跟随：刷新右侧远程（默认栏）到新目录。
    if (initialRemotePath && rightKind === 'remote' && rightConn) {
      openSide('right', initialRemotePath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRemotePath])

  const peerSame = leftKind === 'remote' && rightKind === 'remote' && leftProfileId !== '' && leftProfileId === rightProfileId

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

  // 把 from 栏选中项送到对侧：本地↔远端 / 远端↔远端。
  const sendToPeer = async (from: Side) => {
    if (peerSame) { message.warning(t('sftp.peerSame')); return }
    const srcSel = from === 'left' ? leftSel : rightSel
    const srcKind = from === 'left' ? leftKind : rightKind
    const dstKind = from === 'left' ? rightKind : leftKind
    const srcConn = from === 'left' ? leftConn : rightConn
    const dstConn = from === 'left' ? rightConn : leftConn
    const dstPath = from === 'left' ? rightPath : leftPath
    if (!srcSel || srcSel.isDir) { message.warning(t('sftp.sendToPeer')); return }
    if (srcKind === 'local' && dstKind === 'local') {
      message.warning(t('sftp.sendToPeer'))
      return
    }
    try {
      if (srcKind === 'local' && dstKind === 'remote') {
        if (!dstConn) return
        await invokeAs('transfer.start', {
          connectionId: dstConn.connectionId, direction: 'upload',
          localPath: srcSel.path, remotePath: joinRemote(dstPath, srcSel.name),
        })
      } else if (srcKind === 'remote' && dstKind === 'local') {
        if (!srcConn) return
        await invokeAs('transfer.start', {
          connectionId: srcConn.connectionId, direction: 'download',
          remotePath: srcSel.path, localPath: joinLocal(dstPath, srcSel.name),
        })
      } else {
        if (!srcConn || !dstConn) return
        await invokeAs('transfer.start', {
          connectionId: srcConn.connectionId, direction: 'serverToServer',
          remotePath: srcSel.path,
          targetConnectionId: dstConn.connectionId,
          targetPath: joinRemote(dstPath, srcSel.name),
        })
      }
      message.success(t('sftp.sendToPeer'))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  // 本机栏上传按钮：原生选择器选文件后送入对侧远端（对侧须为服务器）。
  const uploadFromPicker = async (side: Side) => {
    const dstConn = side === 'left' ? rightConn : leftConn
    const dstPath = side === 'left' ? rightPath : leftPath
    const dstKind = side === 'left' ? rightKind : leftKind
    if (dstKind !== 'remote' || !dstConn) {
      message.warning(t('sftp.sendToPeer'))
      return
    }
    const pickFile = window.gonaviPlugin?.pickFile?.bind(window.gonaviPlugin)
    if (!pickFile) { await sendToPeer(side); return }
    try {
      const picked = await pickFile({ title: t('sftp.upload') })
      if (picked === null) return
      if (!picked) { await sendToPeer(side); return }
      const name = picked.split(/[\\/]/).pop() || 'file'
      await invokeAs('transfer.start', {
        connectionId: dstConn.connectionId, direction: 'upload',
        localPath: picked, remotePath: joinRemote(dstPath, name),
      })
      message.success(t('state.upload'))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const doPreview = async (entry: FsEntry, side: Side) => {
    const conn = side === 'left' ? leftConn : rightConn
    const kind = side === 'left' ? leftKind : rightKind
    if (kind === 'remote' && !conn) return
    if (kind === 'local') return // 本地不提供预览编辑（避免误改本机文件）
    try {
      const res = await invokeAs<{ dataBase64: string }>('sftp.preview', {
        connectionId: conn!.connectionId, path: entry.path, maxBytes: 262144,
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

  const remoteAction = async (side: Side, action: string, args: Record<string, unknown>) => {
    const conn = side === 'left' ? leftConn : rightConn
    if (!conn) return
    try {
      await invokeAs(action, { connectionId: conn.connectionId, ...args })
      void loadSide(side, side === 'left' ? leftPath : rightPath, 0)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  // 磁盘用量：作用于点击的远程栏；再点一次（或点关闭）收起。
  const showDu = async (side: Side) => {
    if (du && du.side === side) {
      setDu(null)
      return
    }
    const conn = side === 'left' ? leftConn : rightConn
    const path = side === 'left' ? leftPath : rightPath
    if (!conn) return
    try {
      const res = await invokeAs<{ totalBytes: number; availBytes: number }>('sftp.du', {
        connectionId: conn.connectionId, path,
      })
      setDu({ side, text: `${path}: ${fmtBytes(res.totalBytes - res.availBytes)} / ${fmtBytes(res.totalBytes)}` })
    } catch (e) {
      setDu({ side, text: describeError(e) })
    }
  }

  const copyPath = async (path: string) => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      message.success(`${t('sftp.copyPath')}: ${path}`)
    } catch {
      message.warning(path)
    }
  }

  if (profiles.length === 0) {
    return <div className="empty-hint">{t('sftp.noProfiles')}</div>
  }

  // 一栏的完整渲染（纯展示，状态由主组件持有）。
  const renderPane = (side: Side) => {
    const kind = side === 'left' ? leftKind : rightKind
    const profileId = side === 'left' ? leftProfileId : rightProfileId
    const conn = side === 'left' ? leftConn : rightConn
    const path = side === 'left' ? leftPath : rightPath
    const entries = side === 'left' ? leftEntries : rightEntries
    const sel = side === 'left' ? leftSel : rightSel
    const nav = side === 'left' ? leftNav : rightNav
    const more = side === 'left' ? leftMore : rightMore
    const offset = side === 'left' ? leftOffset : rightOffset
    const editing = side === 'left' ? editLeftPath : editRightPath
    const isLocal = kind === 'local'

    return (
      <div className={`fs-pane ${isLocal ? 'fs-pane-local' : 'fs-pane-remote'}`}>
        <div className="fs-pane-head">
          <Segmented
            size="small"
            value={kind}
            onChange={v => switchKind(side, v as PaneKind)}
            options={[
              { label: t('sftp.modeLocal'), value: 'local' },
              { label: t('sftp.modeRemote'), value: 'remote' },
            ]}
          />
          {isLocal ? (
            <Tag color="green" style={{ marginRight: 0 }}>{t('sftp.local')}</Tag>
          ) : (
            <Select
              size="small"
              value={profileId || undefined}
              placeholder={t('sftp.pickProfile')}
              style={{ flex: 1, minWidth: 150, maxWidth: 260 }}
              options={profileOptions}
              onChange={v => {
                if (side === 'left') setLeftProfileId(v)
                else setRightProfileId(v)
              }}
              loading={busyProfile === profileId}
              status={peerSame ? 'error' : undefined}
            />
          )}
        </div>
        <div className="pane-toolbar">
          <Space size={4} wrap>
            <Button size="small" icon={<ArrowLeftOutlined />} disabled={!nav.canBack}
              title={t('sftp.back')} onClick={() => navSide(side, 'back')} />
            <Button size="small" icon={<ArrowRightOutlined />} disabled={!nav.canForward}
              title={t('sftp.forward')} onClick={() => navSide(side, 'forward')} />
            <Button size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
              onClick={() => openSide(side, isLocal ? parentLocal(path) : parentRemote(path))} />
            <Button size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')}
              onClick={() => loadSide(side, path, 0)} />
            {isLocal ? (
              <Button size="small" icon={<ArrowUpOutlined />} title={t('sftp.upload')}
                disabled={!(side === 'left' ? rightConn : leftConn)}
                onClick={() => uploadFromPicker(side)} />
            ) : (
              <>
                <Button size="small" icon={<FolderAddOutlined />} title={t('sftp.mkdir')}
                  onClick={async () => {
                    const name = await simplePrompt(t('sftp.mkdir'))
                    if (name) await remoteAction(side, 'sftp.mkdir', { path: joinRemote(path, name) })
                  }} />
                <Button size="small" icon={<DeleteOutlined />} title={t('sftp.remove')} danger
                  disabled={!sel}
                  onClick={async () => {
                    if (!sel) return
                    if (sel.isDir) await remoteAction(side, 'sftp.removeRecursive', { path: sel.path })
                    else await remoteAction(side, 'sftp.remove', { path: sel.path })
                  }} />
                <Button size="small" icon={<DashboardOutlined />} title={t('sftp.du')}
                  onClick={() => showDu(side)} disabled={!conn} />
              </>
            )}
            <Button size="small" icon={<SwapOutlined />} title={t('sftp.sendToPeer')}
              disabled={isLocal ? !(side === 'left' ? rightConn : leftConn) : !conn}
              onClick={() => sendToPeer(side)} />
          </Space>
        </div>
        {editing ? (
          <Input
            size="small"
            autoFocus
            value={path}
            onChange={e => {
              if (side === 'left') setLeftPath(e.target.value)
              else setRightPath(e.target.value)
            }}
            onPressEnter={() => openSide(side, path)}
            onBlur={() => {
              if (side === 'left') setEditLeftPath(false)
              else setEditRightPath(false)
            }}
          />
        ) : (
          <div className="path-bar">
            {isLocal ? (
              <PathBreadcrumb
                path={path}
                emptyLabel={t('sftp.computer')}
                onNavigate={p => openSide(side, p)}
              />
            ) : conn ? (
              <PathBreadcrumb path={path || '.'} homeHint onNavigate={p => openSide(side, p)} />
            ) : (
              <span className="crumb root">
                {busyProfile === profileId ? t('sftp.connecting') : t('sftp.pickProfile')}
              </span>
            )}
            <Tooltip title={t('sftp.copyPath')}>
              <CopyOutlined className="path-edit" onClick={() => copyPath(path)} />
            </Tooltip>
            <EditOutlined
              className="path-edit"
              title={t('sftp.editPath')}
              onClick={() => {
                if (side === 'left') setEditLeftPath(true)
                else setEditRightPath(true)
              }}
            />
          </div>
        )}
        {du && du.side === side && (
          <div className="fs-du">
            <span>{du.text}</span>
            <CloseOutlined className="fs-du-close" onClick={() => setDu(null)} />
          </div>
        )}
        <div className="fs-scroll">
          <List
            size="small"
            className="fs-list"
            dataSource={entries}
            renderItem={e => (
              <List.Item
                className={`fs-item ${sel?.path === e.path ? 'fs-selected' : ''}`}
                onClick={() => {
                  if (side === 'left') setLeftSel(e)
                  else setRightSel(e)
                }}
                onDoubleClick={() => {
                  if (e.isDir) openSide(side, e.path)
                  else if (!isLocal) void doPreview(e, side)
                }}
              >
                <span className="fs-icon">{e.isDir ? '📁' : e.isLink ? '🔗' : '📄'}</span>
                <span className="fs-name" title={e.name}>{e.name}</span>
                <span className="fs-meta">{e.isDir ? '' : fmtBytes(e.size)}</span>
              </List.Item>
            )}
            footer={
              more ? (
                <Button size="small" type="link" onClick={() => loadSide(side, path, offset + 500)}>more…</Button>
              ) : undefined
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="sftp-wrap">
      <div className="sftp-columns">
        {renderPane('left')}
        {renderPane('right')}
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
