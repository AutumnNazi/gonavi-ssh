const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 设置面板保存：校验失败时 antd reject 的是 { errorFields, values, outOfDate } 这种
// 普通对象而不是 Error，按钮又把这个 promise 直接交出去——收不好就是窗口被启动期
// 错误面板盖成 [unhandledrejection] [object Object]。
function fixture(invoke = async () => ({})) {
  const hooks = [], effects = [], scheduled = [], calls = [], messages = []
  let cursor = 0, tree
  const react = {
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, next => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
    },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const form = { validateFields: async () => ({}), setFieldsValue() {}, resetFields() {} }
  const message = Object.fromEntries(['error', 'success', 'warning'].map(type => [type, text => messages.push({ type, text })]))
  const Form = Object.assign(() => null, { useForm: () => [form], Item: 'Form.Item', List: 'Form.List' })
  const App = Object.assign(() => null, { useApp: () => ({ message }) })
  const components = new Proxy({ Form, App }, { get: (target, key) => target[key] ?? String(key) })
  const output = ts.transpileModule(fs.readFileSync(process.env.SETTINGS_PANEL_SOURCE || path.join(__dirname, 'components/SettingsPanel.tsx'), 'utf8'), {
    fileName: 'SettingsPanel.tsx', compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  const jsx = (type, props) => ({ type, props })
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return components
      if (name === '../bridge') return {
        invokeAs: async (command, args) => { calls.push({ command, args }); return invoke(command, args) },
        describeError: error => error.message || String(error),
      }
      if (name === '../i18n') return { t: key => key }
      return {}
    },
    setTimeout, clearTimeout, console,
  }, { filename: 'SettingsPanel.tsx' })
  const props = { settings: null, onSaved: () => calls.push({ command: 'onSaved' }) }
  function render() {
    cursor = 0
    tree = module.exports.SettingsPanel(props)
    for (const effect of scheduled.splice(0)) effect()
    return tree
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found } return undefined }
    if (predicate(node)) return node
    return node.props?.children === undefined ? undefined : find(predicate, node.props.children)
  }
  render()
  return { props, render, find, calls, messages, form, unmount() { for (const effect of effects) effect?.cleanup?.() } }
}

const saveButton = view => {
  const button = view.find(node => node.type === 'Button' && node.props.type === 'primary')
  assert.ok(button, '设置面板必须有主按钮（保存）')
  return button
}

test('a rejected validation never escapes the save button', async () => {
  const view = fixture()
  view.form.validateFields = async () => { throw { values: {}, errorFields: [{ name: ['sudoAllowlist'], errors: ['required'] }], outOfDate: false } }
  await assert.doesNotReject(saveButton(view).props.onClick())
  assert.equal(view.calls.some(call => call.command === 'settings.set'), false, '校验没过就不该保存')
  view.unmount()
})

test('valid input saves the mapped settings payload', async () => {
  const view = fixture()
  view.form.validateFields = async () => ({
    readOnly: true, sudoAllowlist: 'a\n\n  b ', readOnlyExec: 'systemctl', dangerous: '', localPaths: '  ',
    quickCommands: [{ name: 'ls', command: 'ls -l' }, { name: '', command: 'ignored' }], cwdFollow: true,
  })
  await saveButton(view).props.onClick()
  const saved = view.calls.find(call => call.command === 'settings.set')
  assert.ok(saved, '校验通过必须保存')
  assert.equal(saved.args.settings.readOnly, true)
  assert.equal(saved.args.settings.cwdFollow, true)
  assert.deepEqual([...saved.args.settings.sudoAllowlist], ['a', 'b'], '多行白名单要去空行与首尾空格')
  assert.deepEqual([...saved.args.settings.localPathAllowlist], [])
  assert.deepEqual([...saved.args.settings.quickCommands].map(q => q.name), ['ls'], '缺名字或缺命令的快速命令要丢掉')
  assert.equal(view.calls.some(call => call.command === 'onSaved'), true)
  view.unmount()
})
