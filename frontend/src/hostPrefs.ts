// 宿主外观镜像：GoNavi 打开插件窗口时把当前 locale/theme 注入 entry HTML
//（window.gonaviHostPrefs，见 GoNavi internal/nativewindow/plugin_child.go）。
// 注入发生在任何入口脚本之前；无注入（直接浏览器调试等）时回落浏览器
// 语言与浅色主题。语言/主题在窗口打开时定格——宿主运行中切换需重开窗口。

export type HostTheme = 'light' | 'dark'

export interface HostPrefs {
  locale: string
  theme: HostTheme
}

declare global {
  interface Window {
    gonaviHostPrefs?: { locale?: string; theme?: string }
  }
}

function resolveHostPrefs(): HostPrefs {
  const raw = window.gonaviHostPrefs
  const locale = raw?.locale && /^[a-zA-Z-]{2,32}$/.test(raw.locale)
    ? raw.locale
    : navigator.language || 'zh-CN'
  const theme: HostTheme = raw?.theme === 'dark' ? 'dark' : 'light'
  return { locale, theme }
}

export const hostPrefs: HostPrefs = resolveHostPrefs()

export const isDark = hostPrefs.theme === 'dark'

export function hostLanguage(): 'zh' | 'en' {
  return hostPrefs.locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
