const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 关窗入口与重开提示：跑真实 App 源码 + 假 react hook 运行时，
// 断言落在行为上（有传输在跑必须先确认、查不到状态不能扣住窗口），
// 不是断言源码里出现过哪段字符串。
// 挑战续跑（TDD 复现用）：APP_SOURCE_FILE 可指向另一份 App.tsx，
// 用来证明新增的挑战用例在修复前是红的。
function fixture(invoke = async () => ({ tasks: [] }), savedWidth) {
  const hooks = [], effects = [], scheduled = [], calls = [], tCalls = [], messages = [], modals = [], closed = []
  let cursor = 0, tree, changed = false
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
  const output = ts.transpileModule(fs.readFileSync(process.env.APP_SOURCE_FILE || path.join(__dirname, 'App.tsx'), 'utf8'), {
    fileName: 'App.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  // 宿主注入的窗口桥：关窗动作只通过它发生。
  const storage = new Map(savedWidth === undefined ? [] : [['gonavi.ssh.sidebarWidth', savedWidth]])
  const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, gonaviPlugin: { close: () => { closed.push(true); return Promise.resolve() } } }
  const context = {
    module, exports: module.exports, console, window, setTimeout, clearTimeout,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') {
        return new Proxy({
          App: function AntApp() {},
          Modal: Object.assign(function Modal() {}, {
            confirm: config => { modals.push(config); return { destroy() {}, update() {} } },
          }),
          message: Object.fromEntries(['error', 'warning', 'success'].map(type => [
            type,
            (text, duration) => { messages.push({ type, text, duration }) },
          ])),
        }, { get: (target, key) => target[key] ?? String(key) })
      }
      if (name === './bridge') {
        return {
          invokeAs: async (command, args) => { calls.push({ command, args }); return invoke(command, args) },
          describeError: error => error.message || String(error),
        }
      }
      if (name === './i18n') return { t: (key, params) => { tCalls.push({ key, params }); return key } }
      if (name === './usePanelResize') {
        const resizeModule = { exports: {} }
        const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'usePanelResize.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText
        vm.runInNewContext(source, { module: resizeModule, exports: resizeModule.exports, require: () => react })
        return resizeModule.exports
      }
      // base64 只是过桥的壳、shell 引号另有单测：这里断言的是"往终端写了什么命令"。
      if (name === './b64') return { encodeText: text => text, decodeText: text => text }
      if (name === './fsFormat') return { quoteShellArg: path => `'${path}'` }
      // 子面板不参与关窗行为，用类型标记顶替。
      if (name.startsWith('./components/')) return { [name.slice('./components/'.length)]: name.slice('./components/'.length) }
      return {}
    },
  }
  vm.runInNewContext(output, context, { filename: 'App.tsx' })

  function render() {
    for (let rounds = 0; rounds < 10; rounds++) {
      changed = false; cursor = 0
      tree = module.exports.default()
      for (const run of scheduled.splice(0)) run()
      if (!changed) return tree
    }
    throw new Error('fixture render did not converge')
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child == null) continue
        const result = find(predicate, child)
        if (result) return result
      }
      return undefined
    }
    if (predicate(node)) return node
    return node.props?.children === undefined ? undefined : find(predicate, node.props.children)
  }
  async function settle() {
    for (let round = 0; round < 4; round++) {
      await new Promise(resolve => setImmediate(resolve))
      render()
    }
  }
  render()
  return {
    calls, tCalls, messages, modals, closed, render, settle, find, storage,
    // 关窗入口挂在主 Tabs 的 tabBarExtraContent 上，不在 children 里，得从 Tabs 取。
    closeEntry() {
      const tabs = find(node => node.props?.className === 'main-tabs')
      assert.ok(tabs, '主 Tabs 必须渲染')
      const extra = tabs.props.tabBarExtraContent.right
      assert.equal(extra?.type, 'Button', '关窗入口必须挂在顶栏')
      return extra
    },
    // 挑战弹窗没挂 className，按标题定位（i18n 桩返回 key）。
    challengeModal() {
      const modal = find(node => node.props?.title === 'prompt.title')
      assert.ok(modal, '挑战弹窗必须渲染')
      return modal
    },
    // 页签内容挂在 Tabs 的 items 上（不在 children 里）。
    tabContent(key) {
      const tabs = find(node => node.props?.className === 'main-tabs')
      assert.ok(tabs, '主 Tabs 必须渲染')
      const item = (tabs.props.items ?? []).find(entry => entry.key === key)
      assert.ok(item, `tab ${key} must exist`)
      return item.children
    },
    // 终端视图挂在终端页里那层可编辑 Tabs 的 items 上（要先进终端页）。
    terminalView(sessionKey) {
      const inner = find(node => node.props?.type === 'editable-card', this.tabContent('terminals'))
      assert.ok(inner, '终端 Tabs 必须渲染')
      const item = (inner.props.items ?? []).find(entry => entry.key === sessionKey) ?? (inner.props.items ?? [])[0]
      assert.ok(item, '终端页签必须存在')
      return item.children
    },
    connect(profile) {
      const panel = find(node => node.type === 'ProfilePanel')
      assert.ok(panel, '连接面板必须渲染')
      return panel.props.onConnect(profile)
    },
    unmount() { for (const e of effects) e?.cleanup?.() },
  }
}

