import { FolderFilled } from '@ant-design/icons'

const BACKSLASH = String.fromCharCode(92)

/** 路径 → 可点击的层级；支持 POSIX、盘符与 UNC（本地栏在用）。 */
export function splitPathSegments(path: string, homeHint?: boolean): { label: string; full: string }[] {
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

/** 路径面包屑：层级可点，点击即导航到该层。 */
export function PathBreadcrumb({
  path,
  emptyLabel,
  homeHint,
  onNavigate,
  disabled,
}: {
  path: string
  emptyLabel?: string
  homeHint?: boolean
  onNavigate: (p: string) => void
  /**
   * 只读路径：层级照常显示（用户要看得见自己在哪），但点不动。
   * 终端页跟随模式用它——目录由终端决定，手动跳转会立刻被下一次上报拽回来。
   */
  disabled?: boolean
}) {
  const segs = splitPathSegments(path, homeHint)
  const go = (p: string) => { if (!disabled) onNavigate(p) }
  if (segs.length === 0) {
    return <button type="button" className="crumb root" disabled={disabled} onClick={() => go('')}>{emptyLabel ?? '—'}</button>
  }
  return (
    <div className="path-breadcrumb" aria-disabled={disabled}>
      {segs.map((seg, i) => (
        <span key={i} className="crumb">
          {i === 0 && <FolderFilled className="crumb-icon file-icon-folder" aria-hidden />}
          <button type="button" title={seg.full} disabled={disabled} onClick={() => go(seg.full)}>{seg.label}</button>
          {i < segs.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  )
}
