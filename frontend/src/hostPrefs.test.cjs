const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function mountedHost(initial, canvasContext) {
  const window = new EventTarget()
  window.gonaviHostPrefs = initial
  const properties = new Map(), classes = new Set()
  const style = { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) }
  const document = { body: { style, dataset: {}, classList: { toggle(key, active) { active ? classes.add(key) : classes.delete(key) } } }, documentElement: { style }, getElementById: () => ({}), createElement: tag => tag === 'canvas' ? { getContext: () => canvasContext } : { style: {} } }
  const hooks = [], effects = [], pending = []
  let cursor = 0, tree
  const jsx = (type, props) => ({ type, props })
  const react = { StrictMode: 'StrictMode', useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, value => { hooks[i].value = value }] }, useEffect(run, deps) { const i = cursor++; if (!effects[i]) pending.push(() => { effects[i] = run() }) } }
  const App = () => null
  const cache = {}
  function load(file) {
    if (cache[file]) return cache[file]
    const exports = {}; cache[file] = exports
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
    const require = name => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-dom/client') return { createRoot: () => ({ render: value => { tree = value } }) }
      if (name === 'antd') return { ConfigProvider: 'ConfigProvider', theme: { darkAlgorithm: () => ({ mode: 'dark' }), defaultAlgorithm: () => ({ mode: 'light' }) } }
      if (name.startsWith('antd/locale/')) return name
      if (name === './App') return App
      if (name === './hostPrefs') return load('hostPrefs.ts')
      if (name === './i18n') return load('i18n.ts')
      return {}
    }
    vm.runInNewContext(output, { exports, module: { exports }, require, window, navigator: { language: 'en-US' }, document }, { filename: file })
    return exports
  }
  load('main.tsx')
  function render() { cursor = 0; let node = tree.props.children; if (typeof node.type === 'function') node = node.type(node.props); for (const run of pending.splice(0)) run(); return node }
  return { render, properties, classes, cache, send(value) { window.gonaviHostPrefs = value; window.dispatchEvent(new Event('gonavi:host-preferences')) }, unmount() { for (const cleanup of effects) cleanup?.() } }
}

test('real main ConfigProvider and CSS consume initial and same-mode host presets without replacing App', () => {
  const host = mountedHost({ locale: 'en-US', theme: 'light', palette: { bg: '#fff8ed', panel: '#fffaf4', input: '#fffdf8', code: '#fff8ed', text: '#30251a', accent: '#a16024' } })
  try {
    const first = host.render()
    assert.equal(first.props.theme.token?.colorPrimary, '#a16024', 'first ConfigProvider render must receive the actual preset')
    assert.equal(first.props.theme.token?.colorLink, '#a16024', 'connection action links must use the host accent')
    assert.equal(host.properties.get('--bg'), '#fff8ed')
    const app = first.props.children.type
    host.send({ locale: 'ja-JP', theme: 'light', palette: { bg: '#eef8f4', code: '#edf5f1', text: '#213d30', accent: '#267657' } })
    const next = host.render()
    assert.equal(next.props.theme.token.colorPrimary, '#267657')
    assert.equal(next.props.theme.token.colorLink, '#267657')
    assert.equal(next.props.theme.algorithm({}).mode, 'light')
    assert.equal(next.props.theme.algorithm({}).colorPrimary, '#267657')
    assert.equal(next.props.locale, 'antd/locale/ja_JP')
    assert.equal(host.properties.get('--bg'), '#eef8f4')
    assert.equal(next.props.children.type, app)
  } finally { host.unmount() }
})


