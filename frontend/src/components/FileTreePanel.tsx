import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Dropdown, Input, List, Modal, Space, Spin, Tooltip, message } from 'antd'
import {
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderFilled,
  FileOutlined,
  LinkOutlined,
  MoreOutlined,
  ReloadOutlined,
  UpOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { invokeAs, describeError } from '../bridge'
import { copyToClipboard } from '../clipboard'
import { fmtBytes, fmtMtime, joinLocal, joinRemote } from '../fsFormat'
import { t } from '../i18n'
import { usePanelResize } from '../usePanelResize'
import type { FsEntry } from '../types'
import { PathBreadcrumb } from './PathBreadcrumb'
import { FilePreviewModal } from './FilePreviewModal'

export interface TreeJump {
  path: string
  /** 递增序号：同一个目录再跳一次（seq 变化）也要重新定位。 */
  seq: number
}

// 单页条目数，与「文件」页双栏面板一致（后端 limit<=0 时同样按 500 处理）。
const TREE_PAGE = 500

interface Props {
  width?: number
  onWidthChange?: (width: number) => void
  /** 当前活动终端所在连接的 connectionId；null＝还没连上。 */
  connectionId: string | null
  /** 跳转目标：终端目录跟随（OSC7）或命中的跳转命令。 */
  jump: TreeJump | null
  /** 是否跟随终端目录（设置项，由上层持有）。 */
  follow: boolean
  onFollowChange: (next: boolean) => void
  /** 下载落地的本机目录（设置项）。空串＝还没挑过，下载时当场问一次。 */
  downloadDir: string
  onDownloadDirChange: (next: string) => void
  /** 收起文件浏览（写回设置）。 */
  onCollapse: () => void
  /** 在活动终端里 cd 到此远端目录（没有可用终端时由上层提示）。 */
  onCdTo?: (remotePath: string) => void
}

// 终端旁的单栏远端文件浏览：跟随终端目录、响应跳转命令，并就地支持
// 上传/下载/新建/重命名/删除——运维时十次有九次只是往当前目录塞个文件、
// 删个日志，为了这点事跳到「文件」页的双栏面板再找回同一个目录太折腾。
// 传输本身交给后端队列（transfer.start），这里不重写一套状态机。
export function FileTreePanel({
  width = 260, onWidthChange,
  connectionId, jump, follow, onFollowChange, downloadDir, onDownloadDirChange, onCollapse, onCdTo,
}: Props) {
  const resizeProps = usePanelResize(width, 160, 200, 260, onWidthChange)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [path, setPath] = useState('.')
  const [loading, setLoading] = useState(false)
  // 目录条目多时后端按页返回：拦在 500 条上不声不响地少显示，用户看不出来。
  const [more, setMore] = useState(false)
  const [offset, setOffset] = useState(0)
  // 工具栏的下载/重命名/删除都作用于选中项。
  const [selected, setSelected] = useState<FsEntry | null>(null)
  // 整个列表共用一个右键菜单；每行各挂一个 Dropdown 会让大目录多创建几百个
  // 触发器，打开目录时足以把窗口心跳拖过超时。
  const [contextEntry, setContextEntry] = useState<FsEntry | null>(null)
  // 内置预览弹窗打开的文件（公共组件持有内容与保存逻辑，这里只管打开哪一个）。
  const [previewTarget, setPreviewTarget] = useState<{ connectionId: string; path: string; name: string } | null>(null)
  // 拖拽只在本面板内发生（宿主关掉了 WebView 的文件投递），记个引用就够，
  // 不必绕 dataTransfer 一圈。
  const dragRef = useRef<FsEntry | null>(null)
  // 连接与目录可能连着切：迟到的响应不能覆盖新目录的内容。
  const seq = useRef(0)

  const load = useCallback(
    async (target: string, nextOffset = 0) => {
      if (!connectionId) return
      const current = ++seq.current
      setContextEntry(null)
      setLoading(true)
      try {
        const res = await invokeAs<{ entries: FsEntry[]; more?: boolean }>('sftp.list', {
          connectionId,
          path: target,
          offset: nextOffset,
          limit: TREE_PAGE,
        })
        if (current !== seq.current) return
        // 目录在前，其余按名称排（数字感知：log2 在 log10 前面）。
        const page = [...(res.entries ?? [])].sort((a, b) =>
          a.isDir === b.isDir
            ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            : a.isDir
              ? -1
              : 1,
        )
        setEntries(prev => (nextOffset > 0 ? [...prev, ...page] : page))
        setContextEntry(null)
        // 换了目录，原来的选中项已经不在列表里：留着会让删除/重命名指向看不见的东西。
        if (nextOffset === 0) setSelected(null)
        setMore(!!res.more)
        setOffset(nextOffset)
        // 只有成功才认新路径：失败时停在原目录，报错即可。
        setPath(target)
      } catch (e) {
        if (current !== seq.current) return
        message.error(describeError(e))
      } finally {
        if (current === seq.current) setLoading(false)
      }
    },
    [connectionId],
  )

  useEffect(() => {
    setContextEntry(null)
    setSelected(null)
    setPreviewTarget(null)
    dragRef.current = null
    setEntries([])
    setPath('.')
    setMore(false)
    setOffset(0)
    setLoading(false)
    if (connectionId) void load('.')
    // 断开、切换连接和卸载都使旧请求失效，包括尚未确认的文件操作。
    return () => { seq.current++ }
    // 只在连接变化时重载；load 随 connectionId 走，不进依赖避免每次渲染重发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  useEffect(() => {
    if (jump) void load(jump.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  // '.' 是后端的 home 简写，面包屑据此显示为「~」；还没定位到绝对路径时
  // 无从得知上一级，此时不给「..」（与「文件」页双栏面板一致）。
  const up = parentOf(path)
  const pickFolder = () => window.gonaviPlugin?.pickFolder?.bind(window.gonaviPlugin)
  const pickFile = () => window.gonaviPlugin?.pickFile?.bind(window.gonaviPlugin)

  // 下载要知道往哪落。没挑过就当场问一次，挑定了写回设置，下次不再问。
  const ensureDownloadDir = async (): Promise<string | null> => {
    if (downloadDir) return downloadDir
    const pick = pickFolder()
    if (!pick) {
      message.warning(t('tree.noPicker'))
      return null
    }
    const dir = await pick({ title: t('tree.chooseDir') })
    if (!dir) return null
    onDownloadDirChange(dir)
    return dir
  }

  const download = async (entry: FsEntry) => {
    if (!connectionId) return
    const current = seq.current
    if (entry.isDir) {
      message.warning(t('tree.fileOnly'))
      return
    }
    const dir = await ensureDownloadDir()
    if (!dir || current !== seq.current) return
    try {
      await invokeAs('transfer.start', {
        connectionId, direction: 'download',
        remotePath: entry.path, localPath: joinLocal(dir, entry.name),
      })
      message.success(t('tree.downloadStarted', { name: entry.name }))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const chooseDownloadDir = async () => {
    const pick = pickFolder()
    if (!pick) {
      message.warning(t('tree.noPicker'))
      return
    }
    const dir = await pick({ title: t('tree.chooseDir') })
    if (dir) onDownloadDirChange(dir)
  }

  const upload = async () => {
    if (!connectionId) return
    const current = seq.current
    const pick = pickFile()
    if (!pick) {
      message.warning(t('tree.noPicker'))
      return
    }
    const file = await pick({ title: t('sftp.upload') })
    if (!file || current !== seq.current) return
    const name = file.split(/[\\/]/).pop() || 'file'
    try {
      await invokeAs('transfer.start', {
        connectionId, direction: 'upload',
        localPath: file, remotePath: joinRemote(path, name),
      })
      message.success(t('tree.uploadStarted', { name }))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  // 命名类弹窗（新建文件夹、重命名）走 Modal.confirm，和「文件」页一个路子，
  // 不额外养一份弹窗状态。
  const promptName = (title: string, initial: string): Promise<string | null> =>
    new Promise(resolve => {
      const current = seq.current
      let value = initial
      Modal.confirm({
        title,
        content: <Input defaultValue={initial} onChange={e => { value = e.target.value }} />,
        onOk: () => resolve(current === seq.current ? value : null),
        onCancel: () => resolve(null),
      })
    })

  // 远端改动完成后重新拉一次当前目录：不拉的话用户看不到自己刚建/改/删的东西。
  const remoteAction = async (command: string, args: Record<string, unknown>, current = seq.current) => {
    if (!connectionId || current !== seq.current) return
    try {
      await invokeAs(command, { connectionId, ...args })
      if (current === seq.current) await load(path)
    } catch (e) {
      if (current === seq.current) message.error(describeError(e))
    }
  }

  const createDir = async () => {
    const name = (await promptName(t('sftp.mkdir'), ''))?.trim()
    if (!name) return
    await remoteAction('sftp.mkdir', { path: joinRemote(path, name) })
  }

  // 重命名与删除都要认「作用于哪一个条目」：工具栏走选中项，右键菜单走鼠标下
  // 那一行——它未必等于当前的选中项。
  const renameEntry = async (entry: FsEntry) => {
    const name = (await promptName(t('sftp.rename'), entry.name))?.trim()
    if (!name || name === entry.name) return
    // 新名字要落在**这个条目所在的目录**里。当前 path 可能还是 home 简写 '.'，
    // 拿它拼会把这个文件改名到 home 去。
    const dir = parentOf(entry.path)
    await remoteAction('sftp.rename', { oldPath: entry.path, newPath: joinRemote(dir, name) })
  }
  const renameSelected = () => { if (selected) void renameEntry(selected) }

  const removeEntry = (entry: FsEntry) => {
    const current = seq.current
    Modal.confirm({
      title: t(entry.isDir ? 'tree.removeDirConfirm' : 'tree.removeConfirm', { name: entry.name }),
      okButtonProps: { danger: true },
      // 目录得连内容一起删：普通 remove 遇到非空目录会被 SFTP 拒绝。
      onOk: () => remoteAction(entry.isDir ? 'sftp.removeRecursive' : 'sftp.remove', { path: entry.path }, current),
    })
  }
  const removeSelected = () => { if (selected) removeEntry(selected) }

  // 双击与右键「打开」：文件交给公共预览弹窗（目录的双击另有进入逻辑）。
  const openPreview = (entry: FsEntry) => {
    if (!connectionId || entry.isDir) return
    setPreviewTarget({ connectionId, path: entry.path, name: entry.name })
  }

  // 用本机程序打开：后端把文件取到插件数据目录再唤起系统默认程序。改动不会自动
  // 回写远端，改完要由用户显式上传。
  const openExternal = async (entry: FsEntry) => {
    if (!connectionId || entry.isDir) return
    try {
      await invokeAs('sftp.openExternal', { connectionId, path: entry.path })
      message.success(t('sftp.openExternalStarted', { name: entry.name }))
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const copyPath = (target: string) => void copyToClipboard(target, t('sftp.copyPath'))

  const contextMenu = {
    items: contextEntry ? [
      ...(contextEntry.isDir ? [] : [
        { key: 'preview', label: t('sftp.preview') },
        { key: 'external', label: t('sftp.openExternal') },
        { key: 'download', label: t('sftp.download') },
      ]),
      { key: 'upload', label: t('sftp.upload') },
      { key: 'mkdir', label: t('sftp.mkdir') },
      ...(contextEntry.isDir ? [{ key: 'cd', label: t('sftp.cdHere') }] : []),
      { key: 'rename', label: t('sftp.rename') },
      { key: 'remove', label: t('sftp.remove'), danger: true },
      { key: 'copyPath', label: t('sftp.copyPath') },
    ] : [],
    onClick: ({ key }: { key: string }) => {
      const entry = contextEntry
      if (!entry) return
      setContextEntry(null)
      if (key === 'preview') openPreview(entry)
      else if (key === 'external') void openExternal(entry)
      else if (key === 'download') void download(entry)
      else if (key === 'upload') void upload()
      else if (key === 'mkdir') void createDir()
      else if (key === 'cd') onCdTo?.(entry.path)
      else if (key === 'rename') void renameEntry(entry)
      else if (key === 'remove') removeEntry(entry)
      else if (key === 'copyPath') copyPath(entry.path)
    },
  }

  return (
    <div className="file-tree" style={{ width }}>
      <div className="file-tree-head">
        <span className="file-tree-title">{t('tree.title')}</span>
        <Space size={2}>
          <Spin spinning={loading} size="small" />
          <Tooltip title={t('tree.collapse')}>
            <Button type="text" size="small" aria-label={t('tree.collapse')} icon={<CloseOutlined />} onClick={onCollapse} />
          </Tooltip>
        </Space>
      </div>
      {/* 常驻导航和上传；针对选中文件的操作放到同一菜单。 */}
      <div className="file-tree-tools">
        <Space size={2} wrap>
          <Tooltip title={t('sftp.refresh')}>
            <Button type="text" size="small" aria-label={t('sftp.refresh')} icon={<ReloadOutlined />} onClick={() => void load(path)} />
          </Tooltip>
          <Tooltip title={follow ? t('tree.navLocked') : t('tree.up')}>
            <Button type="text" size="small" aria-label={t('tree.up')} disabled={!up || follow} icon={<UpOutlined />} onClick={() => up && !follow && void load(up)} />
          </Tooltip>
          <Tooltip title={t('sftp.upload')}>
            <Button type="text" size="small" aria-label={t('sftp.upload')} disabled={!connectionId} icon={<UploadOutlined />} onClick={() => void upload()} />
          </Tooltip>
          <Dropdown trigger={['click']} autoFocus menu={{ items: [
            { key: 'mkdir', label: t('sftp.mkdir'), icon: <FolderAddOutlined />, disabled: !connectionId, onClick: () => void createDir() },
            { key: 'download', label: t('sftp.download'), icon: <DownloadOutlined />, disabled: !selected || selected.isDir, onClick: () => selected && void download(selected) },
            { key: 'rename', label: t('sftp.rename'), icon: <EditOutlined />, disabled: !selected, onClick: () => void renameSelected() },
            { key: 'remove', label: t('sftp.remove'), icon: <DeleteOutlined />, disabled: !selected, danger: true, onClick: removeSelected },
          ] }}>
            <Button type="text" size="small" icon={<MoreOutlined />} aria-label={t('sftp.actions')} title={t('sftp.actions')} />
          </Dropdown>
        </Space>
      </div>
      {connectionId ? (
        <>
          <PathBreadcrumb path={path} homeHint disabled={follow} onNavigate={target => void load(target || '.')} />
          <Dropdown
            trigger={['contextMenu']}
            open={!!contextEntry}
            menu={contextMenu}
            onOpenChange={open => { if (!open) setContextEntry(null) }}
          >
            <div className="fs-scroll" onContextMenuCapture={() => setContextEntry(null)}>
              {/* 「..」排在最前面（文件管理器的惯例）：放在列表末尾会悬在下方空白上。 */}
              {up ? (
                <div
                  className={follow ? 'fs-item fs-up fs-locked' : 'fs-item fs-up'}
                  data-path=".."
                  onDoubleClick={() => { if (!follow) void load(up) }}
                >
                  <span className="fs-icon" aria-hidden><FolderFilled className="file-icon-folder" /></span>
                  <span className="fs-name">..</span>
                </div>
              ) : null}
              <List
                size="small"
                className="fs-list"
                dataSource={entries}
                renderItem={e => (
                  <List.Item
                    key={e.path}
                    className={e.path === selected?.path ? 'fs-item fs-selected' : 'fs-item'}
                    data-path={e.path}
                    title={[e.name, !e.isDir && fmtBytes(e.size), fmtMtime(e.mtime)].filter(Boolean).join('\n')}
                    // 拖到下面的「下载到」区就下载这个文件（面板内拖拽，不涉及系统拖放）。
                    draggable
                    onDragStart={() => { dragRef.current = e }}
                    onClick={event => { event.stopPropagation(); setContextEntry(null); setSelected(e) }}
                    onContextMenu={() => setContextEntry(e)}
                    onDoubleClick={() => {
                      // 跟随终端时目录由终端决定：手动进目录只会被下一次 OSC7 上报
                      // 拽回来。双击文件不受影响——预览不是导航。
                      if (follow && e.isDir) return
                      if (e.isDir) void load(e.path)
                      else openPreview(e)
                    }}
                  >
                    <span className="fs-icon" aria-hidden>{e.isDir ? <FolderFilled className="file-icon-folder" /> : e.isLink ? <LinkOutlined className="file-icon-link" /> : <FileOutlined className="file-icon-file" />}</span>
                    <span className="fs-name">{e.name}</span>
                    <span className="fs-meta">{e.isDir ? '' : fmtBytes(e.size)}</span>
                  </List.Item>
                )}
                footer={
                  more ? (
                    <div className="fs-more">
                      <Button type="link" size="small" aria-label="tree.more" onClick={() => void load(path, offset + TREE_PAGE)}>
                        more…
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          </Dropdown>
        </>
      ) : (
        <div className="file-tree-hint">{t('tree.pickConnection')}</div>
      )}
      <div className="file-tree-foot">
        <Checkbox checked={follow} onChange={e => onFollowChange(e.target.checked)}>
          {t('tree.follow')}
        </Checkbox>
        {/* 拖进来的文件落到这个目录；本机目录没法"拖出到资源管理器"——宿主
            关掉了 WebView 的投递，也没有拖出接口，只能在面板里给个落点。 */}
        <div
          className="fs-drop"
          data-drop="download"
          onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault()
            const dragged = dragRef.current
            dragRef.current = null
            if (dragged) void download(dragged)
          }}
        >
          <span className="fs-drop-label" title={downloadDir || undefined}>
            {downloadDir ? t('tree.downloadTo', { dir: downloadDir }) : t('tree.noDir')}
          </span>
          <Button type="link" size="small" aria-label={t('tree.chooseDir')} onClick={() => void chooseDownloadDir()}>
            {downloadDir ? t('tree.changeDir') : t('tree.chooseDir')}
          </Button>
        </div>
      </div>

      <div {...resizeProps} className="panel-resizer" aria-label={t('tree.resize')} title={t('tree.resizeHint')} />
      <FilePreviewModal
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
        onSaved={() => void load(path)}
      />
    </div>
  )
}

/** 上一级路径；已经在根或无法上溯时返回空串（按钮据此置灰）。 */
function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : trimmed.slice(0, cut)
}
