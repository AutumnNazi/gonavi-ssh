const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function fixture(invoke = async () => ({})) {
  const hooks = [], effects = [], scheduled = [], calls = [], timers = new Map(), messages = [], modals = []
  let cursor = 0, tree, nextTimer = 0, changed = false
  const react = {
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, value => {
        const next = typeof value === 'function' ? value(hooks[i].value) : value
        if (!Object.is(next, hooks[i].value)) { hooks[i].value = next; changed = true }
      }]
    },
    useMemo(run, deps) {
      const i = cursor++, old = hooks[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) hooks[i] = { deps, value: run() }
      return hooks[i].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const jsx = (type, props) => ({ type, props })
  const output = ts.transpileModule(fs.readFileSync(process.env.SFTP_SOURCE_FILE || path.join(__dirname, 'components/SftpPanel.tsx'), 'utf8'), {
    fileName: 'SftpPanel.tsx', compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  const props = { profiles: [{ id: 'a', name: 'Server A', user: 'ops', host: 'a', port: 22, authMethod: 'none' }, { id: 'b', name: 'Server B', user: 'ops', host: 'b', port: 22, authMethod: 'none' }], connections: [{ profileId: 'a', connectionId: 'ready-a', state: 'ready', alive: true }], onConnectionsChanged() {} }
  vm.runInNewContext(output, {
    module, exports: module.exports, console, Date,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return new Proxy({ Modal: Object.assign(function Modal() {}, { confirm: config => modals.push(config) }), message: Object.fromEntries(['error', 'warning', 'success'].map(type => [type, text => messages.push({ type, text })])) }, { get: (target, key) => target[key] ?? String(key) })
      if (name === '@ant-design/icons') return {}
      if (name === '../bridge') return { invokeAs: async (command, args) => { calls.push({ command, args }); return invoke(command, args) }, describeError: error => error.message || String(error) }
      if (name === '../i18n') return { t: key => key }
      if (name === '../b64') return { decodeText: text => text, encodeText: text => text }
      if (name === './sftpRequests') {
        const helper = { exports: {} }
        const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'components/sftpRequests.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText
        vm.runInNewContext(code, { module: helper, exports: helper.exports })
        return helper.exports
      }
      return {}
    },
  }, { filename: 'SftpPanel.tsx' })
  function render() {
    for (let rounds = 0; rounds < 10; rounds++) {
      changed = false; cursor = 0
      tree = module.exports.SftpPanel(props)
      for (const run of scheduled.splice(0)) run()
      if (!changed) return tree
    }
    throw new Error('fixture render did not converge')
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { if (child == null) continue; const result = find(predicate, child); if (result) return result } return undefined }
    if (predicate(node)) return node
    return node.props?.children === undefined ? undefined : find(predicate, node.props.children)
  }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render() }
  render()
  return { props, render, settle, find, calls, timers, messages, modals, unmount() { for (const e of effects) e?.cleanup?.(); timers.clear() } }
}

test('first explicit local to remote switch resolves its default and opens it immediately', async () => {
  const view = fixture(async (command, args) => command === 'conn.open' ? { profileId: args.profileId, connectionId: 'new-' + args.profileId, state: 'ready', alive: true } : command === 'fs.listLocal' ? { entries: [], home: '' } : command === 'sftp.list' ? { entries: [], more: false } : { tasks: [] })
  try {
    await view.settle()
    view.find(node => node.type === 'Segmented' && node.props.value === 'local').props.onChange('remote')
    await view.settle()
    assert.deepEqual(view.calls.filter(call => call.command === 'conn.open').map(call => call.args.profileId), ['b'], 'first explicit switch must open default b rather than leave an offline selection')
  } finally { view.unmount() }
})

test('late server A list cannot become a server B deletion source', async () => {
  let releaseA
  const pendingA = new Promise(resolve => { releaseA = resolve })
  const entryA = { name: 'only-A.txt', path: '/path-A/only-A.txt', isDir: false, size: 1 }
  const entryB = { name: 'only-B.txt', path: '/path-B/only-B.txt', isDir: false, size: 1 }
  const view = fixture(async (command, args) => command === 'sftp.list' ? args.connectionId === 'ready-a' ? pendingA : { entries: [entryB], more: false } : command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] })
  try {
    await view.settle()
    view.props.connections = [...view.props.connections, { profileId: 'b', connectionId: 'ready-b', state: 'ready', alive: true }]
    await view.settle()
    view.find(node => node.type === 'Select' && node.props.className === 'pane-source').props.onChange('b')
    await view.settle()
    const pane = () => view.find(node => node.props?.className === 'fs-pane fs-pane-remote')
    const list = () => view.find(node => node.type === 'List', pane())
    assert.equal(list().props.dataSource[0].path, entryB.path)
    releaseA({ entries: [entryA], more: true })
    await view.settle()
    list().props.renderItem(list().props.dataSource[0]).props.onClick()
    await view.settle()
    await view.find(node => node.type === 'Button' && node.props.title === 'sftp.remove', pane()).props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(view.calls.filter(call => call.command === 'sftp.remove').map(call => call.args))), [{ connectionId: 'ready-b', path: entryB.path }], 'late A must never send server B a deletion for path A')
    assert.equal(list().props.dataSource[0].path, entryB.path)
  } finally { releaseA({ entries: [], more: false }); view.unmount() }
})