// 插值参数在 vm 里生成，跨 realm 对象不能直接 deepStrictEqual，先搬回宿主 realm。
function lastParams(view, key) {
  return { ...view.tCalls.filter(call => call.key === key).at(-1).params }
}

// 文件浏览相关的接线：显示开关、跟随开关、命令跳转。子面板在本 harness 里是
// 类型标记，断言的是 App 交给它的 props 与它回调后 App 的动作。
const SETTINGS = { readOnly: false, sudoAllowlist: [], quickCommands: [], historyLimit: 500 }
async function withTree(settings = {}) {
  // 假设置存储：settings.set 之后 settings.get 要读回刚写下去的值，
  // 否则"保存后勾选框的状态"这类断言会被一个永远返回旧值的桩骗过。
  const store = { current: { ...SETTINGS, ...settings } }
  const view = fixture(async (command, args) => {
    if (command === 'conn.open') return { connectionId: 'c1', profileId: 'p1', state: 'ready' }
    if (command === 'terminal.open') return { sessionKey: 'k1' }
    if (command === 'settings.get') return { settings: store.current }
    if (command === 'settings.set') { store.current = args.settings; return { settings: store.current } }
    return {}
  })
  await view.settle()
  await view.connect(PROFILE)
  await view.settle()
  return Object.assign(view, { store })
}
const treeNode = view => view.find(node => node.type === 'FileTreePanel', view.tabContent('terminals'))
const terminalNode = view => view.find(node => node.type === 'TerminalView', view.terminalView())
const saved = view => view.calls.filter(call => call.command === 'settings.set').at(-1)?.args?.settings

test('opening an already connected profile returns to its terminal without creating another session', async () => {
  let connected = false
  const conn = { connectionId: 'c1', profileId: 'p1', state: 'ready', alive: true }
  const view = fixture(async command => {
    if (command === 'conn.open') { connected = true; return conn }
    if (command === 'conn.status') return { connections: connected ? [conn] : [] }
    if (command === 'terminal.open') return { sessionKey: 'k1' }
    return {}
  })
  try {
    await view.settle()
    await view.connect(PROFILE); await view.settle()
    view.find(node => node.props?.className === 'main-tabs').props.onChange('files'); view.render()
    await view.connect(PROFILE); await view.settle()
    assert.equal(view.find(node => node.props?.className === 'main-tabs').props.activeKey, 'terminals')
    assert.equal(view.calls.filter(call => call.command === 'terminal.open').length, 1)
    assert.equal(view.calls.filter(call => call.command === 'conn.open').length, 1)
    assert.equal(view.find(node => node.type === 'ProfilePanel').props.activeProfileId, 'p1')
  } finally { view.unmount() }
})

test('following is only passed to the terminal while the file browser is on screen', async () => {
  // 跟随开关长在文件浏览面板上：面板没显示就没有可跟随的东西，此时还让终端
  // 往远端注钩子，用户只会平白看到远端执行了一串 shell 代码。
  const hidden = await withTree({ cwdFollow: true })
  try {
    assert.equal(treeNode(hidden), undefined)
    assert.equal(terminalNode(hidden).props.followCwd, false, '面板不显示就不该注入')
  } finally { hidden.unmount() }
  const shown = await withTree({ showFileTree: true, cwdFollow: true })
  try {
    assert.ok(treeNode(shown), '面板显示着')
    assert.equal(terminalNode(shown).props.followCwd, true, '这时才跟着终端走')
  } finally { shown.unmount() }
})

