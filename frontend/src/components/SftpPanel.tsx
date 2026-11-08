import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dropdown,
  Input,
  List,
  message,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Tooltip,
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  CopyOutlined,
  DashboardOutlined,
  DownOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderFilled,
  HddOutlined,
  LaptopOutlined,
  FileOutlined,
  LinkOutlined,
  MoreOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SwapOutlined,
  UpOutlined,
} from '@ant-design/icons'
import { invokeAs, describeError } from '../bridge'
import { copyToClipboard } from '../clipboard'
import { FilePreviewModal } from './FilePreviewModal'
import { fmtBytes, fmtMtime, joinLocal, joinRemote } from '../fsFormat'
import { t } from '../i18n'
import type { ConnectionInfo, FsEntry, ProfileView, TransferStatus } from '../types'
import { PathBreadcrumb } from './PathBreadcrumb'
import { createPaneRequests, type PaneScope } from './sftpRequests'

type Side = 'left' | 'right'
type PaneKind = 'local' | 'remote'

interface Props {
  profiles: ProfileView[]
  connections: ConnectionInfo[]
  onConnectionsChanged: () => void
  initialRemotePath?: string | null
  /** 在活动终端里 cd 到此远端目录（没有可用终端时由上层提示）。 */
  onCdTo?: (remotePath: string) => void
}

const CONNECT_WAIT_MS = 20000

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

