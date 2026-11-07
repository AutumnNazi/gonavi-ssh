const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 设置面板已经"改完即生效"：面板里没有保存按钮，每项变动自己落盘（文本域走防抖）。
// 这里断言的是落盘内容与时机，不是某个按钮被点过。
function fixture(invoke = async () => ({})) {
  const hooks = [], effects = [], scheduled = [], calls = [], messages = []
  let cursor = 0, tree
  const react = {
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, next => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
    },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useCallback(fn) { return fn },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const form = {
    values: {},
    setFieldsValue(next) { Object.assign(form.values, next) },
    getFieldsValue() { return { ...form.values } },
    resetFields() {},
  }
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
  const props = {
    settings: null,
    onSaved: () => calls.push({ command: 'onSaved' }),
  }
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

// 防抖的等待：比 SAVE_DEBOUNCE_MS(400) 多留一截余量。
const waitSave = () => new Promise(resolve => setTimeout(resolve, 600))
const writes = view => view.calls.filter(call => call.command === 'settings.set')
const lastWrite = view => writes(view).at(-1)?.args.settings

// antd Form 的 onValuesChange 就是落盘入口——点它等于用户在表单里改了一次。
const changeValues = (view, all) => {
  const formEl = view.find(node => typeof node.props?.onValuesChange === 'function')
  assert.ok(formEl, '设置表单必须挂 onValuesChange，否则改动不会落盘')
  formEl.props.onValuesChange({}, all)
}

const BASE = { readOnly: false, sudoAllowlist: [], quickCommands: [], historyLimit: 500 }

test('the settings page has no save button any more', async () => {
  const view = fixture()
  view.props.settings = { ...BASE }
  view.render()
  assert.equal(
    view.find(node => node.type === 'Button' && node.props.type === 'primary'), undefined,
    '改完即生效之后，主按钮（保存）应当已经拿掉',
  )
})

test('every field lands in settings as soon as it changes', async () => {
  const view = fixture()
  view.props.settings = { ...BASE }
  view.render()
  changeValues(view, {
    readOnly: true, sudoAllowlist: 'a\n\n  b ', readOnlyExec: 'systemctl', dangerous: '', localPaths: '  ',
    quickCommands: [{ name: 'ls', command: 'ls -l' }, { name: '', command: 'ignored' }],
    localEcho: true, showFileTree: true,
    treeCommands: [{ name: 'logs', path: '/var/log' }, { name: 'no-path', path: '' }, { name: '', path: '/x' }],
  })
  await waitSave()
  const saved = lastWrite(view)
  assert.equal(saved.readOnly, true)
  assert.equal(saved.localEcho, true, '显示开关也走同一条落盘路径')
  assert.equal(saved.showFileTree, true)
  assert.deepEqual([...saved.sudoAllowlist], ['a', 'b'], '多行白名单去空行与首尾空格')
  assert.deepEqual([...saved.readOnlyExecAllowlist], ['systemctl'])
  assert.deepEqual([...saved.localPathAllowlist], [], '空文本域就是空列表，不是"没改过"')
  assert.deepEqual([...saved.quickCommands].map(q => q.name), ['ls'], '缺名字或缺命令的快速命令要丢掉')
  assert.deepEqual([...saved.treeCommands].map(j => j.name), ['logs'], '缺命令或缺目录的跳转映射要丢掉')
  assert.equal(view.calls.some(call => call.command === 'onSaved'), true, '落盘后要通知上层刷新')
})

test('the directory follow switch is carried back untouched', async () => {
  // 跟随的开关长在文件面板底部：设置页全量写入时不能凭空造一个 false 把它关掉。
  const view = fixture()
  view.props.settings = { ...BASE, cwdFollow: true }
  view.render()
  changeValues(view, { readOnly: false, quickCommands: [] })
  await waitSave()
  assert.equal(lastWrite(view).cwdFollow, true)
})

test('a burst of edits is written once, not once per keystroke', async () => {
  const view = fixture()
  view.props.settings = { ...BASE }
  view.render()
  for (const text of ['u', 'up', 'upt']) changeValues(view, { sudoAllowlist: text, quickCommands: [] })
  await waitSave()
  assert.equal(writes(view).length, 1, '连着敲字只该写一次盘')
  assert.deepEqual([...lastWrite(view).sudoAllowlist], ['upt'], '落盘的要是最后那次输入')
})

test('a pending edit is flushed when the panel goes away', async () => {
  // 改完立刻关窗：防抖还没到点，最后一次编辑不能在卸载时无声丢掉。
  const view = fixture()
  view.props.settings = { ...BASE }
  view.render()
  changeValues(view, { sudoAllowlist: 'uptime', quickCommands: [] })
  view.unmount()
  await waitSave()
  assert.equal(writes(view).length, 1, '卸载前要把还没落盘的补上')
  assert.deepEqual([...lastWrite(view).sudoAllowlist], ['uptime'])
})

test('stored values seed the form, missing optional switches read as off', async () => {
  const off = fixture()
  off.props.settings = { ...BASE }
  off.render()
  assert.equal(off.form.values.localEcho, false, '缺字段＝用户从没开过')
  assert.equal(off.form.values.showFileTree, false)
  assert.deepEqual([...off.form.values.treeCommands], [], '没配过跳转映射就是空列表')

  const on = fixture()
  on.props.settings = { ...BASE, localEcho: true, showFileTree: true, treeCommands: [{ name: 'l', path: '/l' }] }
  on.render()
  assert.equal(on.form.values.localEcho, true, '显式打开要显示为开')
  assert.equal(on.form.values.showFileTree, true)
  assert.deepEqual([...on.form.values.treeCommands].map(j => j.name), ['l'])
})