test('losing a selected SFTP connection never reopens it on status refresh', async () => {
  const view = fixture(async command => command === 'conn.open' ? { profileId: 'a', connectionId: 'reopened', state: 'ready', alive: true } : command === 'fs.listLocal' ? { entries: [], home: '' } : command === 'sftp.list' ? { entries: [], more: false } : { tasks: [] })
  try {
    await view.settle()
    assert.equal(view.calls.filter(c => c.command === 'conn.open').length, 0)
    view.calls.length = 0
    view.props.connections = []
    await view.settle()
    view.props.connections = []; await view.settle()
    assert.equal(view.calls.filter(c => c.command === 'conn.open').length, 0, 'manual disconnect must not be reversed by the file panel')
  } finally { view.unmount() }
})



test('opening the file panel with only offline profiles never starts a connection', async () => {
  const view = fixture(async command => command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] })
  try {
    view.props.connections = []
    await view.settle()
    view.props.profiles = [...view.props.profiles]
    await view.settle()
    assert.equal(view.calls.some(call => call.command === 'conn.open'), false)
  } finally { view.unmount() }
})

test('left remote pane also remains disconnected after the connection disappears', async () => {
  const view = fixture(async (command, args) => command === 'conn.open' ? { profileId: args.profileId, connectionId: 'new-' + args.profileId, state: 'ready', alive: true } : command === 'sftp.list' ? { entries: [{ name: 'remote.txt', path: '/remote.txt' }], more: false } : command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] })
  try {
    await view.settle()
    const left = view.find(node => node.type === 'Segmented' && node.props.value === 'local')
    left.props.onChange('remote')
    await view.settle()
    const select = view.find(node => node.type === 'Select' && node.props.className === 'pane-source')
    select.props.onChange('b')
    await view.settle()
    view.props.connections = [{ profileId: 'b', connectionId: 'ready-b', state: 'ready', alive: true }]
    await view.settle()
    view.calls.length = 0
    view.props.connections = []
    await view.settle()
    assert.equal(view.calls.some(call => call.command === 'conn.open'), false)
    const leftPane = view.find(node => node.props?.className === 'fs-pane fs-pane-remote')
    assert.equal(view.find(node => node.type === 'List', leftPane).props.dataSource.length, 0)
  } finally { view.unmount() }
})

test('duplicate explicit requests for a profile share one in-flight open', async () => {
  let release
  const opening = new Promise(resolve => { release = resolve })
  const view = fixture(async command => command === 'conn.open' ? opening : command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] })
  try {
    view.props.connections = []
    await view.settle()
    const connect = view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect')
    connect.props.onClick(); connect.props.onClick()
    assert.equal(view.calls.filter(call => call.command === 'conn.open').length, 1)
    release({ profileId: 'a', connectionId: 'new-a', state: 'ready', alive: true })
    await view.settle()
    connect.props.onClick()
    await view.settle()
    assert.equal(view.calls.filter(call => call.command === 'conn.open').length, 2)
  } finally { release?.({ state: 'ready' }); view.unmount() }
})

test('a disappeared pending connection stops polling without reopening or reporting failure', async () => {
  const view = fixture(async command => command === 'conn.open' ? { profileId: 'a', connectionId: 'pending-a', state: 'connecting' } : command === 'conn.status' ? { connections: null } : command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] })
  try {
    view.props.connections = []
    await view.settle()
    const beforeTimers = view.timers.size
    view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect').props.onClick()
    await view.settle()
    assert.equal(view.calls.filter(call => call.command === 'conn.open').length, 1)
    assert.equal(view.calls.filter(call => call.command === 'conn.status').length, 1)
    assert.equal(view.timers.size, beforeTimers)
    assert.deepEqual(view.messages, [])
    assert.equal(view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect').props.loading, false)
  } finally { view.unmount() }
})

