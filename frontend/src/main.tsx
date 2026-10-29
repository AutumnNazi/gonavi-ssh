import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antdTheme } from 'antd'
import antdZhCN from 'antd/locale/zh_CN'
import antdZhTW from 'antd/locale/zh_TW'
import antdEnUS from 'antd/locale/en_US'
import antdJaJP from 'antd/locale/ja_JP'
import antdDeDE from 'antd/locale/de_DE'
import antdRuRU from 'antd/locale/ru_RU'
import App from './App'
import { hostPrefs, subscribeHostPrefs, type HostPrefs } from './hostPrefs'
import { antdLocaleKey } from './i18n'
import './styles.css'

// 启动期错误可视化：白屏时把错误直接渲染到页面，便于宿主窗口内定位。
function showFatal(label: string, detail: string) {
  let box = document.getElementById('__fatal')
  if (!box) {
    box = document.createElement('pre')
    box.id = '__fatal'
    box.style.cssText =
      'position:fixed;inset:0;z-index:99999;margin:0;padding:16px;overflow:auto;' +
      'background:#1e1e1e;color:#f56c6c;font:12px/1.5 Consolas,monospace;white-space:pre-wrap'
    document.body.appendChild(box)
  }
  box.textContent += `[${label}] ${detail}\n\n`
}
window.addEventListener(
  'error',
  e => {
    const target = e.target as HTMLElement | null
    if (target && target !== (window as unknown as EventTarget) && (target as HTMLScriptElement).src) {
      // 资源加载失败（script/link）：白屏最常见原因。
      showFatal('resource', `${(target as HTMLScriptElement).src}`)
      return
    }
    showFatal('error', `${e.message}\n${e.filename ?? ''}:${e.lineno ?? ''}`)
  },
  true,
)
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason
  showFatal('unhandledrejection', reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason))
})

const antdLocales = {
  zh_CN: antdZhCN,
  zh_TW: antdZhTW,
  en_US: antdEnUS,
  ja_JP: antdJaJP,
  de_DE: antdDeDE,
  ru_RU: antdRuRU,
}

function applyHostPrefs(prefs: HostPrefs) {
  document.body.classList.toggle('theme-dark', prefs.theme === 'dark')
  const colors = {
    '--bg': prefs.palette?.bg, '--card-bg': prefs.palette?.panel, '--header-bg': prefs.palette?.panel,
    '--term-bg': prefs.palette?.code, '--toolbar-bg': prefs.palette?.chip, '--toolbar-fg': prefs.palette?.text,
    '--text': prefs.palette?.text, '--input-bg': prefs.palette?.input, '--border': prefs.palette?.border,
    '--border-strong': prefs.palette?.border1, '--hover-bg': prefs.palette?.hover,
    '--selected-bg': prefs.palette?.accentSoft, '--meta-fg': prefs.palette?.muted, '--accent': prefs.palette?.accent,
    '--ok': prefs.palette?.ok, '--warn': prefs.palette?.warn, '--warn-bg': prefs.palette?.warnBg,
  }
  for (const [key, value] of Object.entries(colors)) {
    if (value) document.body.style.setProperty(key, value)
    else document.body.style.removeProperty(key)
  }
  const metrics = {
    '--font-family': prefs.appearance?.fontFamily, '--mono-font-family': prefs.appearance?.monoFontFamily,
    '--font-size': prefs.appearance?.fontSize === undefined ? undefined : prefs.appearance.fontSize + 'px',
    '--mono-font-size': prefs.appearance?.monoFontSize === undefined ? undefined : prefs.appearance.monoFontSize + 'px',
    '--radius': prefs.appearance?.radius === undefined ? undefined : prefs.appearance.radius + 'px',
    '--radius-sm': prefs.appearance?.radius === undefined ? undefined : Math.max(0, prefs.appearance.radius - 2) + 'px',
    '--window-opacity': prefs.appearance?.opacity?.toString(),
    '--background-tint': prefs.appearance?.background?.tint === undefined ? undefined : prefs.appearance.background.tint * 100 + '%',
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined) document.documentElement.style.setProperty(key, value)
    else document.documentElement.style.removeProperty(key)
  }
  if (prefs.appearance?.background) document.body.dataset.backgroundImage = String(prefs.appearance.background.enabled)
  else delete document.body.dataset.backgroundImage
}

function antdColor(value: string): string | undefined {
  // AntD 的颜色派生库不支持 color(srgb)、oklch 等现代语法。
  // 只转换组件令牌，CSS 继续使用宿主原始安全颜色。
  if (/^(?:#|rgba?\(|hsla?\()/i.test(value)) return value
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return undefined
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data
  return alpha === 255 ? 'rgb(' + [r, g, b].join(', ') + ')' : 'rgba(' + [r, g, b, alpha / 255].join(', ') + ')'
}

function HostApp() {
  const [prefs, setPrefs] = React.useState(() => { applyHostPrefs(hostPrefs); return hostPrefs })
  React.useEffect(() => subscribeHostPrefs(next => { applyHostPrefs(next); setPrefs(next) }), [])
  const palette = Object.fromEntries(Object.entries(prefs.palette ?? {}).map(([key, value]) => [key, antdColor(value)]))
  const token = {
    colorPrimary: palette?.accent, colorInfo: palette?.accent, colorLink: palette?.accent, colorBgLayout: palette?.bg,
    colorBgContainer: palette?.panel, colorBgElevated: palette?.panel, colorText: palette?.text,
    colorTextSecondary: palette?.muted, colorBorder: palette?.border, colorBorderSecondary: palette?.border1,
    colorPrimaryBg: palette?.accentSoft, colorFillAlter: palette?.chip, controlItemBgHover: palette?.hover,
    colorSuccess: palette?.ok, colorWarning: palette?.warn, colorWarningBg: palette?.warnBg,
    fontFamily: prefs.appearance?.fontFamily, fontSize: prefs.appearance?.fontSize, borderRadius: prefs.appearance?.radius,
  }
  const overrides = Object.fromEntries(Object.entries(token).filter(([, value]) => value !== undefined))
  const algorithm = prefs.theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm
  return <ConfigProvider
    locale={antdLocales[antdLocaleKey()]}
    theme={{ algorithm: seed => ({ ...algorithm(seed), ...overrides }),
      token: overrides,
      components: { Input: { colorBgContainer: palette?.input }, InputNumber: { colorBgContainer: palette?.input }, Select: { colorBgContainer: palette?.input } },
    }}
  ><App /></ConfigProvider>
}

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><HostApp /></React.StrictMode>,
  )
} catch (e) {
  showFatal('render', e instanceof Error ? (e.stack ?? e.message) : String(e))
}