test('invalid and absent host values clear stale palette and metrics; repeated same-object events remain live', () => {
  const raw = { locale: 'en-US', theme: 'dark', palette: { bg: '#112233', code: '#102030', unknown: '#ff0000' }, appearance: { fontFamily: 'Arial, sans-serif', monoFontFamily: 'Consolas, monospace', fontSize: 17, monoFontSize: 15, radius: 9, opacity: .8, background: { enabled: true, tint: .9, url: 'file:///secret' } } }
  const host = mountedHost(raw)
  try {
    host.render()
    const prefs = host.cache['hostPrefs.ts'].hostPrefs
    assert.equal(prefs.palette.unknown, undefined)
    assert.equal(prefs.appearance.background.url, undefined)
    assert.equal(host.properties.get('--font-size'), '17px')
    raw.palette.bg = '#223344'
    host.send(raw); host.render()
    assert.equal(host.properties.get('--bg'), '#223344')
    raw.palette = { bg: 'inherit', code: 'url(https://invalid)', text: 'var(--unsafe)', accent: '#zzzzzz' }
    raw.appearance = { fontFamily: 'inherit', monoFontFamily: 'url(https://invalid)', fontSize: NaN, monoFontSize: 49, radius: -1, opacity: .01, background: { enabled: 'true', tint: 2 } }
    host.send(raw)
    const cleared = host.render()
    assert.equal(host.cache['hostPrefs.ts'].hostPrefs.palette, undefined)
    assert.equal(host.cache['hostPrefs.ts'].hostPrefs.appearance, undefined)
    assert.equal(host.properties.size, 0)
    assert.equal(cleared.props.theme.token.colorPrimary, undefined)
    assert.equal(host.classes.has('theme-dark'), true)
    host.send(undefined)
    const fallback = host.render()
    assert.equal(host.cache['hostPrefs.ts'].hostPrefs.locale, 'en-US')
    assert.equal(fallback.props.theme.algorithm({}).mode, 'light')
    assert.equal(host.classes.has('theme-dark'), false)
  } finally { host.unmount() }
})

test('main and preference subscriptions clean up on unmount; locale catalog follows each event', () => {
  const host = mountedHost({ locale: 'zh-CN', theme: 'light' })
  host.render()
  const i18n = host.cache['i18n.ts']
  assert.equal(i18n.t('term.copy'), '复制')
  host.send({ locale: 'de-DE', theme: 'light' });host.render()
  assert.equal(i18n.t('term.copy'), 'Kopieren')
  const snapshot = host.cache['hostPrefs.ts'].hostPrefs
  host.unmount()
  host.send({ locale: 'ja-JP', theme: 'dark', palette: { bg: '#112233' } })
  assert.equal(host.cache['hostPrefs.ts'].hostPrefs, snapshot)
  assert.equal(host.properties.size, 0)
})

test('modern host panel colors are converted before AntD derives authentication tag backgrounds', () => {
  const { FastColor } = require('@ant-design/fast-color')
  const canvas = { fillStyle: '', clearRect() {}, fillRect() {}, getImageData() { return { data: Uint8ClampedArray.from([245, 251, 252, 255]) } } }
  const panel = 'color(srgb 0.960784 0.984314 0.988235)'
  const host = mountedHost({ locale: 'zh-CN', theme: 'light', palette: { bg: panel, panel, input: panel, text: '#142830', accent: '#0d7983' } }, canvas)
  try {
    const initial = host.render()
    const token = initial.props.theme.token
    assert.equal(new FastColor(token.colorBgContainer).toHexString(), '#f5fbfc', 'AntD must not interpret the host panel as black')
    assert.equal(new FastColor('rgba(0,0,0,.02)').onBackground(token.colorBgContainer).toHexString(), '#f0f6f7')
    assert.equal(host.properties.get('--card-bg'), panel, 'CSS must retain the original host color')
    host.send({ locale: 'zh-CN', theme: 'dark', palette: { panel: 'rgba(20, 30, 40, 0.5)' } })
    assert.equal(host.render().props.theme.token.colorBgContainer, 'rgba(20, 30, 40, 0.5)', 'supported alpha colors must not become opaque')
  } finally { host.unmount() }
})