test('selecting an offline server or explicitly connecting still requests a connection', async () => {
  const view = fixture(async (command, args) => command === 'conn.open' ? { profileId: args.profileId, connectionId: 'new-' + args.profileId, state: 'ready', alive: true } : command === 'fs.listLocal' ? { entries: [], home: '' } : command === 'sftp.list' ? { entries: [], more: false } : { tasks: [] })
  try {
    await view.settle()
    view.props.connections = []; await view.settle()
    view.calls.length = 0
    const connect = view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect')
    assert.ok(connect, 'an offline pane needs an explicit connect action')
    connect.props.onClick(); await view.settle()
    assert.equal(view.calls.filter(c => c.command === 'conn.open').length, 1)
    view.calls.length = 0
    view.find(node => node.type === 'Select' && node.props.className === 'pane-source').props.onChange('b')
    await view.settle()
    assert.deepEqual(view.calls.filter(c => c.command === 'conn.open').map(c => c.args.profileId), ['b'])
  } finally { view.unmount() }
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function pane(view, side = 'right') { return view.find(node => node.props?.className === 'sftp-columns').props.children[side === 'left' ? 0 : 1] }
function listing(view, side = 'right') { return view.find(node => node.type === 'List', pane(view, side)) }
function button(view, title, side = 'right') { return view.find(node => node.type === 'Button' && node.props.title === title, pane(view, side)) }
function navigate(view, target, side = 'right') { view.find(node => node.props?.onNavigate, pane(view, side)).props.onNavigate(target) }
function entry(name) { return { name, path: '/' + name, isDir: false, size: 1 } }
function basic(command) { return command === 'fs.listLocal' ? { entries: [], home: '' } : { tasks: [] } }

function pathInput(view, side = 'right') { return view.find(node => node.type === 'Input' && node.props.onPressEnter, pane(view, side)) }
function editPath(view, value, side = 'right') {
  view.find(node => node.props?.title === 'sftp.editPath', pane(view, side)).props.onClick()
  view.render()
  pathInput(view, side).props.onChange({ target: { value } })
  view.render()
}

for (const side of ['left', 'right']) for (const exit of ['blur', 'escape']) {
  test('unsubmitted path draft preserves the ' + side + ' directory on ' + exit, async () => {
    const view = fixture(async (command, args) => command === 'sftp.list' ? { entries: [entry('remote-current')], more: true } : command === 'fs.listLocal' ? { entries: [entry('local-current')], home: 'C:/fixture', more: true } : basic(command))
    try {
      await view.settle()
      const before = Array.from(listing(view, side).props.dataSource, item => item.path)
      const item = listing(view, side).props.renderItem(listing(view, side).props.dataSource[0])
      item.props.onClick(); await view.settle()
      const oldPath = view.find(node => node.props?.onNavigate, pane(view, side)).props.path
      const requestCount = view.calls.filter(call => call.command === 'fs.listLocal' || call.command === 'sftp.list').length
      editPath(view, '/not-submitted', side)
      assert.deepEqual(Array.from(listing(view, side).props.dataSource, item => item.path), before, 'typing a draft must not invalidate loaded entries')
      if (exit === 'blur') pathInput(view, side).props.onBlur()
      else {
        let prevented = false
        assert.equal(typeof pathInput(view, side).props.onKeyDown, 'function')
        pathInput(view, side).props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true } })
        assert.equal(prevented, true)
      }
      await view.settle()
      assert.equal(pathInput(view, side), undefined)
      assert.deepEqual(Array.from(listing(view, side).props.dataSource, item => item.path), before)
      assert.equal(view.find(node => node.props?.onNavigate, pane(view, side)).props.path, oldPath)
      assert.equal(view.calls.filter(call => call.command === 'fs.listLocal' || call.command === 'sftp.list').length, requestCount)
      assert.ok(listing(view, side).props.renderItem(listing(view, side).props.dataSource[0]).props.className.includes('fs-selected'))
      view.find(node => node.props?.title === 'sftp.editPath', pane(view, side)).props.onClick(); view.render()
      assert.equal(pathInput(view, side).props.value, oldPath, 'reopening the editor must reset the abandoned draft')
    } finally { view.unmount() }
  })
}

