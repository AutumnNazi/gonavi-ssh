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
function fixture(invoke = async () => ({ tasks: [] })) {
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
  const window = { gonaviPlugin: { close: () => { closed.push(true); return Promise.resolve() } } }
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
    calls, tCalls, messages, modals, closed, render, settle, find,
    // 关窗入口挂在主 Tabs 的 tabBarExtraContent 上，不在 children 里，得从 Tabs 取。
    closeEntry() {
      const tabs = find(node => node.props?.className === 'main-tabs')
      assert.ok(tabs, '主 Tabs 必须渲染')
      const extra = tabs.props.tabBarExtraContent
      assert.equal(extra?.type, 'Button', '关窗入口必须挂在顶栏')
      return extra
    },
    // 挑战弹窗没挂 className，按标题定位（i18n 桩返回 key）。
    challengeModal() {
      const modal = find(node => node.props?.title === 'prompt.title')
      assert.ok(modal, '挑战弹窗必须渲染')
      return modal
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
