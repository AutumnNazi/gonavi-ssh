const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 入口的启动期兜底面板：真正要把窗口盖住时，面板上必须能读到原因。
// 插件错误是 { code, message } 普通对象，String(reason) 只会显示 [object Object]。
function load() {
  const listeners = {}, appended = [], modules = {}
  const document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    body: { appendChild: node => appended.push(node) },
  }
  const window = { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler) } }
  const loadTs = file => {
    if (modules[file]) return modules[file].exports
    const module = { exports: {} }
    modules[file] = module
    const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
      fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    // 每个模块都用自己的 module/exports 跑，否则 require 拿到的永远是入口那份。
    context.module = module
    context.exports = module.exports
    vm.runInNewContext(output, context, { filename: file })
    return module.exports
  }
  const context = {
    module: {}, exports: {}, console, setTimeout, clearTimeout, document, window,
    require(name) {
      // transpileModule 不开 esModuleInterop：默认导入会取 .default，JSX 走 react/jsx-runtime。
      if (name === 'react') return {
        StrictMode: 'StrictMode', useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect: () => {},
        default: { StrictMode: 'StrictMode', useState: () => [null, () => {}], useEffect: () => {} },
      }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === 'react-dom/client') return {
        createRoot: () => ({ render: () => {} }),
        default: { createRoot: () => ({ render: () => {} }) },
      }
      if (name === 'antd') return new Proxy({}, { get: (target, key) => String(key) })
      if (name === './App') return { default: () => null }
      if (name === './hostPrefs') return { hostPrefs: { locale: 'zh-CN', theme: 'light' }, subscribeHostPrefs: () => () => {} }
      if (name === './i18n') return { antdLocaleKey: () => 'zh_CN' }
      if (name === './bridge') return loadTs('bridge.ts')
      return {}
    },
  }
  loadTs(process.env.MAIN_SOURCE || 'main.tsx')
  return {
    emit(type, event) { for (const handler of listeners[type] ?? []) handler(event) },
    fatal: () => appended.map(node => node.textContent).join(''),
  }
}

test('the fatal panel prints the plugin error message instead of [object Object]', () => {
  const app = load()
  app.emit('unhandledrejection', { reason: { code: 4101, message: '会话已结束' } })
  assert.equal(app.fatal(), '[unhandledrejection] 会话已结束\n\n')
})

test('the fatal panel keeps the message of a real Error', () => {
  const app = load()
  app.emit('unhandledrejection', { reason: new Error('bridge down') })
  assert.match(app.fatal(), /bridge down/)
  app.emit('error', { message: 'boom', filename: 'app.js', lineno: 3 })
  assert.match(app.fatal(), /\[error\] boom\napp\.js:3/)
})
