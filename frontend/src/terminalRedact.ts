// 目录跟随要往远端 shell 注入 OSC7 上报钩子。注入本身是静默的（先让远端用
// `read -s` 把钩子那行读走，读期间内核不回显），但用来起头的那行 `read` 是当着
// 用户的面敲进去的，远端 PTY 会把它原样回显回来（内核的 ECHO 行为，插件侧关不掉）。
//
// 这里把回显回来的那段字节丢掉。判定原则是「能逐字节对上才吃」：远端中途插了
// 别的东西（行编辑器重绘整行、用户抢先打字、echo 被关掉）就对不上，此时立刻
// 放弃并原样放行——宁可露出那行命令，也不能吞掉任何真实输出。要剥的那行本来就
// 短，不会触发行编辑器折行重绘，这正是把长钩子交给 `read -s` 而不是直接打在命令
// 行上的原因（长行折行重绘必然对不上）。
export interface EchoRedactor {
  /** 记下即将写入远端的字节，等它的回显回来时吃掉。 */
  hide(text: string): void
  /** 处理一个远端分片：返回剥掉注入回显之后、真正该画上屏的内容。 */
  filter(remote: string): string
  /** 会话重建：上一会话的注入回显不能再算到新会话头上。 */
  reset(): void
}

export function createEchoRedactor(): EchoRedactor {
  let pending = ''
  return {
    hide(text) {
      if (text) pending += text
    },
    filter(remote) {
      if (!pending || !remote) return remote
      let i = 0
      while (i < remote.length && i < pending.length && remote[i] === pending[i]) i++
      if (i === pending.length) {
        // 这段回显吃干净了：远端补的换行与提示符照常绘制。
        pending = ''
        return remote.slice(i)
      }
      if (i === remote.length) {
        // 远端还没回显完，接着等下一片。
        pending = pending.slice(i)
        return ''
      }
      // 中途对不上：放弃抵消，原样放行，后续输出也不再拦。
      pending = ''
      return remote
    },
    reset() {
      pending = ''
    },
  }
}