for (const side of ['left', 'right']) test('Enter commits the ' + side + ' draft once and ignores a later blur', async () => {
  const pending = deferred()
  const view = fixture(async (command, args) => command === 'sftp.list' ? args.path === '/committed' ? pending.promise : { entries: [entry('old')], more: false } : command === 'fs.listLocal' ? args.path === '/committed' ? pending.promise : { entries: [entry('old-local')], home: 'C:/fixture' } : basic(command))
  try {
    await view.settle(); view.calls.length = 0
    editPath(view, '/committed', side)
    const input = pathInput(view, side)
    assert.equal(view.calls.some(call => call.command === 'fs.listLocal' || call.command === 'sftp.list'), false)
    input.props.onPressEnter(); input.props.onBlur(); await view.settle()
    assert.equal(pathInput(view, side), undefined)
    const calls = view.calls.filter(call => call.command === (side === 'left' ? 'fs.listLocal' : 'sftp.list'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args.path, '/committed')
    pending.resolve({ entries: [entry('new-committed')], more: false, home: 'C:/fixture' }); await view.settle()
    assert.deepEqual(Array.from(listing(view, side).props.dataSource, item => item.name), ['new-committed'])
    assert.equal(view.find(node => node.props?.onNavigate, pane(view, side)).props.path, '/committed')
  } finally { pending.resolve({ entries: [], more: false }); view.unmount() }
})




for (const side of ['left', 'right']) test('editing a draft does not discard an in-flight ' + side + ' directory refresh', async () => {
  const pending = deferred()
  let delayed = false
  const view = fixture(async (command, args) => {
    const target = side === 'left' ? 'fs.listLocal' : 'sftp.list'
    if (command === target) return delayed ? pending.promise : { entries: [entry('current')], more: true, home: 'C:/fixture' }
    return command === 'sftp.list' ? { entries: [entry('remote')], more: false } : basic(command)
  })
  try {
    await view.settle()
    const previousPath = view.find(node => node.props?.onNavigate, pane(view, side)).props.path
    delayed = true
    button(view, 'sftp.refresh', side).props.onClick()
    editPath(view, '/not-submitted', side)
    pending.resolve({ entries: [entry('latest-current')], more: true, home: 'C:/fixture' })
    await view.settle()
    assert.deepEqual(Array.from(listing(view, side).props.dataSource, item => item.name), ['latest-current'])
    pathInput(view, side).props.onBlur(); await view.settle()
    assert.equal(view.find(node => node.props?.onNavigate, pane(view, side)).props.path, previousPath)
    assert.deepEqual(Array.from(listing(view, side).props.dataSource, item => item.name), ['latest-current'])
    assert.ok(listing(view, side).props.footer)
  } finally { pending.resolve({ entries: [], more: false }); view.unmount() }
})

for (const change of ['disconnect', 'mode', 'profile', 'path', 'refresh', 'ABA', 'unmount']) {
  test('delayed list success is isolated after ' + change, async () => {
    const pending = deferred()
    let hold = false
    const view = fixture(async command => command === 'sftp.list' ? hold ? pending.promise : { entries: [entry('current')], more: false } : basic(command))
    try {
      await view.settle(); hold = true
      button(view, 'sftp.refresh').props.onClick(); hold = false
      if (change === 'disconnect') { view.props.connections = []; view.render() }
      if (change === 'mode') view.find(node => node.type === 'Segmented', pane(view)).props.onChange('local')
      if (change === 'profile') view.find(node => node.type === 'Select', pane(view)).props.onChange('b')
      if (change === 'path' || change === 'ABA') { navigate(view, '/other'); if (change === 'ABA') navigate(view, '.') }
      if (change === 'refresh') button(view, 'sftp.refresh').props.onClick()
      if (change === 'unmount') view.unmount()
      else await view.settle()
      pending.resolve({ entries: [entry('obsolete')], more: true })
      await view.settle()
      assert.equal(listing(view).props.dataSource.some(item => item.name === 'obsolete'), false, change + ' must discard old entries')
      assert.equal(!!listing(view).props.footer, false, change + ' must discard old pagination')
    } finally { pending.resolve({ entries: [], more: false }); view.unmount() }
  })
}

test('same-path refresh accepts only newest response and suppresses late errors', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0
  const view = fixture(async command => command === 'sftp.list' ? ++calls === 1 ? { entries: [], more: false } : calls === 2 ? old.promise : fresh.promise : basic(command))
  try {
    await view.settle(); button(view, 'sftp.refresh').props.onClick(); button(view, 'sftp.refresh').props.onClick()
    fresh.resolve({ entries: [entry('newest')], more: false }); await view.settle()
    old.reject(new Error('obsolete failure')); await view.settle()
    assert.equal(listing(view).props.dataSource[0].name, 'newest')
    assert.deepEqual(view.messages, [])
  } finally { old.resolve({ entries: [], more: false }); fresh.resolve({ entries: [], more: false }); view.unmount() }
})

