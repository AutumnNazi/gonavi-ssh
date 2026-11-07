// 文件面板共用的展示格式与路径工具：文件浏览与 SFTP 面板必须显示同一套大小/时间、
// 拼出同一套路径，各写一份迟早会在边界上漂移。

/** 人类可读的大小：1024 进制，保留一位小数（1.0 KB 起）。 */
export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}

/** 远端 mtime（RFC3339）→ 本地 `yyyy-MM-dd HH:mm`；解析不了就原样截断显示。 */
export function fmtMtime(value: string): string {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value.slice(0, 16)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 远端路径拼接。`.` 是后端的 home 简写，拼出来不能变成 `./name`——
 * 那种相对路径在部分 SFTP 服务端上会落到别处。
 */
export function joinRemote(dir: string, name: string): string {
  if (!dir || dir === '.') return name
  return dir.replace(/\/+$/, '') + '/' + name
}

/** 本机路径拼接：按目录自己的分隔符风格走，`D:\drops` 下不会拼出 `D:\drops/name`。 */
export function joinLocal(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

/**
 * 把路径包成 shell 单引号参数。远端路径带空格、`$`、`;` 都是常态，不引起来就会被
 * shell 拆成多条参数甚至执行到别的东西。单引号内部无法转义自身，按 POSIX 的写法
 * 断开再拼接：`it's` → `'it'\''s'`。
 */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