test('the file tree stays hidden until the setting turns it on', async () => {
  const hidden = await withTree()
  try {
    assert.equal(treeNode(hidden), undefined, '缺字段（没开过）按不显示处理')
  } finally { hidden.unmount() }
  const shown = await withTree({ showFileTree: true })
  try {
    assert.ok(treeNode(shown), '设置里打开才渲染文件浏览')
    assert.equal(treeNode(shown).props.connectionId, 'c1', '文件浏览跟随活动终端所在连接')
    assert.equal(treeNode(shown).props.follow, false, '跟随默认关闭')
  } finally { shown.unmount() }
})

test('collapsing the tree persists the setting instead of hiding it locally only', async () => {
  const view = await withTree({ showFileTree: true })
  try {
    treeNode(view).props.onCollapse()
    await view.settle()
    assert.equal(saved(view).showFileTree, false, '收起要落盘，下次开窗才不会再冒出来')
  } finally { view.unmount() }
})

test('the follow checkbox persists the terminal directory follow switch', async () => {
  const view = await withTree({ showFileTree: true })
  try {
    assert.equal(treeNode(view).props.follow, false)
    treeNode(view).props.onFollowChange(true)
    await view.settle()
    assert.equal(saved(view).cwdFollow, true)
    assert.equal(treeNode(view).props.follow, true, '保存后重新读到的设置要让勾选框显示为勾上')
  } finally { view.unmount() }
})

test('the download folder picked in the panel is written back through settings', async () => {
  const view = await withTree({ showFileTree: true })
  try {
    assert.equal(treeNode(view).props.downloadDir, '', '没挑过下载目录时是空的')
    treeNode(view).props.onDownloadDirChange('D:\\drops')
    await view.settle()
    assert.equal(saved(view).downloadDir, 'D:\\drops', '挑定的目录要落盘')
    assert.equal(treeNode(view).props.downloadDir, 'D:\\drops', '保存后重新读到的设置要让面板显示新目录')
  } finally { view.unmount() }
})


test('turning the tree back on in settings shows it again after a collapse', async () => {
  const view = await withTree({ showFileTree: true })
  try {
    treeNode(view).props.onWidthChange(380)
    view.render()
    assert.equal(treeNode(view).props.width, 380)
    assert.equal(saved(view), undefined, 'resizing is local layout state, not a settings write')
    treeNode(view).props.onCollapse()
    await view.settle()
    assert.equal(treeNode(view), undefined, '收起后先是不显示')
    view.store.current = { ...view.store.current, showFileTree: true }
    view.find(node => node.type === 'SettingsPanel', view.tabContent('settings')).props.onSaved()
    await view.settle()
    assert.ok(treeNode(view), '设置里重新打开要能再显示，收起不能变成永久隐藏')
    assert.equal(treeNode(view).props.width, 380, 'reopening in the same window retains the resized width')
  } finally { view.unmount() }
})

test('a settings change reaches the file panel without a save button', async () => {
  // 设置面板已经没有保存按钮：它自己落盘，落盘后通知上层重新拉一次设置，
  // 终端页的文件面板要能立刻跟着出现（这正是当初「开了却看不到」的根因）。
  const view = await withTree()
  try {
    const panel = view.find(node => node.type === 'SettingsPanel', view.tabContent('settings'))
    assert.ok(panel, '设置面板必须渲染')
    assert.equal(panel.props.onToggle, undefined, '面板不再靠上层代写，落盘由它自己完成')
    assert.equal(typeof panel.props.onSaved, 'function', 'App 必须接上"落盘后刷新"')
    view.store.current = { ...view.store.current, showFileTree: true }
    panel.props.onSaved()
    await view.settle()
    assert.ok(treeNode(view), '设置落盘后文件面板要出现')
  } finally { view.unmount() }
})