test('left navigation does not invalidate right pending directory or usage', async () => {
  const pending = deferred(), usage = deferred()
  const view = fixture(async command => command === 'sftp.list' ? pending.promise : command === 'sftp.du' ? usage.promise : basic(command))
  try {
    await view.settle(); button(view, 'sftp.du').props.onClick()
    navigate(view, '/local-other', 'left'); await view.settle()
    pending.resolve({ entries: [entry('right-only')], more: false }); usage.resolve({ totalBytes: 20, availBytes: 5 }); await view.settle()
    assert.equal(listing(view).props.dataSource[0].name, 'right-only')
    assert.ok(view.find(node => node.props?.className === 'fs-du', pane(view)))
  } finally { pending.resolve({ entries: [], more: false }); usage.resolve({}); view.unmount() }
})

for (const failure of [false, true]) test('late usage ' + (failure ? 'error' : 'result') + ' is discarded on path change', async () => {
  const pending = deferred()
  const view = fixture(async command => command === 'sftp.du' ? pending.promise : command === 'sftp.list' ? { entries: [], more: false } : basic(command))
  try {
    await view.settle(); button(view, 'sftp.du').props.onClick(); navigate(view, '/new-path'); await view.settle()
    if (failure) pending.reject(new Error('obsolete usage'))
    else pending.resolve({ totalBytes: 10, availBytes: 1 })
    await view.settle()
    assert.equal(view.find(node => node.props?.className === 'fs-du', pane(view)), undefined)
  } finally { pending.resolve({}); view.unmount() }
})

test('local list cannot overwrite remote or another local path and resolves actual home', async () => {
  const pending = deferred(); let localCalls = 0
  const view = fixture(async command => command === 'fs.listLocal' ? ++localCalls === 1 ? pending.promise : { entries: [entry('local-current')], home: '/actual-home' } : command === 'sftp.list' ? { entries: [entry('remote-current')], more: false } : { tasks: [] })
  try {
    await view.settle(); view.find(node => node.type === 'Segmented', pane(view, 'left')).props.onChange('remote'); await view.settle()
    view.props.connections = [...view.props.connections, { profileId: 'b', connectionId: 'ready-b', state: 'ready', alive: true }]; await view.settle()
    pending.resolve({ entries: [entry('stale-local')], home: '/old-home' }); await view.settle()
    assert.equal(listing(view, 'left').props.dataSource[0].name, 'remote-current')
    view.calls.length = 0
    view.find(node => node.type === 'Segmented', pane(view, 'left')).props.onChange('local'); await view.settle()
    assert.equal(view.calls.some(call => call.command === 'sftp.list'), false, 'switch back must not issue remote list from previous closure')
    assert.equal(listing(view, 'left').props.dataSource[0].name, 'local-current')
    assert.equal(view.find(node => node.props?.onNavigate, pane(view, 'left')).props.path, '/actual-home')
  } finally { pending.resolve({ entries: [], home: '' }); view.unmount() }
})

test('pagination ignores duplicate clicks and old pages overtaken by a refresh', async () => {
  const page = deferred(); let generation = 0
  const view = fixture(async (command, args) => command === 'sftp.list' ? args.offset ? page.promise : { entries: [entry(++generation === 1 ? 'base' : 'new-base')], more: true } : basic(command))
  try {
    await view.settle(); const more = listing(view).props.footer
    more.props.onClick(); more.props.onClick()
    assert.equal(view.calls.filter(call => call.command === 'sftp.list' && call.args.offset === 500).length, 1)
    button(view, 'sftp.refresh').props.onClick(); await view.settle()
    page.resolve({ entries: [entry('base'), entry('old-page')], more: false }); await view.settle()
    assert.deepEqual(Array.from(listing(view).props.dataSource, item => item.name), ['new-base'])
    listing(view).props.footer.props.onClick(); await view.settle()
    assert.deepEqual(Array.from(listing(view).props.dataSource, item => item.name), ['new-base', 'base', 'old-page'])
    more.props.onClick(); await view.settle()
    assert.equal(view.calls.filter(call => call.command === 'sftp.list' && call.args.offset === 500).length, 2, 'completed page cannot append twice')
  } finally { page.resolve({ entries: [], more: false }); view.unmount() }
})

test('selection, stale row handlers and asynchronous mkdir stay bound to their original source', async () => {
  const view = fixture(async command => command === 'sftp.list' ? { entries: [entry('source-A')], more: false } : basic(command))
  try {
    await view.settle(); const row = listing(view).props.renderItem(listing(view).props.dataSource[0]); row.props.onClick(); await view.settle()
    const remove = button(view, 'sftp.remove'), mkdir = button(view, 'sftp.mkdir').props.onClick()
    const modal = view.modals.at(-1); modal.content.props.onChange({ target: { value: 'folder-A' } })
    view.find(node => node.type === 'Select', pane(view)).props.onChange('b'); await view.settle()
    row.props.onClick(); row.props.onDoubleClick(); await remove.props.onClick(); modal.onOk(); await mkdir; await view.settle()
    assert.equal(view.calls.some(call => ['sftp.remove', 'sftp.removeRecursive', 'sftp.preview', 'sftp.mkdir'].includes(call.command)), false)
    assert.equal(button(view, 'sftp.remove').props.disabled, true)
  } finally { view.unmount() }
})

