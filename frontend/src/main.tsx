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
import { isDark } from './hostPrefs'
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

// 宿主主题与语言定格于窗口打开时（注入的 gonaviHostPrefs）；运行中不切换。
document.body.classList.toggle('theme-dark', isDark)

const antdLocales = {
  zh_CN: antdZhCN,
  zh_TW: antdZhTW,
  en_US: antdEnUS,
  ja_JP: antdJaJP,
  de_DE: antdDeDE,
  ru_RU: antdRuRU,
}

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ConfigProvider
        locale={antdLocales[antdLocaleKey()]}
        theme={{ algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
      >
        <App />
      </ConfigProvider>
    </React.StrictMode>,
  )
} catch (e) {
  showFatal('render', e instanceof Error ? (e.stack ?? e.message) : String(e))
}