test('the terminal directory moves the tree only while following is on', async () => {
  const following = await withTree({ showFileTree: true, cwdFollow: true })
  try {
    terminalNode(following).props.onCwd('/srv/app')
    await following.settle()
    assert.equal(treeNode(following).props.jump.path, '/srv/app', '跟随打开时终端 cd 要实时跳转')
  } finally { following.unmount() }
  const off = await withTree({ showFileTree: true })
  try {
    terminalNode(off).props.onCwd('/srv/app')
    await off.settle()
    assert.equal(treeNode(off).props.jump, null, '跟随关闭时终端目录不动文件浏览')
  } finally { off.unmount() }
})

test('a saved jump mapping reaches the running terminal without reopening it', async () => {
  const view = await withTree()
  try {
    assert.deepEqual([...terminalNode(view).props.treeCommands], [], '默认没有映射')
    view.store.current = { ...view.store.current, treeCommands: [{ name: 'logs', path: '/var/log' }] }
    view.find(node => node.type === 'SettingsPanel', view.tabContent('settings')).props.onSaved()
    await view.settle()
    const mapped = [...terminalNode(view).props.treeCommands]
    assert.deepEqual(mapped.map(jump => jump.name), ['logs'], '存完设置要把映射推到终端上，不用重开终端')
    assert.equal(mapped[0].path, '/var/log')
  } finally { view.unmount() }
})

test('turning directory following on moves the tree to where the terminal already is', async () => {
  // 面板停在 a、终端在 b：开启跟随的那一刻就该跟到 b，不能干等下一次 cd。
  const view = await withTree({ showFileTree: true })
  try {
    terminalNode(view).props.onCwd('/srv/app')
    await view.settle()
    assert.equal(treeNode(view).props.jump, null, '没开跟随时面板不动')

    view.store.current = { ...view.store.current, cwdFollow: true }
    view.find(node => node.type === 'SettingsPanel', view.tabContent('settings')).props.onSaved()
    await view.settle()
    assert.equal(treeNode(view).props.jump.path, '/srv/app', '开启跟随要立刻跟到终端所在目录')
  } finally { view.unmount() }
})

test('the same directory reported again does not disturb the tree', async () => {
  // OSC7 钩子挂在 PROMPT_COMMAND 上：用户在终端里每敲一条命令都会上报一次。
  // 目录没变就不该动面板——否则回一次车面板重载一次（load 里会清空选中项），
  // 人在终端里干活却一直波及旁边这块面板。
  const view = await withTree({ showFileTree: true, cwdFollow: true })
  try {
    terminalNode(view).props.onCwd('/srv')
    await view.settle()
    const first = treeNode(view).props.jump.seq
    terminalNode(view).props.onCwd('/srv')
    await view.settle()
    assert.equal(treeNode(view).props.jump.seq, first, '目录没变，不该再动面板')
    terminalNode(view).props.onCwd('/srv/app')
    await view.settle()
    assert.ok(treeNode(view).props.jump.seq > first, '目录真变了才跟过去')
  } finally { view.unmount() }
})

test('closing the window with transfers in flight confirms first and closes only after the user agrees', async () => {
  const view = fixture(async command => command === 'transfer.list'
    ? { tasks: [{ id: 't1', state: 'running' }, { id: 't2', state: 'queued' }, { id: 't3', state: 'done' }] }
    : {})
  try {
    await view.settle()
    view.closeEntry().props.onClick()
    await view.settle()
    assert.equal(view.closed.length, 0, '未确认前不得关窗，否则在跑的传输会被默默中断')
    assert.equal(view.modals.length, 1, '有 running/queued 传输时必须先弹确认')
    assert.equal(view.modals[0].content, 'app.closeBody')
    assert.deepEqual(lastParams(view, 'app.closeBody'), { count: 2 }, '确认文案里的数量必须是真正在跑的传输数')
    assert.equal(view.modals[0].cancelText, 'app.closeStay')
    assert.equal(view.modals[0].okText, 'app.closeConfirm')
    view.modals[0].onOk()
    await view.settle()
    assert.equal(view.closed.length, 1, '确认后必须真的关窗')
  } finally { view.unmount() }
})

test('closing the window with nothing in flight closes immediately', async () => {
  const view = fixture(async command => command === 'transfer.list'
    ? { tasks: [{ id: 't1', state: 'done' }, { id: 't2', state: 'failed' }, { id: 't3', state: 'interrupted' }] }
    : {})
  try {
    await view.settle()
    view.closeEntry().props.onClick()
    await view.settle()
    assert.equal(view.modals.length, 0, '没有在跑的传输就别多问一句')
    assert.equal(view.closed.length, 1)
  } finally { view.unmount() }
})

