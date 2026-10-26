import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Input,
  List,
  message,
  Modal,
  Progress,
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
  ArrowDownOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons'
import { invokeAs, describeError } from '../bridge'
import { decodeText, encodeText } from '../b64'
import { t } from '../i18n'
import type { ConnectionInfo, FsEntry, TransferStatus } from '../types'

interface Props {
  connections: ConnectionInfo[]
  initialRemotePath?: string | null
}

const BACKSLASH = String.fromCharCode(92)
const SLASH = '/'

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}

// splitPathSegments 把路径拆成可点击的分段（含累积完整路径）。
// Windows 盘符/UNC 与 POSIX 分别解析；"."（远端登录目录）显示为 ~。
function splitPathSegments(path: string, homeHint?: boolean): { label: string; full: string }[] {
  if (!path) return []
  if (path === '.' || path === './') {
    return [{ label: homeHint ? '~' : '.', full: '.' }]
  }
  const win = /^[a-zA-Z]:[\\/]/.test(path) || /^[a-zA-Z]:$/.test(path)
  if (win) {
    const norm = path.split('/').join(BACKSLASH).replace(/[\\]+$/, '')
    const parts = norm.split(BACKSLASH).filter(Boolean)
    const out: { label: string; full: string }[] = []
    let acc = ''
    for (const part of parts) {
      acc = acc === '' ? part + BACKSLASH : acc.replace(/[\\]+$/, '') + BACKSLASH + part
      out.push({ label: part, full: acc })
    }
    return out
  }
  if (path.startsWith(BACKSLASH + BACKSLASH)) {
    // UNC \\server\share\dir
    const parts = path.split(/[\\/]/).filter(Boolean)
    const out: { label: string; full: string }[] = []
    let acc = BACKSLASH + BACKSLASH
    for (const part of parts) {
      acc = acc === BACKSLASH + BACKSLASH ? acc + part : acc + BACKSLASH + part
      out.push({ label: part, full: acc })
    }
    return out
  }
  // POSIX 绝对路径
  const parts = path.split(SLASH).filter(Boolean)
  const out: { label: string; full: string }[] = [{ label: SLASH, full: SLASH }]
  let acc = ''
  for (const part of parts) {
    acc += SLASH + part
    out.push({ label: part, full: acc })
  }
  return out
}