for (const state of ['cancelled', 'failed', 'needInput']) test('open terminal state ' + state + ' never continues status polling', async () => {
  const view = fixture(async command => command === 'conn.open' ? { connectionId: 'stopped', state, error: 'stopped' } : command === 'conn.status' ? { connections: [] } : basic(command))
  try {
    view.props.connections = []; await view.settle()
    view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect').props.onClick(); await view.settle()
    assert.equal(view.calls.filter(call => call.command === 'conn.status').length, 0, 'terminal conn.open result must end this intent')
    assert.equal(view.find(node => node.type === 'Button' && node.props['aria-label'] === 'conn.connect').props.loading, false)
  } finally { view.unmount() }
})

test('a deleted left profile resolves the new default only on explicit mode switch', async () => {
  const view = fixture(async (command, args) => command === 'conn.open' ? { profileId: args.profileId, connectionId: 'new-' + args.profileId, state: 'ready' } : command === 'sftp.list' ? { entries: [], more: false } : basic(command))
  try {
    await view.settle(); view.find(node => node.type === 'Segmented', pane(view, 'left')).props.onChange('remote'); await view.settle()
    view.find(node => node.type === 'Segmented', pane(view, 'left')).props.onChange('local'); await view.settle()
    view.props.profiles = [view.props.profiles[0], { ...view.props.profiles[1], id: 'c' }]; await view.settle(); view.calls.length = 0
    view.find(node => node.type === 'Segmented', pane(view, 'left')).props.onChange('remote'); await view.settle()
    assert.deepEqual(view.calls.filter(call => call.command === 'conn.open').map(call => call.args.profileId), ['c'])
  } finally { view.unmount() }
})
test('right explicit mode switch prefers an existing ready profile without reopening it', async () => {
  const view = fixture(async command => command === 'sftp.list' ? { entries: [], more: false } : basic(command))
  try {
    await view.settle(); view.find(node => node.type === 'Segmented', pane(view)).props.onChange('local'); await view.settle()
    view.props.profiles = [view.props.profiles[1], { ...view.props.profiles[0], id: 'c' }]; view.props.connections = [{ profileId: 'c', connectionId: 'ready-c', state: 'ready', alive: true }]; await view.settle(); view.calls.length = 0
    view.find(node => node.type === 'Segmented', pane(view)).props.onChange('remote'); await view.settle()
    assert.equal(view.find(node => node.type === 'Select', pane(view)).props.value, 'c')
    assert.equal(view.calls.some(call => call.command === 'conn.open'), false)
    assert.equal(view.calls.filter(call => call.command === 'sftp.list')[0].args.connectionId, 'ready-c')
  } finally { view.unmount() }
})
test('late preview cannot reopen the editor or write its path into a different connection', async () => {
  const pending = deferred()
  const view = fixture(async command => command === 'sftp.preview' ? pending.promise : command === 'sftp.list' ? { entries: [entry('preview-A')], more: false } : basic(command))
  try {
    await view.settle(); listing(view).props.renderItem(listing(view).props.dataSource[0]).props.onDoubleClick()
    view.find(node => node.type === 'Select', pane(view)).props.onChange('b'); await view.settle()
    pending.resolve({ dataBase64: 'old preview' }); await view.settle()
    const modal = view.find(node => node.props?.okText === 'sftp.saveFile'); assert.equal(modal.props.open, false); await modal.props.onOk()
    assert.equal(view.calls.some(call => call.command === 'sftp.writeFile'), false)
  } finally { pending.resolve({ dataBase64: '' }); view.unmount() }
})