test('a failed transfer query never blocks closing the window', async () => {
  const view = fixture(async command => {
    if (command === 'transfer.list') throw new Error('bridge down')
    return {}
  })
  try {
    await view.settle()
    view.closeEntry().props.onClick()
    await view.settle()
    assert.equal(view.closed.length, 1, '查不到状态时窗口仍要能关，不能被扣住')
    assert.equal(view.modals.length, 0)
  } finally { view.unmount() }
})

test('reopening the window reports how many transfers were interrupted', async () => {
  const view = fixture(async command => command === 'transfer.list'
    ? { tasks: [{ id: 't1', state: 'interrupted' }, { id: 't2', state: 'interrupted' }, { id: 't3', state: 'done' }] }
    : {})
  try {
    await view.settle()
    const notices = view.messages.filter(message => message.text === 'app.interruptedNotice')
    assert.equal(notices.length, 1, '被关窗打断的传输要在重开时提示一次')
    assert.equal(notices[0].type, 'warning')
    assert.equal(notices[0].duration, 8)
    assert.deepEqual(lastParams(view, 'app.interruptedNotice'), { count: 2 })
  } finally { view.unmount() }
})

test('reopening the window stays quiet when no transfer was interrupted', async () => {
  const view = fixture(async command => command === 'transfer.list'
    ? { tasks: [{ id: 't1', state: 'done' }, { id: 't2', state: 'running' }] }
    : {})
  try {
    await view.settle()
    assert.equal(view.messages.some(message => message.text === 'app.interruptedNotice'), false)
  } finally { view.unmount() }
})

// 挑战（二次提问）续跑路径：弹窗的 onOk 与输入框回车都直接调用 submitChallenge，
// 谁都不接管它返回的 promise。这条路径上任何一次 conn.status 失败都会被抛成
// 未处理的 promise 拒绝，启动期错误面板随即盖住整个窗口——与表单校验失败同源。
const CONNECTED = { connectionId: 'c1', profileId: 'p1', state: 'connecting' }
const NEED_INPUT = {
  connections: [{
    connectionId: 'c1', profileId: 'p1', state: 'needInput',
    challenge: { instruction: 'TOTP', stage: 'auth', prompts: ['验证码'] },
  }],
}
const READY = { connections: [{ connectionId: 'c1', profileId: 'p1', state: 'ready', addr: '10.0.0.1' }] }
const PROFILE = { id: 'p1', name: 'host-a' }

// 连上并让挑战进队列，再取弹窗 onOk：第二次渲染后 challenge 才进 submitChallenge
// 的闭包，一渲染就取会拿到 challenge 仍为 null 的旧闭包。
async function answeredChallenge(view) {
  await view.connect(PROFILE)
  await view.settle()
  return view.challengeModal().props.onOk
}

test('a failing status poll while resuming a challenge never escapes the modal handler', async () => {
  let polls = 0
  const view = fixture(async (command, args) => {
    if (command === 'conn.status' && args?.connectionId === 'c1') {
      polls += 1
      if (polls === 1) return NEED_INPUT
      throw { code: 4101, message: '会话已结束' }
    }
    return command === 'conn.open' ? CONNECTED : {}
  })
  try {
    const onOk = await answeredChallenge(view)
    await assert.doesNotReject(onOk(), '续跑轮询失败不能被丢成未处理的 promise 拒绝')
    assert.equal(view.messages.some(m => m.type === 'error' && m.text.includes('会话已结束')), true, '失败原因要提示到界面上')
  } finally { view.unmount() }
})

test('a failing fresh-status call after ready never escapes the modal handler', async () => {
  let polls = 0
  const view = fixture(async (command, args) => {
    if (command === 'conn.status' && args?.connectionId === 'c1') {
      polls += 1
      if (polls === 1) return NEED_INPUT
      if (polls === 2) return READY
      throw { code: 4101, message: '会话已结束' }
    }
    return command === 'conn.open' ? CONNECTED : {}
  })
  try {
    const onOk = await answeredChallenge(view)
    await assert.doesNotReject(onOk(), 'ready 后取状态失败也不能逃逸')
    assert.equal(view.messages.some(m => m.type === 'error' && m.text.includes('会话已结束')), true)
    assert.equal(view.calls.some(call => call.command === 'terminal.open'), false, '状态取不到就不该开终端')
  } finally { view.unmount() }
})

