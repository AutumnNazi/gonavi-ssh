const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function fixture(invoke = async () => ({})) {
  const hooks = [], effects = [], scheduled = [], calls = [], messages = [], refresh = []
  let cursor = 0, tree
  const react = {
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, next => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
    },
    useMemo: run => run(),
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const form = { resetFields() {}, setFieldsValue() {}, validateFields: async () => ({}) }
  const Form = Object.assign(() => null, { useForm: () => [form], useWatch: () => 'password', Item: 'Form.Item', List: 'Form.List' })
  const components = new Proxy({ Form, message: Object.fromEntries(['error', 'success', 'warning'].map(type => [type, text => messages.push({ type, text })])) }, { get: (target, key) => target[key] ?? String(key) })
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'components/ProfilePanel.tsx'), 'utf8'), {
    fileName: 'ProfilePanel.tsx', compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  const jsx = (type, props) => ({ type, props })
  vm.runInNewContext(output, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return components
      if (name === '@ant-design/icons') return {}
      if (name === '../bridge') return {
        invokeAs: async (command, args) => { calls.push({ command, args }); return invoke(command, args) },
        describeError: error => error.message || String(error),
      }
      if (name === '../i18n') return { t: (key, params) => key + (params ? ':' + JSON.stringify(params) : '') }
      return {}
    },
    setTimeout, clearTimeout, console,
  }, { filename: 'ProfilePanel.tsx' })
  const profiles = [
    { id: 'a', name: '127.0.0.1 (a very long database connection name gonavi)', host: 'host-a', port: 22, user: 'ops', authMethod: 'password' },
    { id: 'b', name: 'Second', host: 'host-b', port: 22, user: 'ops', authMethod: 'key' },
  ]
  const props = { profiles, connections: [], onConnect() {}, onChanged: () => refresh.push('profiles'), onConnectionsChanged: () => refresh.push('connections') }
  function render() {
    cursor = 0
    tree = module.exports.ProfilePanel(props)
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
  return { props, render, find, calls, messages, refresh, unmount() { for (const effect of effects) effect?.cleanup?.() } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('null connection lists allow deletion of all disconnected selected profiles', async () => {
  const view = fixture(async command => command === 'conn.status' ? { connections: null } : {})
  view.props.profiles = Array.from({ length: 5 }, (_, i) => ({ ...view.props.profiles[0], id: 'empty-' + i, name: 'Disconnected ' + i }))
  view.render()
  try {
    await selectAllAndConfirm(view).props.onOk()
    assert.deepEqual(view.calls.filter(call => call.command === 'profile.delete').map(call => call.args.id), view.props.profiles.map(p => p.id))
    assert.equal(view.messages.some(message => message.type === 'error'), false)
  } finally { view.unmount() }
})

test('the final disconnected session can be closed before a null verification snapshot', async () => {
  let closed = false
  const view = fixture(async command => {
    if (command === 'conn.status') return { connections: closed ? null : [{ connectionId: 'last', profileId: 'a', state: 'ready', alive: true }] }
    if (command === 'conn.close') closed = true
    return {}
  })
  try {
    await selectAllAndConfirm(view).props.onOk()
    assert.deepEqual(view.calls.filter(call => call.command !== 'conn.status').map(call => call.command + ':' + (call.args.id || call.args.connectionId)), ['conn.close:last', 'profile.delete:a', 'profile.delete:b'])
    assert.equal(view.messages.some(message => message.type === 'error'), false)
  } finally { view.unmount() }
})

test('single profile confirmation accepts the same null connection response', async () => {
  const view = fixture(async command => command === 'conn.status' ? { connections: null } : {})
  try {
    const confirm = view.find(node => node.type === 'Popconfirm')
    await confirm.props.onConfirm()
    assert.deepEqual(view.calls.filter(call => call.command === 'profile.delete').map(call => call.args.id), ['a'])
    assert.equal(view.messages.some(message => message.type === 'error'), false)
  } finally { view.unmount() }
})

test('missing or malformed connection responses remain fail-closed', async () => {
  for (const response of [undefined, null, {}, { connections: 'bad' }, { connections: {} }, { connections: [null] }, { connections: [{}] }, { connections: [{ connectionId: 'bad', profileId: 'a', state: 'unknown' }] }, { connections: [{ connectionId: 'bad', profileId: 'a', state: 'ready', alive: 'false' }] }]) {
    const view = fixture(async command => command === 'conn.status' ? response : {})
    try {
      await selectAllAndConfirm(view).props.onOk()
      assert.equal(view.calls.some(call => call.command === 'profile.delete'), false)
      assert.equal(view.messages.some(message => message.type === 'error'), true)
    } finally { view.unmount() }
  }
})


test('partial selection survives refresh while removed profiles are pruned and can be deselected', () => {
  const view = fixture()
  const select = view.find(node => node.type === 'Checkbox' && node.props['aria-label']?.startsWith('conn.selectProfile:'))
  select.props.onChange({ target: { checked: true } })
  view.render()
  let all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.equal(all.props.checked, false)
  assert.equal(all.props.indeterminate, true)
  view.props.profiles = [view.props.profiles[1]]
  view.render(); view.render()
  all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.equal(all.props.checked, false)
  assert.equal(all.props.indeterminate, false)
  assert.equal(view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.deleteSelected').props.disabled, true)
  all.props.onChange({ target: { checked: true } }); view.render()
  all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.equal(all.props.checked, true)
  all.props.onChange({ target: { checked: false } }); view.render()
  assert.equal(view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.deleteSelected').props.disabled, true)
  view.unmount()
})

test('unknown connection state failures never proceed to profile deletion', async () => {
  const view = fixture(async command => { if (command === 'conn.status') throw new Error('status unavailable'); return {} })
  await selectAllAndConfirm(view).props.onOk()
  assert.equal(view.calls.some(call => call.command === 'profile.delete'), false)
  assert.ok(view.messages.some(message => message.type === 'error' && message.text.includes('status unavailable')))
})

test('batch selection and deletion messages exist in all six locale catalogs without duplicate keys', () => {
  const source = fs.readFileSync(path.join(__dirname, 'i18n.ts'), 'utf8')
  const ast = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true)
  const dictionaries = ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations]).filter(d => ['zhCN', 'zhTW', 'en', 'ja', 'de', 'ru'].includes(d.name.getText(ast)))
  const required = ['conn.selectAll', 'conn.selectProfile', 'conn.selectedCount', 'conn.deleteSelected', 'conn.deleteSelectedConfirm', 'conn.deleteProfilesOnly', 'conn.deleteStillActive', 'conn.deletedCount', 'conn.deleteFailedCount', 'conn.statusInvalid']
  assert.equal(dictionaries.length, 6)
  for (const dict of dictionaries) {
    const keys = dict.initializer.properties.map(p => p.name.text)
    assert.equal(new Set(keys).size, keys.length)
    for (const key of required) assert.ok(dict.initializer.properties.find(p => p.name.text === key)?.initializer.text.trim(), dict.name.getText(ast) + ' lacks ' + key)
  }
})


function selectAllAndConfirm(view) {
  const all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.ok(all)
  all.props.onChange({ target: { checked: true } })
  view.render()
  view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.deleteSelected').props.onClick()
  view.render()
  return view.find(node => node.type === 'Modal' && node.props.open && node.props.title === 'conn.deleteSelected')
}

test('batch deletion closes live sessions and cancels authentication before deleting profiles', async () => {
  const live = [{ profileId: 'a', connectionId: 'ready-a', state: 'ready', alive: true }, { profileId: 'b', connectionId: 'pending-b', state: 'needInput' }]
  const view = fixture(async (command, args) => {
    if (command === 'conn.status') return { connections: live.filter(conn => !args.connectionId || conn.connectionId === args.connectionId) }
    if (command === 'conn.close' || command === 'conn.cancel') live.splice(live.findIndex(conn => conn.connectionId === args.connectionId), 1)
    return {}
  })
  const dialog = selectAllAndConfirm(view)
  await dialog.props.onOk()
  assert.deepEqual(view.calls.filter(call => call.command !== 'conn.status').map(call => call.command + ':' + (call.args.id || call.args.connectionId)), ['conn.close:ready-a', 'profile.delete:a', 'conn.cancel:pending-b', 'profile.delete:b'])
  assert.deepEqual(view.refresh, ['profiles', 'connections'])
})

test('failed cleanup retains its profile while successful deletions are removed from selection', async () => {
  const view = fixture(async (command, args) => {
    if (command === 'conn.status') return { connections: [{ profileId: 'a', connectionId: 'ready-a', state: 'ready', alive: true }] }
    if (command === 'conn.close') throw new Error('cleanup failed')
    return {}
  })
  await selectAllAndConfirm(view).props.onOk()
  assert.deepEqual(view.calls.filter(call => call.command === 'profile.delete').map(call => call.args.id), ['b'])
  assert.ok(view.messages.some(message => message.type === 'error' && message.text.includes('cleanup failed')))
  view.render()
  const all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.equal(all.props.checked, false)
  assert.equal(all.props.indeterminate, true)
})

test('a cancelled authentication that remains active must not have its profile deleted', async () => {
  const view = fixture(async (command, args) => command === 'conn.status' ? { connections: [{ profileId: 'a', connectionId: 'pending-a', state: 'connecting' }] } : {})
  await selectAllAndConfirm(view).props.onOk()
  assert.deepEqual(view.calls.filter(call => call.command === 'profile.delete').map(call => call.args.id), ['b'])
  assert.ok(view.messages.some(message => message.type === 'error'))
})

test('repeated confirmation cannot issue duplicate deletions and a failed delete stays selected', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const view = fixture(async (command, args) => {
    if (command === 'conn.status') return { connections: [] }
    if (command === 'profile.delete' && args.id === 'a') { await wait; throw new Error('delete failed') }
    return {}
  })
  const dialog = selectAllAndConfirm(view)
  const first = dialog.props.onOk()
  const second = dialog.props.onOk()
  await tick()
  release()
  await Promise.all([first, second])
  assert.deepEqual(view.calls.filter(call => call.command === 'profile.delete').map(call => call.args.id), ['a', 'b'])
  view.render()
  assert.equal(view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll').props.indeterminate, true)
})


test('long connection names retain their complete title and do not share the authentication tag row', () => {
  const view = fixture()
  const name = view.find(node => node.props?.className === 'conn-name')
  assert.equal(name.props.title, view.props.profiles[0].name)
  const main = view.find(node => node.props?.className === 'conn-card-name')
  assert.ok(view.find(node => node.props?.className === 'conn-card-tags', main), 'tags need a separate shrink-safe row')
})

test('selection has all/partial states and never deletes before confirmation', async () => {
  const view = fixture()
  const all = view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll')
  assert.ok(all, 'profile list needs a select-all control')
  assert.equal(all.props.checked, false)
  all.props.onChange({ target: { checked: true } })
  view.render()
  assert.equal(view.find(node => node.type === 'Checkbox' && node.props['aria-label'] === 'conn.selectAll').props.checked, true)
  const remove = view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.deleteSelected')
  assert.equal(remove.props.disabled, false)
  remove.props.onClick()
  view.render()
  const dialog = view.find(node => node.type === 'Modal' && node.props.open && node.props.title === 'conn.deleteSelected')
  assert.ok(dialog, 'deletion requires confirmation')
  assert.equal(view.calls.length, 0)
  dialog.props.onCancel()
  view.render()
  assert.equal(view.calls.length, 0)
  view.unmount()
})