for (const change of ['disconnect', 'mode', 'profile', 'path', 'ABA', 'unmount']) test('late list error is silent after ' + change, async () => {
  const pending = deferred(); let hold = false
  const view = fixture(async command => command === 'sftp.list' ? hold ? pending.promise : { entries: [entry('valid')], more: false } : basic(command))
  try {
    await view.settle(); hold = true; button(view, 'sftp.refresh').props.onClick(); hold = false
    if (change === 'disconnect') { view.props.connections = []; view.render() }
    if (change === 'mode') view.find(node => node.type === 'Segmented', pane(view)).props.onChange('local')
    if (change === 'profile') view.find(node => node.type === 'Select', pane(view)).props.onChange('b')
    if (change === 'path' || change === 'ABA') { navigate(view, '/other'); if (change === 'ABA') navigate(view, '') }
    if (change === 'unmount') view.unmount(); else await view.settle()
    pending.reject(new Error('late list failure')); await view.settle(); assert.deepEqual(view.messages, [])
  } finally { pending.resolve({}); view.unmount() }
})
test('pagination retries failed pages and deduplicates paths against the loaded base', async () => {
  let attempt = 0
  const view = fixture(async (command, args) => command === 'sftp.list' ? args.offset ? ++attempt === 1 ? Promise.reject(new Error('page failed')) : { entries: [entry('base'), entry('page')], more: false } : { entries: [entry('base')], more: true } : basic(command))
  try {
    await view.settle(); listing(view).props.footer.props.onClick(); await view.settle()
    assert.equal(view.messages[0].text, 'page failed'); listing(view).props.footer.props.onClick(); await view.settle()
    assert.deepEqual(Array.from(listing(view).props.dataSource, item => item.name), ['base', 'page'])
    assert.equal(!!listing(view).props.footer, false)
  } finally { view.unmount() }
})
test('pending preview save is rejected after directory refresh and connection identity replacement', async () => {
  const view = fixture(async command => command === 'sftp.preview' ? { dataBase64: 'editable' } : command === 'sftp.list' ? { entries: [entry('preview')], more: false } : basic(command))
  try {
    await view.settle(); listing(view).props.renderItem(listing(view).props.dataSource[0]).props.onDoubleClick(); await view.settle()
    const modal = view.find(node => node.props?.okText === 'sftp.saveFile'); assert.equal(modal.props.open, true)
    view.props.connections = [{ profileId: 'a', connectionId: 'replacement-a', state: 'ready', alive: true }]; await view.settle(); await modal.props.onOk()
    assert.equal(view.calls.some(call => call.command === 'sftp.writeFile'), false)
  } finally { view.unmount() }
})

test('old pagination and usage event handlers cannot revive the previous directory', async () => {
  const view = fixture(async command => command === 'sftp.list' ? { entries: [entry('base')], more: true } : basic(command))
  try {
    await view.settle(); const more = listing(view).props.footer, usage = button(view, 'sftp.du')
    navigate(view, '/new'); await view.settle(); view.calls.length = 0
    more.props.onClick(); usage.props.onClick(); await view.settle()
    assert.equal(view.calls.some(call => call.command === 'sftp.list' || call.command === 'sftp.du'), false)
    assert.equal(listing(view).props.dataSource[0].name, 'base')
  } finally { view.unmount() }
})
for (const change of ['refresh', 'ABA']) test('mkdir confirmation is invalid after same-connection ' + change, async () => {
  const view = fixture(async command => command === 'sftp.list' ? { entries: [entry('base')], more: false } : basic(command))
  try {
    await view.settle(); const action = button(view, 'sftp.mkdir').props.onClick(); const modal = view.modals.at(-1)
    modal.content.props.onChange({ target: { value: 'stale-folder' } })
    if (change === 'refresh') button(view, 'sftp.refresh').props.onClick()
    else { navigate(view, '/other'); await view.settle(); navigate(view, '') }
    await view.settle(); modal.onOk(); await action; await view.settle()
    assert.equal(view.calls.some(call => call.command === 'sftp.mkdir'), false)
  } finally { view.unmount() }
})