test('an answered challenge still opens the terminal tab', async () => {
  let polls = 0
  const view = fixture(async (command, args) => {
    if (command === 'conn.status' && args?.connectionId === 'c1') {
      polls += 1
      return polls === 1 ? NEED_INPUT : READY
    }
    if (command === 'conn.open') return CONNECTED
    if (command === 'terminal.open') return { sessionKey: 'k1' }
    return {}
  })
  try {
    const onOk = await answeredChallenge(view)
    await onOk()
    assert.equal(view.calls.some(call => call.command === 'terminal.open'), true, '答完挑战要接着开终端')
    assert.equal(view.messages.filter(m => m.type === 'error').length, 0, '正常路径不该报错')
  } finally { view.unmount() }
})

test('a jump command moves the tree when following, and is ignored when it is off', async () => {
  // 终端那侧的 cd 由 TerminalView 在识别到整行的当下就把输入换掉发出去（见那边的
  // 用例）——App 这一层只管面板：跟随时直接跳，不等 OSC7 上报（已经在目标目录时
  // cd 是空操作、cwd 不变，上报根本不会发生）。
  const on = await withTree({ showFileTree: true, cwdFollow: true })
  try {
    on.calls.length = 0
    terminalNode(on).props.onJump('/opt/tomcat')
    await on.settle()
    assert.equal(treeNode(on).props.jump.path, '/opt/tomcat', '跟随时面板要直接到位')
    assert.equal(
      on.calls.some(call => call.command === 'terminal.write'), false,
      'App 不再自己补 cd：那会和远端打印提示符赛跑，屏幕上多印一行',
    )
  } finally { on.unmount() }

  const off = await withTree({ showFileTree: true })
  try {
    off.calls.length = 0
    terminalNode(off).props.onJump('/opt/tomcat')
    await off.settle()
    assert.equal(treeNode(off).props.jump, null, '没开跟随时面板留在原地')
  } finally { off.unmount() }
})


test('connection sidebar restores width, saves completed resizing and retains it across collapse', () => {
  const view = fixture(undefined, '320')
  try {
    const sidebar = () => view.find(n => n.props?.id === 'connection-sidebar')
    const toggle = () => view.find(n => n.props?.className === 'main-tabs').props.tabBarExtraContent.left
    assert.equal(sidebar().props.style.width, 320)
    const pane = { parentElement: { clientWidth: 1200 }, style: { width: '320px' }, getBoundingClientRect() { return { width: parseFloat(this.style.width) } } }
    const handle = { parentElement: pane, setAttribute() {} }
    view.find(n => n.props?.['aria-label'] === 'conn.resize').props.onKeyDown({ key: 'ArrowRight', currentTarget: handle, preventDefault() {} })
    view.render()
    assert.equal(sidebar().props.style.width, 336)
    assert.equal(view.storage.get('gonavi.ssh.sidebarWidth'), '336')
    toggle().props.onClick(); view.render()
    assert.equal(sidebar().props.hidden, true)
    assert.equal(toggle().props['aria-expanded'], false)
    toggle().props.onClick(); view.render()
    assert.equal(sidebar().props.hidden, false)
    assert.equal(sidebar().props.style.width, 336)
    assert.equal(view.calls.some(c => c.command === 'settings.set'), false)
    view.find(n => n.props?.className === 'main-tabs').props.onChange('files')
    view.render()
    view.find(n => n.props?.['aria-label'] === 'conn.resize').props.onKeyDown({ key: 'End', currentTarget: handle, preventDefault() {} })
    view.render()
    assert.equal(sidebar().props.style.width, 600, 'dual file panes reserve enough room for both toolbars')
  } finally { view.unmount() }
  for (const saved of [undefined, '', 'NaN', '-5', '150', 'Infinity']) {
    const fallback = fixture(undefined, saved)
    assert.equal(fallback.find(n => n.props?.id === 'connection-sidebar').props.style.width, 240)
    fallback.unmount()
  }
})