// PathBreadcrumb 按资源管理器习惯渲染分段路径：每段可点击跳转。
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
    return (
      <span className="crumb root" onClick={() => onNavigate('')}>
        {emptyLabel ?? '—'}
      </span>
    )
  }
  return (
    <div className="path-breadcrumb">
      {segs.map((seg, i) => (
        <span key={i} className="crumb">
          <span className="crumb-icon">📁</span>
          <a onClick={() => onNavigate(seg.full)}>{seg.label}</a>
          {i < segs.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  )
}

// 文件面板：远程/本地双栏 + 传输队列。文件内容不过桥，大文件传输由
// 后端直传磁盘，这里只发起任务与轮询进度。
export function SftpPanel({ connections, initialRemotePath }: Props) {
  const [connId, setConnId] = useState<string>('')
  const [remotePath, setRemotePath] = useState(initialRemotePath ?? '')
  const [remotePathInput, setRemotePathInput] = useState(initialRemotePath ?? '')
  const [remoteEntries, setRemoteEntries] = useState<FsEntry[]>([])
  const [remoteMore, setRemoteMore] = useState(false)
  const [remoteOffset, setRemoteOffset] = useState(0)
  const [localPath, setLocalPath] = useState('')
  const [localEntries, setLocalEntries] = useState<FsEntry[]>([])
  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [selectedRemote, setSelectedRemote] = useState<FsEntry | null>(null)
  const [selectedLocal, setSelectedLocal] = useState<FsEntry | null>(null)
  const [preview, setPreview] = useState<{ path: string; content: string; dirty: string } | null>(null)
  const [du, setDu] = useState<string | null>(null)
  // 每栏独立的浏览历史（前进/后退）与路径编辑模式。
  const [remoteHist, setRemoteHist] = useState<string[]>([])
  const [remoteHistIdx, setRemoteHistIdx] = useState(-1)
  const [localHist, setLocalHist] = useState<string[]>([])
  const [localHistIdx, setLocalHistIdx] = useState(-1)
  const [editRemote, setEditRemote] = useState(false)
  const [editLocal, setEditLocal] = useState(false)

  const conn = connections.find(c => c.connectionId === connId)

  // 默认选中第一个可用连接；选中的连接断开时清空重选。
  useEffect(() => {
    if (connections.length === 0) {
      if (connId) setConnId('')
      return
    }
    if (!connId || !connections.some(c => c.connectionId === connId)) {
      setConnId(connections[0].connectionId)
    }
  }, [connections, connId])

  // 远程初始路径：外部跟随（终端 cd）或用户主目录。
  useEffect(() => {
    if (initialRemotePath) {
      setRemotePath(initialRemotePath)
      setRemotePathInput(initialRemotePath)
    }
  }, [initialRemotePath])

  const loadRemote = useCallback(async (path: string, offset = 0) => {
    if (!connId) return
    try {
      const res = await invokeAs<{ entries: FsEntry[]; more: boolean }>('sftp.list', {
        connectionId: connId,
        path: path || '.',
        offset,
        limit: 500,
      })
      if (offset === 0) setRemoteEntries(res.entries ?? [])
      else setRemoteEntries(prev => [...prev, ...(res.entries ?? [])])
      setRemoteMore(res.more)
      setRemoteOffset(offset)
    } catch (e) {
      message.error(describeError(e))
    }
  }, [connId])

  const loadLocal = useCallback(async (path: string) => {
    try {
      const res = await invokeAs<{ entries: FsEntry[]; home: string }>('fs.listLocal', { path })
      setLocalEntries(res.entries ?? [])
      if (!localPath && res.home) setLocalPath(res.home)
    } catch (e) {
      message.error(describeError(e))
    }
  }, [localPath])

  // 打开远程目录：更新展示路径、压入历史并加载。
  const openRemoteDir = useCallback((path: string) => {
    setRemotePath(path)
    setRemotePathInput(path)
    setEditRemote(false)
    loadRemote(path, 0)
    setRemoteHist(prev => {
      const next = [...prev.slice(0, remoteHistIdx + 1), path]
      setRemoteHistIdx(next.length - 1)
      return next
    })
  }, [loadRemote, remoteHistIdx])

  const remoteJump = (idx: number) => {
    if (idx < 0 || idx >= remoteHist.length) return
    const p = remoteHist[idx]
    setRemoteHistIdx(idx)
    setRemotePath(p)
    setRemotePathInput(p)
    loadRemote(p, 0)
  }

  // 打开本地目录：压入历史并加载。
  const openLocalDir = useCallback((path: string) => {
    setLocalPath(path)
    setEditLocal(false)
    loadLocal(path)
    setLocalHist(prev => {
      const next = [...prev.slice(0, localHistIdx + 1), path]
      setLocalHistIdx(next.length - 1)
      return next
    })
  }, [loadLocal, localHistIdx])

  const localJump = (idx: number) => {
    if (idx < 0 || idx >= localHist.length) return
    const p = localHist[idx]
    setLocalHistIdx(idx)
    setLocalPath(p)
    loadLocal(p)
  }

  // 连接切换时加载当前目录（首连无路径时用远端登录目录 "."）。
  useEffect(() => {
    if (connId) loadRemote(remotePath || '.', 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, loadRemote])

  useEffect(() => {
    loadLocal(localPath)
  }, [localPath, loadLocal])

  // 传输队列轮询：链式 setTimeout，上一 tick 未返回时跳过本次，
  // 避免请求堆积放大并发预算争用。
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
        } catch { /* 忽略轮询失败 */ }
        inFlight = false
      }
      if (!stopped) timer = setTimeout(tick, 1000)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])

  const startTransfer = async (direction: 'upload' | 'download') => {
    if (!connId) return
    try {
      if (direction === 'download') {
        if (!selectedRemote || selectedRemote.isDir) { message.warning(t('sftp.download')); return }
        // 优先原生对话框选保存位置；不可用时回落当前目录。
        let targetDir = localPath
        const pickFolder = window.gonaviPlugin?.pickFolder?.bind(window.gonaviPlugin)
        if (pickFolder) {
          const picked = await pickFolder({ title: t('sftp.download') })
          if (picked === null) return
          if (picked) targetDir = picked
        }
        await invokeAs('transfer.start', {
          connectionId: connId, direction,
          remotePath: selectedRemote.path,
          localPath: joinLocal(targetDir, selectedRemote.name),
        })
      } else {
        // 优先原生文件选择器；回落本地栏选中项。
        const pickFile = window.gonaviPlugin?.pickFile?.bind(window.gonaviPlugin)
        if (pickFile) {
          const picked = await pickFile({ title: t('sftp.upload') })
          if (picked === null) return
          if (picked) {
            const name = picked.split(/[\\/]/).pop() || 'file'
            await invokeAs('transfer.start', {
              connectionId: connId, direction,
              remotePath: joinRemote(remotePath, name),
              localPath: picked,
            })
            message.success(`${t('state.upload')}: OK`)
            return
          }
        }
        if (!selectedLocal || selectedLocal.isDir) { message.warning(t('sftp.upload')); return }
        await invokeAs('transfer.start', {
          connectionId: connId, direction,
          remotePath: joinRemote(remotePath, selectedLocal.name),
          localPath: selectedLocal.path,
        })
      }
      message.success(`${t(direction === 'upload' ? 'state.upload' : 'state.download')}: OK`)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const doPreview = async (entry: FsEntry) => {
    try {
      const res = await invokeAs<{ dataBase64: string }>('sftp.preview', {
        connectionId: connId, path: entry.path, maxBytes: 262144,
      })
      // decodeText（UTF-8 安全）与保存侧 encodeText 配对；atob 的 latin1
      // 产物经 TextEncoder 重编码会损坏非 ASCII 文件。
      const text = decodeText(res.dataBase64)
      // 二进制嗅探：NUL 多于 1% 按二进制拒绝编辑。
      const nul = [...text].filter(c => c === '\u0000').length
      if (nul > text.length / 100) {
        message.warning(`${entry.name}: binary`)
        return
      }
      setPreview({ path: entry.path, content: text, dirty: text })
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const savePreview = async () => {
    if (!preview) return
    try {
      await invokeAs('sftp.writeFile', {
        connectionId: connId, path: preview.path, dataBase64: encodeText(preview.dirty),
      })
      message.success(t('sftp.saveFile'))
      setPreview(null)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const simplePrompt = (title: string, initial: string): Promise<string | null> =>
    new Promise(resolve => {
      let value = initial
      Modal.confirm({
        title,
        content: (
          <Input
            defaultValue={initial}
            onChange={e => { value = e.target.value }}
          />
        ),
        onOk: () => resolve(value),
        onCancel: () => resolve(null),
      })
    })

  const remoteAction = async (action: string, args: Record<string, unknown>, refresh = true) => {
    try {
      await invokeAs(action, { connectionId: connId, ...args })
      if (refresh) loadRemote(remotePath, 0)
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const showDu = async () => {
    try {
      const res = await invokeAs<{ totalBytes: number; availBytes: number }>('sftp.du', {
        connectionId: connId, path: remotePath,
      })
      setDu(`${remotePath}: ${fmtBytes(res.totalBytes - res.availBytes)} / ${fmtBytes(res.totalBytes)}`)
    } catch (e) {
      setDu(describeError(e))
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
      footer={
        more?.show ? (
          <Button size="small" type="link" onClick={more.onLoad}>more…</Button>
        ) : undefined
      }
    />
  )

  if (connections.length === 0) {
    return <div className="empty-hint">{t('sftp.selectConn')}</div>
  }

  return (
    <div className="sftp-wrap">
      <Space className="sftp-toolbar" wrap>
        <Select
          value={connId}
          onChange={setConnId}
          style={{ minWidth: 220 }}
          options={connections.map(c => ({ value: c.connectionId, label: c.addr ?? c.connectionId }))}
        />
      </Space>
      <div className="sftp-columns">
        <div className="fs-pane fs-pane-remote">
          <div className="fs-pane-head">
            <Space size={6}>
              <Tag color="blue" style={{ marginRight: 0 }}>{t('sftp.remote')}</Tag>
              <Typography.Text type="secondary" className="pane-subject">
                {conn?.addr ?? ''}
              </Typography.Text>
            </Space>
            <Space size={4}>
              <Button size="small" icon={<ArrowLeftOutlined />} disabled={remoteHistIdx <= 0}
                title={t('sftp.back')} onClick={() => remoteJump(remoteHistIdx - 1)} />
              <Button size="small" icon={<ArrowRightOutlined />} disabled={remoteHistIdx >= remoteHist.length - 1}
                title={t('sftp.forward')} onClick={() => remoteJump(remoteHistIdx + 1)} />
              <Button size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
                onClick={() => openRemoteDir(parentRemote(remotePath))} />
              <Button size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')}
                onClick={() => loadRemote(remotePath, 0)} />
              <Button size="small" icon={<FolderAddOutlined />} title={t('sftp.mkdir')}
                onClick={async () => {
                  const name = await simplePrompt(t('sftp.mkdir'), '')
                  if (name) await remoteAction('sftp.mkdir', { path: joinRemote(remotePath, name) })
                }} />
              <Button size="small" icon={<ArrowDownOutlined />} title={t('sftp.download')}
                onClick={() => startTransfer('download')} />
              <Button size="small" icon={<ArrowUpOutlined />} title={t('sftp.upload')}
                onClick={() => startTransfer('upload')} />
              <Button size="small" icon={<DeleteOutlined />} title={t('sftp.remove')}
                danger
                onClick={async () => {
                  if (!selectedRemote) return
                  if (selectedRemote.isDir) {
                    await remoteAction('sftp.removeRecursive', { path: selectedRemote.path })
                  } else {
                    await remoteAction('sftp.remove', { path: selectedRemote.path })
                  }
                }} />
              <Button size="small" onClick={showDu}>{t('sftp.du')}</Button>
            </Space>
          </div>
          {editRemote ? (
            <Input
              size="small"
              autoFocus
              value={remotePathInput}
              onChange={e => setRemotePathInput(e.target.value)}
              onPressEnter={() => openRemoteDir(remotePathInput)}
              onBlur={() => setEditRemote(false)}
            />
          ) : (
            <div className="path-bar">
              <PathBreadcrumb path={remotePath || "."} homeHint onNavigate={openRemoteDir} />
              <EditOutlined
                className="path-edit"
                title={t('sftp.editPath')}
                onClick={() => { setRemotePathInput(remotePath); setEditRemote(true) }}
              />
            </div>
          )}
          {du && <div className="fs-du">{du}</div>}
          <div className="fs-scroll">
            {entryList(remoteEntries, selectedRemote, setSelectedRemote, e => {
              if (e.isDir) openRemoteDir(e.path)
              else void doPreview(e)
            }, { show: remoteMore, onLoad: () => loadRemote(remotePath, remoteOffset + 500) })}
          </div>
        </div>

        <div className="fs-pane fs-pane-local">
          <div className="fs-pane-head">
            <Space size={6}>
              <Tag color="green" style={{ marginRight: 0 }}>{t('sftp.local')}</Tag>
              <Typography.Text type="secondary" className="pane-subject">
                {t('sftp.computer')}
              </Typography.Text>
            </Space>
            <Space size={4}>
              <Button size="small" icon={<ArrowLeftOutlined />} disabled={localHistIdx <= 0}
                title={t('sftp.back')} onClick={() => localJump(localHistIdx - 1)} />
              <Button size="small" icon={<ArrowRightOutlined />} disabled={localHistIdx >= localHist.length - 1}
                title={t('sftp.forward')} onClick={() => localJump(localHistIdx + 1)} />
              <Button size="small" icon={<RollbackOutlined />} title={t('sftp.parent')}
                onClick={() => openLocalDir(parentLocal(localPath))} />
              <Button size="small" icon={<ReloadOutlined />} title={t('sftp.refresh')}
                onClick={() => loadLocal(localPath)} />
            </Space>
          </div>
          {editLocal ? (
            <Input
              size="small"
              autoFocus
              value={localPath}
              onChange={e => setLocalPath(e.target.value)}
              onPressEnter={() => openLocalDir(localPath)}
              onBlur={() => setEditLocal(false)}
            />
          ) : (
            <div className="path-bar">
              <PathBreadcrumb
                path={localPath}
                emptyLabel={t('sftp.computer')}
                onNavigate={openLocalDir}
              />
              <EditOutlined
                className="path-edit"
                title={t('sftp.editPath')}
                onClick={() => setEditLocal(true)}
              />
            </div>
          )}
          <div className="fs-scroll">
            {entryList(localEntries, selectedLocal, setSelectedLocal, e => {
              if (e.isDir) openLocalDir(e.path)
            })}
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
              return (
                <div key={tr.id} className="transfer-row">
                  <Tag color={tr.direction === 'upload' ? 'blue' : 'green'}>
                    {t(tr.direction === 'upload' ? 'state.upload' : 'state.download')}
                  </Tag>
                  <span className="transfer-path" title={`${tr.remotePath} ⇄ ${tr.localPath}`}>
                    {tr.direction === 'upload' ? tr.localPath : tr.remotePath}
                  </span>
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
  // 盘符根（C:\）与 UNC 根（\\server\share）的上级回到盘符/根列表。
  if (/^[a-zA-Z]:[\\/]?$/.test(path)) return ''
  const uncParts = path.split(/[\\/]/).filter(Boolean)
  if (path.startsWith('\\\\') && uncParts.length <= 2) return ''
  let p = path.replace(/[\\/]+$/, '')
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (idx < 0) return ''
  let parent = p.slice(0, idx)
  if (/^[a-zA-Z]:$/.test(parent)) parent += '\\' // C: → C:\
  if (parent === '') parent = path.startsWith('/') ? '/' : ''
  return parent
}
