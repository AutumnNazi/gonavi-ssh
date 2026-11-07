import { message } from 'antd'

// 复制文本到剪贴板。宿主窗口不一定给了剪贴板权限，失败时把内容直接显示出来，
// 让用户至少能手选——不能点一下什么都不发生。
export async function copyToClipboard(text: string, label: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success(`${label}: ${text}`)
  } catch {
    message.warning(text)
  }
}