export function SftpPanel({ profiles, connections, onConnectionsChanged, initialRemotePath, onCdTo }: Props) {
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
  const [pathDraft, setPathDraft] = useState({ left: '', right: '' })
  const rightNav = useNavHistory()

  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [transfersExpanded, setTransfersExpanded] = useState(true)
  const showTransfers = transfers.length > 0 && transfersExpanded
  const activeTransfers = transfers.filter(tr => tr.state === 'running' || tr.state === 'queued').length
  const attentionTransfers = transfers.filter(tr => tr.state === 'failed' || tr.state === 'interrupted').length
  // 预览交给公共组件（filePreview 只留"打开的是哪一个"）。side 记下来是为了
  // 保存后能刷新对应那一栏的大小/时间。
  const [previewTarget, setPreviewTarget] = useState<{ connectionId: string; path: string; name: string; side: Side } | null>(null)
  const [du, setDu] = useState<{ side: Side; text: string; scope: PaneScope } | null>(null)
  const paneRequests = useRef({ left: createPaneRequests(), right: createPaneRequests() })
  const entryScopes = useRef<Record<Side, PaneScope>>({ left: { epoch: -1 }, right: { epoch: -1 } })
  const duRequest = useRef({ left: 0, right: 0 })
  const [busyProfile, setBusyProfile] = useState('')
  const connectingProfiles = useRef(new Set<string>())

  const leftConn = leftKind === 'remote'
    ? connections.find(c => c.profileId === leftProfileId && c.state === 'ready' && c.alive)
    : undefined
  const rightConn = rightKind === 'remote'
    ? connections.find(c => c.profileId === rightProfileId && c.state === 'ready' && c.alive)
    : undefined

  paneRequests.current.left.bind([leftKind, leftProfileId, leftConn?.connectionId ?? '', leftPath])
  paneRequests.current.right.bind([rightKind, rightProfileId, rightConn?.connectionId ?? '', rightPath])
  useEffect(() => () => {
    paneRequests.current.left.invalidate()
    paneRequests.current.right.invalidate()
    duRequest.current.left++; duRequest.current.right++
  }, [])

  const profileOptions = useMemo(
    () => profiles.map(p => ({
      value: `remote:${p.id}`,
      label: p.name,
      title: `${p.user}@${p.host}:${p.port}`,
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

  // 仅用户选择服务器或点击连接时建连；状态刷新不能撤销手动断开。
  const ensureConn = useCallback(async (profileId: string) => {
    if (!profiles.some(p => p.id === profileId) || connectingProfiles.current.has(profileId)) return
    if (connections.some(c => c.profileId === profileId && c.state === 'ready' && c.alive)) return
    connectingProfiles.current.add(profileId)
    setBusyProfile(profileId)
    try {
      const st = await invokeAs<ConnectionInfo>('conn.open', { profileId })
      const deadline = Date.now() + CONNECT_WAIT_MS
      if (st.state === 'ready') {
        onConnectionsChanged()
        return
      }
      if (st.state === 'needInput') { message.warning(t('sftp.needAuth')); onConnectionsChanged(); return }
      if (st.state === 'failed' || st.state === 'cancelled') { message.error(st.error ?? t('form.testFailed')); onConnectionsChanged(); return }
      if (!st.connectionId) return
      while (Date.now() < deadline) {
        const res = await invokeAs<{ connections: ConnectionInfo[] }>('conn.status', {
          connectionId: st.connectionId,
        })
        const conn = res.connections?.[0]
        if (!conn) return // 手动断开已摘除连接，停止本次等待而不是再次建连。
        if (conn.state === 'ready') {
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
      connectingProfiles.current.delete(profileId)
      setBusyProfile(current => current === profileId ? '' : current)
    }
  }, [profiles, connections, onConnectionsChanged])

  // 请求源身份在发出时冻结，路径/连接/刷新变化后只允许当前世代落地。
  const loadSide = useCallback(async (side: Side, path: string, offset = 0) => {
    const kind = side === 'left' ? leftKind : rightKind
    const conn = side === 'left' ? leftConn : rightConn
    const profileId = side === 'left' ? leftProfileId : rightProfileId
    const requests = paneRequests.current[side]
    requests.bind([kind, profileId, conn?.connectionId ?? '', path])
    const request = requests.begin(offset)
    if (!request || (kind === 'remote' && !conn)) return
    if (offset === 0) {
      if (side === 'left') { setLeftEntries([]); setLeftSel(null); setLeftMore(false); setLeftOffset(0) }
      else { setRightEntries([]); setRightSel(null); setRightMore(false); setRightOffset(0) }
      setDu(current => current?.side === side ? null : current)
    }
    try {
      const res = kind === 'local'
        ? await invokeAs<{ entries: FsEntry[]; home?: string; more?: boolean }>('fs.listLocal', { path })
        : await invokeAs<{ entries: FsEntry[]; home?: string; more?: boolean }>('sftp.list', {
          connectionId: conn!.connectionId, path: path || '.', offset, limit: 500,
        })
      if (!requests.accepts(request)) return
      const resolvedPath = kind === 'local' && !path && res.home ? res.home : path
      if (!requests.finish(request, [kind, profileId, conn?.connectionId ?? '', resolvedPath])) return
      entryScopes.current[side] = request.scope
      const append = (prev: FsEntry[]) => offset === 0 ? res.entries ?? []
        : [...prev, ...(res.entries ?? []).filter(entry => !prev.some(old => old.path === entry.path))]
      if (side === 'left') {
        setLeftEntries(append); setLeftMore(!!res.more); setLeftOffset(offset)
        if (resolvedPath !== path) { setLeftPath(resolvedPath); leftNav.push(resolvedPath) }
      } else {
        setRightEntries(append); setRightMore(!!res.more); setRightOffset(offset)
        if (resolvedPath !== path) { setRightPath(resolvedPath); rightNav.push(resolvedPath) }
      }
    } catch (e) {
      if (requests.fail(request)) message.error(describeError(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftKind, rightKind, leftProfileId, rightProfileId, leftConn, rightConn])

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
  const switchKind = (side: Side, kind: PaneKind, selectedProfileId?: string) => {
    paneRequests.current[side].invalidate()
    const current = selectedProfileId ?? (side === 'left' ? leftProfileId : rightProfileId)
    const fallback = side === 'left'
      ? profiles.find(p => p.id !== rightProfileId)
      : profiles.find(p => connections.some(c => c.profileId === p.id && c.state === 'ready' && c.alive))
    const profileId = profiles.find(p => p.id === current)?.id ?? (fallback ?? profiles[0])?.id ?? ''
    if (side === 'left') {
      setLeftKind(kind)
      setLeftPath('')
      setLeftEntries([])
      setLeftSel(null)
      leftNav.reset()
      if (kind === 'remote') setLeftProfileId(profileId)
    } else {
      setRightKind(kind)
      setRightPath('')
      setRightEntries([])
      setRightSel(null)
      rightNav.reset()
      if (kind === 'remote') setRightProfileId(profileId)
    }
    if (kind === 'remote') void ensureConn(profileId)
  }

  // 连接就绪 / 模式切换后加载目录。
  useEffect(() => {
    if (leftKind === 'remote') {
      if (leftConn) openSide('left', leftPath)
      else { setLeftEntries([]); setLeftSel(null); setLeftMore(false); setDu(current => current?.side === 'left' ? null : current) }
    } else if (leftKind === 'local' && leftEntries.length === 0) {
      void loadSide('left', '', 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftConn?.connectionId, leftKind, leftProfileId])
  useEffect(() => {
    if (rightKind === 'remote') {
      if (rightConn) openSide('right', rightPath)
      else { setRightEntries([]); setRightSel(null); setRightMore(false); setDu(current => current?.side === 'right' ? null : current) }
    } else if (rightEntries.length === 0) {
      void loadSide('right', '', 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightConn?.connectionId, rightKind, rightProfileId])
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
  // override 供右键菜单用：它作用于鼠标下的那一行，而不是（可能还没更新的）选中项。
  const sendToPeer = async (from: Side, scope: PaneScope, override?: FsEntry) => {
    if (peerSame) { message.warning(t('sftp.peerSame')); return }
    if (!paneRequests.current[from].source(scope)) return
    const srcSel = override ?? (from === 'left' ? leftSel : rightSel)
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
  const uploadFromPicker = async (side: Side, scope: PaneScope) => {
    const dstConn = side === 'left' ? rightConn : leftConn
    const dstPath = side === 'left' ? rightPath : leftPath
    const dstKind = side === 'left' ? rightKind : leftKind
    if (dstKind !== 'remote' || !dstConn) {
      message.warning(t('sftp.sendToPeer'))
      return
    }
    const targetSide = side === 'left' ? 'right' : 'left'
    const targetScope = paneRequests.current[targetSide].capture()
    const pickFile = window.gonaviPlugin?.pickFile?.bind(window.gonaviPlugin)
    if (!pickFile) { await sendToPeer(side, scope); return }
    try {
      const picked = await pickFile({ title: t('sftp.upload') })
      if (!paneRequests.current[targetSide].current(targetScope) || picked === null) return
      if (!picked) { await sendToPeer(side, scope); return }
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

  // 双击与右键「打开」都走这里：目录进目录，远端文件交给公共预览弹窗。
  const openEntry = (entry: FsEntry, side: Side, scope: PaneScope) => {
    if (!paneRequests.current[side].source(scope)) return
    if (entry.isDir) {
      openSide(side, entry.path)
      return
    }
    const conn = side === 'left' ? leftConn : rightConn
    // 本地栏不做预览编辑：那是用户自己的文件，不该从插件里改。
    if (side === 'left' || !conn) return
    setPreviewTarget({ connectionId: conn.connectionId, path: entry.path, name: entry.name, side })
  }

  // 用本机程序打开：后端把文件取到插件数据目录再唤起系统默认程序。改动不会
  // 自动回写，要上传由用户显式做——顺手存一下就覆盖远端太危险。
  const openExternal = async (entry: FsEntry, side: Side) => {
    const conn = side === 'left' ? leftConn : rightConn
    if (side === 'left' || !conn || entry.isDir) return
    try {
      await invokeAs('sftp.openExternal', { connectionId: conn.connectionId, path: entry.path })
      message.success(t('sftp.openExternalStarted', { name: entry.name }))
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

  const remoteAction = async (side: Side, action: string, args: Record<string, unknown>, scope: PaneScope) => {
    const requests = paneRequests.current[side]
    const conn = side === 'left' ? leftConn : rightConn
    if (!conn || !requests.current(scope)) return
    try {
      await invokeAs(action, { connectionId: conn.connectionId, ...args })
      if (requests.current(scope)) void loadSide(side, side === 'left' ? leftPath : rightPath, 0)
    } catch (e) {
      if (requests.current(scope)) message.error(describeError(e))
    }
  }

  // 磁盘用量：作用于点击的远程栏；再点一次（或点关闭）收起。
  const showDu = async (side: Side, scope: PaneScope) => {
    if (!paneRequests.current[side].current(scope)) return
    const id = ++duRequest.current[side]
    if (du && du.side === side && paneRequests.current[side].current(du.scope)) { setDu(null); return }
    const conn = side === 'left' ? leftConn : rightConn
    const path = side === 'left' ? leftPath : rightPath
    if (!conn) return
    const current = () => id === duRequest.current[side] && paneRequests.current[side].current(scope)
    try {
      const res = await invokeAs<{ totalBytes: number; availBytes: number }>('sftp.du', { connectionId: conn.connectionId, path })
      if (current()) setDu({ side, scope, text: `${path}: ${fmtBytes(res.totalBytes - res.availBytes)} / ${fmtBytes(res.totalBytes)}` })
    } catch (e) {
      if (current()) setDu({ side, scope, text: describeError(e) })
    }
  }

  const copyPath = (path: string) => void copyToClipboard(path, t('sftp.copyPath'))

  if (profiles.length === 0) {
    return <div className="empty-hint">{t('sftp.noProfiles')}</div>
  }

  // 一栏的完整渲染（纯展示，状态由主组件持有）。
  const renderPane = (side: Side) => {
    const kind = side === 'left' ? leftKind : rightKind
    const profileId = side === 'left' ? leftProfileId : rightProfileId
    const conn = side === 'left' ? leftConn : rightConn
    const path = side === 'left' ? leftPath : rightPath
    const requests = paneRequests.current[side]
    const scope = requests.capture()
    const sourceScope = entryScopes.current[side]
    const validSource = requests.source(sourceScope)
    const entries = validSource ? (side === 'left' ? leftEntries : rightEntries) : []
    const sel = validSource ? (side === 'left' ? leftSel : rightSel) : null
    const nav = side === 'left' ? leftNav : rightNav
    const more = validSource && (side === 'left' ? leftMore : rightMore)
    const offset = side === 'left' ? leftOffset : rightOffset
    const editing = side === 'left' ? editLeftPath : editRightPath
    const isLocal = kind === 'local'

    return (
      <div className={`fs-pane ${isLocal ? 'fs-pane-local' : 'fs-pane-remote'}`}>
        <div className="fs-pane-head">
          <span className="pane-source-icon" aria-hidden>{isLocal ? <LaptopOutlined /> : <HddOutlined />}</span>
            <Select
              className="pane-source"
              aria-label={t('sftp.source')}
              variant="borderless"
              value={isLocal ? 'local' : profileId ? `remote:${profileId}` : undefined}
              placeholder={t('sftp.pickProfile')}
              options={[{ value: 'local', label: t('sftp.modeLocal'), title: '' }, ...profileOptions]}
              optionRender={option => <div className="source-option"><span>{option.label}</span>{option.data.title && <small>{option.data.title}</small>}</div>}
              onChange={v => {
                switchKind(side, v === 'local' ? 'local' : 'remote', v === 'local' ? undefined : v.slice(7))
              }}
              loading={!!profileId && busyProfile === profileId}
              status={peerSame ? 'error' : undefined}
            />
          {!isLocal && !conn && (
            <Button size="small" aria-label={t('conn.connect')} loading={!!profileId && busyProfile === profileId} disabled={!profileId} onClick={() => void ensureConn(profileId)}>
              {t('conn.connect')}
            </Button>
          )}
        </div>
        <div className="pane-toolbar">
          <Space size={4}>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} disabled={!nav.canBack}
              title={t('sftp.back')} onClick={() => navSide(side, 'back')} />
            <Button type="text" size="small" icon={<ArrowRightOutlined />} disabled={!nav.canForward}
              title={t('sftp.forward')} onClick={() => navSide(side, 'forward')} />
            <Button type="text" size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
              onClick={() => openSide(side, isLocal ? parentLocal(path) : parentRemote(path))} />
            <Button type="text" size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')} aria-label={t('sftp.refresh')}
              onClick={() => { if (requests.matches([kind, profileId, conn?.connectionId ?? '', path])) void loadSide(side, path, 0) }} />
            {!isLocal && (
              <Dropdown trigger={['click']} autoFocus menu={{ items: [
                { key: 'mkdir', label: t('sftp.mkdir'), icon: <FolderAddOutlined />, disabled: !conn,
                  onClick: async () => {
                    const name = await simplePrompt(t('sftp.mkdir'))
                    if (name) await remoteAction(side, 'sftp.mkdir', { path: joinRemote(path, name) }, scope)
                  } },
                { key: 'remove', label: t('sftp.remove'), icon: <DeleteOutlined />, danger: true, disabled: !sel,
                  onClick: async () => {
                    if (!sel || !requests.source(sourceScope)) return
                    if (sel.isDir) await remoteAction(side, 'sftp.removeRecursive', { path: sel.path }, sourceScope)
                    else await remoteAction(side, 'sftp.remove', { path: sel.path }, sourceScope)
                  } },
                { key: 'du', label: t('sftp.du'), icon: <DashboardOutlined />, disabled: !conn, onClick: () => showDu(side, scope) },
              ] }}>
                <Button type="text" size="small" icon={<MoreOutlined />} title={t('sftp.actions')} aria-label={t('sftp.actions')} />
              </Dropdown>
            )}
          </Space>
          {isLocal ? (
            <Button className="pane-transfer" size="small" type="primary" ghost icon={<ArrowUpOutlined />}
              aria-label={t('sftp.upload')} title={t('sftp.upload')}
              disabled={!(side === 'left' ? rightConn : leftConn)}
              onClick={() => uploadFromPicker(side, sourceScope)}>
              <span className="pane-transfer-label">{t('sftp.upload')}</span>
            </Button>
          ) : (
            <Button className="pane-transfer" size="small" type="primary" ghost icon={<SwapOutlined />}
              aria-label={t('sftp.sendToPeer')} title={t('sftp.sendToPeer')}
              disabled={!conn}
              onClick={() => sendToPeer(side, sourceScope)}>
              <span className="pane-transfer-label">{t('sftp.sendToPeer')}</span>
            </Button>
          )}
        </div>
        {editing ? (
          <Input
            size="small"
            autoFocus
            value={pathDraft[side]}
            onChange={e => setPathDraft(current => ({ ...current, [side]: e.target.value }))}
            onPressEnter={() => openSide(side, pathDraft[side])}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              if (side === 'left') setEditLeftPath(false)
              else setEditRightPath(false)
            }}
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
              <Button type="text" size="small" className="path-edit" icon={<CopyOutlined />} aria-label={t('sftp.copyPath')} onClick={() => copyPath(path)} />
            </Tooltip>
            <Button type="text" size="small" icon={<EditOutlined />}
              className="path-edit"
              title={t('sftp.editPath')}
              aria-label={t('sftp.editPath')}
              onClick={() => {
                // 编辑草稿不参与目录身份，只有 Enter 才提交并加载新路径。
                setPathDraft(current => ({ ...current, [side]: path || (isLocal ? '' : '.') }))
                if (side === 'left') setEditLeftPath(true)
                else setEditRightPath(true)
              }}
            />
          </div>
        )}
        {du && du.side === side && requests.current(du.scope) && (
          <div className="fs-du">
            <span>{du.text}</span>
            <Button type="text" size="small" icon={<CloseOutlined />} className="fs-du-close" aria-label={t('sftp.closeUsage')} onClick={() => { duRequest.current[side]++; setDu(null) }} />
          </div>
        )}
        <div className="file-columns" aria-hidden="true">
          <span>{t('sftp.columnName')}</span><span>{t('sftp.columnSize')}</span><span className="fs-modified">{t('sftp.columnModified')}</span>
        </div>
        <div className="fs-scroll">
          <List
            size="small"
            className="fs-list"
            dataSource={entries}
            renderItem={e => (
              <Dropdown
                key={e.path}
                trigger={['contextMenu']}
                menu={{
                  // 按"本地还是远端""文件还是目录"裁剪：菜单里出现点不动的项，
                  // 比干脆不出现更让人困惑。
                  items: [
                    ...(e.isDir ? [] : [
                      { key: 'preview', label: t('sftp.preview'), disabled: isLocal },
                      { key: 'external', label: t('sftp.openExternal'), disabled: isLocal },
                      { key: 'send', label: isLocal ? t('sftp.upload') : t('sftp.sendToPeer') },
                    ]),
                    ...(isLocal ? [] : [
                      ...(e.isDir ? [{ key: 'cd', label: t('sftp.cdHere') }] : []),
                      { key: 'remove', label: t('sftp.remove'), danger: true },
                    ]),
                    { key: 'copyPath', label: t('sftp.copyPath') },
                  ],
                  onClick: ({ key }) => {
                    if (!requests.source(sourceScope)) return
                    if (key === 'copyPath') { copyPath(e.path); return }
                    if (key === 'preview') { openEntry(e, side, sourceScope); return }
                    if (key === 'external') { void openExternal(e, side); return }
                    if (key === 'send') {
                      if (side === 'left') setLeftSel(e)
                      else setRightSel(e)
                      void sendToPeer(side, sourceScope, e)
                      return
                    }
                    if (key === 'cd') { onCdTo?.(e.path); return }
                    if (key === 'remove') {
                      void remoteAction(side, e.isDir ? 'sftp.removeRecursive' : 'sftp.remove', { path: e.path }, sourceScope)
                    }
                  },
                }}
              >
                <List.Item
                  className={`fs-item ${sel?.path === e.path ? 'fs-selected' : ''}`}
                  onClick={() => {
                    if (!requests.source(sourceScope)) return
                    if (side === 'left') setLeftSel(e)
                    else setRightSel(e)
                  }}
                  onDoubleClick={() => {
                    if (!requests.source(sourceScope)) return
                    openEntry(e, side, sourceScope)
                  }}
                >
                  <span className="fs-icon" aria-hidden>{e.isDir ? <FolderFilled className="file-icon-folder" /> : e.isLink ? <LinkOutlined className="file-icon-link" /> : <FileOutlined className="file-icon-file" />}</span>
                  <span className="fs-name" title={e.name}>{e.name}</span>
                  <span className="fs-meta">{e.isDir ? '' : fmtBytes(e.size)}</span>
                  <span className="fs-meta fs-modified" title={fmtMtime(e.mtime)}>{fmtMtime(e.mtime)}</span>
                </List.Item>
              </Dropdown>
            )}
            footer={
              more ? (
                <Button size="small" type="link" onClick={() => { if (requests.source(sourceScope)) void loadSide(side, path, offset + 500) }}>more…</Button>
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
        <div className="transfers-header">
          <button type="button" className="transfers-toggle" aria-expanded={showTransfers} aria-controls="transfer-list" disabled={transfers.length === 0}
            onClick={() => setTransfersExpanded(value => !value)}>
            {showTransfers ? <DownOutlined /> : <UpOutlined />}
            {t('sftp.transfers')}
            {transfers.length > 0 && <span className="transfer-count">{transfers.length}</span>}
          </button>
          <div className="transfer-summary" role="status">
            {activeTransfers > 0 && <span>{t('sftp.activeTransfers', { count: activeTransfers })}</span>}
            {attentionTransfers > 0 && <span className="transfer-attention">{t('sftp.attentionTransfers', { count: attentionTransfers })}</span>}
          </div>
        </div>
        {showTransfers && <div id="transfer-list" className="fs-scroll transfers-list">
          {transfers.map(tr => {
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
                  <Tag className="transfer-direction" bordered={false}>
                    {label}
                  </Tag>
                  <span className="transfer-path" title={pathText}>{pathText}</span>
                  <span className="transfer-state">{t(`state.${tr.state}`)}</span>
                  {tr.state === 'running' && (
                    <>
                      <Progress className="transfer-progress" percent={pct} size="small" />
                      <span className="transfer-rate">{fmtBytes(tr.rateBps ?? 0)}/s</span>
                    </>
                  )}
                  {tr.state === 'failed' && tr.error && (
                    <Tooltip title={tr.error}><span className="transfer-err">!</span></Tooltip>
                  )}
                  {(tr.state === 'running' || tr.state === 'queued') && (
                    <Button type="text" size="small" onClick={() => invokeAs('transfer.cancel', { taskId: tr.id }).catch(() => {})}>
                      {t('sftp.cancelTransfer')}
                    </Button>
                  )}
                  {tr.state === 'interrupted' && (
                    <Tooltip title={t('sftp.interruptedHint')}><span className="transfer-err">!</span></Tooltip>
                  )}
                  {(tr.state === 'failed' || tr.state === 'cancelled' || tr.state === 'interrupted') && (
                    <Button type="text" size="small" onClick={() => invokeAs('transfer.retry', { taskId: tr.id, connectionId: tr.connectionId }).catch(e => message.error(describeError(e)))}>
                      {t('sftp.retry')}
                    </Button>
                  )}
                </div>
              )
            })}
        </div>}
      </div>

      <FilePreviewModal
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
        onSaved={target => {
          // 内容改过，列表上的大小与时间就旧了：刷一下它所在那一栏。
          const path = target.side === 'left' ? leftPath : rightPath
          if (paneRequests.current[target.side].current(entryScopes.current[target.side])) {
            void loadSide(target.side, path, 0)
          }
        }}
      />
    </div>
  )
}

function parentRemote(path: string): string {
  if (!path || path === '/') return path
  const idx = path.replace(/\/+$/, '').lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
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