function previewModal(view) { return view.find(node => node.props?.okText === 'sftp.saveFile') }
function openPreview(view, name) {
  const list = listing(view)
  list.props.renderItem(list.props.dataSource.find(item => item.name === name)).props.onDoubleClick()
}
for (const cancel of [false, true]) test('preview request token accepts only latest same-directory result' + (cancel ? ' and cancel discards it' : ''), async () => {
  const x = deferred(), y = deferred()
  const view = fixture(async (command, args) => command === 'sftp.preview' ? args.path === '/X' ? x.promise : y.promise : command === 'sftp.list' ? { entries: [entry('X'), entry('Y')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X'); openPreview(view, 'Y')
    y.resolve({ dataBase64: 'Y data' }); await view.settle()
    assert.equal(previewModal(view).props.title, 'sftp.preview: /Y')
    if (cancel) { previewModal(view).props.onCancel(); await view.settle() }
    x.resolve({ dataBase64: 'X late data' }); await view.settle()
    assert.equal(previewModal(view).props.open, !cancel, 'obsolete X must never reopen cancelled Y')
    if (!cancel) assert.equal(previewModal(view).props.title, 'sftp.preview: /Y', 'obsolete X must never replace Y')
  } finally { x.resolve({ dataBase64: '' }); y.resolve({ dataBase64: '' }); view.unmount() }
})
test('preview request token cancels a pending response before it opens the editor', async () => {
  const pending = deferred()
  const view = fixture(async command => command === 'sftp.preview' ? pending.promise : command === 'sftp.list' ? { entries: [entry('X')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X'); previewModal(view).props.onCancel(); await view.settle()
    pending.resolve({ dataBase64: 'cancelled data' }); await view.settle()
    assert.equal(previewModal(view).props.open, false, 'cancel must discard an in-flight preview')
  } finally { pending.resolve({ dataBase64: '' }); view.unmount() }
})

for (const failure of [false, true]) test('preview save token ignores old ' + (failure ? 'error' : 'completion') + ' after a new same-directory editor opens', async () => {
  const saved = deferred()
  const view = fixture(async (command, args) => command === 'sftp.preview' ? { dataBase64: args.path } : command === 'sftp.writeFile' ? saved.promise : command === 'sftp.list' ? { entries: [entry('X'), entry('Y')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X'); await view.settle()
    const oldModal = previewModal(view), save = oldModal.props.onOk()
    assert.equal(view.calls.filter(call => call.command === 'sftp.writeFile').length, 1)
    oldModal.props.onCancel(); await view.settle(); openPreview(view, 'Y'); await view.settle()
    assert.equal(previewModal(view).props.title, 'sftp.preview: /Y')
    if (failure) saved.reject(new Error('old X save failed')); else saved.resolve({})
    await save; await view.settle()
    assert.equal(previewModal(view).props.open, true, 'old X completion must not close Y')
    assert.equal(previewModal(view).props.title, 'sftp.preview: /Y')
    assert.deepEqual(view.messages, [], 'obsolete save must not report success or failure')
  } finally { saved.resolve({}); view.unmount() }
})
test('preview save token never replays a cancelled editor write or duplicates an in-flight save', async () => {
  const saved = deferred()
  const view = fixture(async (command, args) => command === 'sftp.preview' ? { dataBase64: args.path } : command === 'sftp.writeFile' ? saved.promise : command === 'sftp.list' ? { entries: [entry('X'), entry('Y')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X'); await view.settle()
    const oldModal = previewModal(view), save = oldModal.props.onOk(), duplicate = oldModal.props.onOk()
    assert.equal(view.calls.filter(call => call.command === 'sftp.writeFile').length, 1, 'same in-flight save cannot issue a second write')
    oldModal.props.onCancel(); await view.settle(); openPreview(view, 'Y'); await view.settle()
    const staleSave = oldModal.props.onOk()
    assert.equal(view.calls.filter(call => call.command === 'sftp.writeFile').length, 1, 'cancelled editor cannot issue another write')
    saved.resolve({}); await Promise.all([save, duplicate, staleSave]); await view.settle()
    assert.equal(previewModal(view).props.open, true)
  } finally { saved.resolve({}); view.unmount() }
})

for (const change of ['cancel', 'refresh', 'unmount']) for (const failure of [false, true]) test('preview save token discards ' + (failure ? 'error' : 'completion') + ' after ' + change, async () => {
  const saved = deferred()
  const view = fixture(async command => command === 'sftp.preview' ? { dataBase64: 'X' } : command === 'sftp.writeFile' ? saved.promise : command === 'sftp.list' ? { entries: [entry('X')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X'); await view.settle()
    const oldModal = previewModal(view), save = oldModal.props.onOk()
    if (change === 'cancel') oldModal.props.onCancel()
    if (change === 'refresh') button(view, 'sftp.refresh').props.onClick()
    if (change === 'unmount') view.unmount(); else await view.settle()
    if (failure) saved.reject(new Error('obsolete save error')); else saved.resolve({})
    await save; await view.settle()
    assert.deepEqual(view.messages, [], 'invalidated save must not publish a late notification')
    assert.equal(view.calls.filter(call => call.command === 'sftp.writeFile').length, 1)
    assert.equal(previewModal(view).props.open, false)
  } finally { saved.resolve({}); view.unmount() }
})
for (const change of ['cancel', 'refresh', 'unmount']) test('preview request token discards late errors after ' + change, async () => {
  const pending = deferred()
  const view = fixture(async command => command === 'sftp.preview' ? pending.promise : command === 'sftp.list' ? { entries: [entry('X')], more: false } : basic(command))
  try {
    await view.settle(); openPreview(view, 'X')
    if (change === 'cancel') previewModal(view).props.onCancel()
    if (change === 'refresh') button(view, 'sftp.refresh').props.onClick()
    if (change === 'unmount') view.unmount(); else await view.settle()
    pending.reject(new Error('obsolete preview error')); await view.settle()
    assert.deepEqual(view.messages, []); assert.equal(previewModal(view).props.open, false)
  } finally { pending.resolve({ dataBase64: '' }); view.unmount() }
})
