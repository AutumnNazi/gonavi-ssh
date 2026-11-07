const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 预测模块按真实实现加载（接线用例要跑真的判定逻辑，不是替身）。
function loadTs(file) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: file })
  return module.exports
}

// 本地预测回显的接线：按键要立刻画上屏、远端回显不能再画一遍、分歧后按远端
// 字节自愈；广播与设置里关掉时一律不本地绘制（那时各会话回显交错，无法抵消）。
function fixture(options = {}) {
  const states = [], refs = [], effects = [], scheduled = [], messages = []
  let cursor = 0, tree
  const writes = []   // term.write 的内容：本地绘制与远端输出都在这里
  const queued = []   // 交给宿主桥的输入请求
  const sinks = []    // 读中枢的订阅者
  const terminals = []
  const timers = new Map()  // 注入钩子有延迟，用例手动触发，不真等 800ms
  let timerSeq = 0

  const react = {
    useState(initial) {
      const i = cursor++
      states[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [states[i].value, next => { states[i].value = typeof next === 'function' ? next(states[i].value) : next }]
    },
    useRef(initial) {
      const i = cursor++
      refs[i] ??= { current: initial }
      return refs[i]
    },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  class Terminal {
    constructor(options) { this.options = options ?? {}; this.dataHandlers = []; terminals.push(this) }
    loadAddon() {} open() {} focus() {} fit() {} dispose() {} attachCustomKeyEventHandler() {}
    write(text) { writes.push(text) }
    getSelection() { return '' }
    onData(handler) { this.dataHandlers.push(handler); return { dispose() {} } }
    onResize() { return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
  }
  const jsx = (type, props) => ({ type, props })
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'TerminalView.tsx'), 'utf8'), {
    fileName: 'TerminalView.tsx', compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  const antd = new Proxy({
    message: Object.fromEntries(['error', 'warning', 'success'].map(type => [type, text => messages.push({ type, text })])),
  }, { get: (target, key) => target[key] ?? String(key) })
  vm.runInNewContext(output, {
    module, exports: module.exports, console, AbortController,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    document: { activeElement: null, body: {}, createElement: () => ({ getContext: () => null }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@xterm/xterm') return { Terminal }
      if (name === '@xterm/addon-fit') return { FitAddon: class { fit() {} } }
      if (name === 'antd') return antd
      if (name === '@ant-design/icons') return new Proxy({}, { get: (_t, key) => String(key) })
      if (name === '../terminalEcho') return loadTs(path.join(__dirname, '..', 'terminalEcho.ts'))
      if (name === '../terminalRedact') return loadTs(path.join(__dirname, '..', 'terminalRedact.ts'))
      if (name === '../terminalCommandJump') return loadTs(path.join(__dirname, '..', 'terminalCommandJump.ts'))
      // 跳转要把目录包成 shell 参数再发：按真实实现加载，别让桩把引号行为也替掉。
      if (name === '../fsFormat') return loadTs(path.join(__dirname, '..', 'fsFormat.ts'))
      if (name === '../terminalTheme') return { terminalOptions: () => ({}) }
      if (name === '../hostPrefs') return { hostPrefs: { locale: 'zh-CN', theme: 'light' }, subscribeHostPrefs: () => () => {} }
      if (name === '../i18n') return { t: key => key }
      if (name === '../b64') return {
        encodeText: text => Buffer.from(text, 'utf8').toString('base64'),
        createStreamDecoder: () => (dataBase64) => Buffer.from(dataBase64, 'base64').toString('utf8'),
      }
      if (name === '../terminalWriteQueue') return {
        createTerminalWriteQueue: (write, warn) => ({
          // refuseWrites 模拟容量拒绝（512 项背压）：入队落空但输入仍处于可用状态。
          enqueue: item => { if (options.refuseWrites) return false; queued.push(item); return true },
          hasWork: () => queued.length > 0,
          stop: () => {},
        }),
      }
      if (name === '../terminalReadHub') return { subscribeTerminalRead: (_key, sink) => { sinks.push(sink); return () => {} } }
      if (name === '../bridge') return {
        invokeAs: async () => ({}),
        describeError: error => error.message || String(error),
      }
      return {}
    },
  }, { filename: 'TerminalView.tsx' })

  const props = {
    tab: { tabKey: 't1', connectionId: 'c1', sessionKey: 's1' },
    // 广播目标：同连接下的另一个会话（广播要求 allTabs 里真有兄弟标签）。
    allTabs: [{ tabKey: 't2', connectionId: 'c1', sessionKey: 's2' }],
    onCwd: () => {},
    onJump: () => {},
    followCwd: false,
    // 设置项由上层（App）作为 props 推下来：改完设置不用重开终端。
    quickCommands: options.quickCommands ?? [],
    localEcho: options.localEcho,
    treeCommands: options.treeCommands ?? [],
  }
  function render() {
    cursor = 0
    tree = module.exports.TerminalView(props)
    for (const effect of scheduled.splice(0)) effect()
    return tree
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found } return undefined }
    if (predicate(node)) return node
    return node.props?.children === undefined ? undefined : find(predicate, node.props.children)
  }
  // 真实 DOM 由宿主提供，这里给终端容器一个可查询的替身。
  function mountHost() {
    const host = { getClientRects: () => [{}], contains: () => false, focus() {} }
    const node = find(n => n.props?.className === 'terminal-xterm')
    assert.ok(node?.props?.ref, '终端容器必须带 ref')
    node.props.ref.current = host
    return host
  }
  render()
  const host = mountHost()
  render()
  return {
    props, render, find, writes, queued, sinks, terminals, messages, host,
    // 一次按键（xterm 的 onData 语义：回车是 \r、退格是 \x7f）。
    type: data => { for (const handler of terminals.at(-1).dataHandlers) handler(data) },
    remote: base64 => { for (const sink of sinks) sink.onData(base64) },
    // 远端输出的 base64（读中枢给的是原始分片）。
    remoteText: text => { for (const sink of sinks) sink.onData(Buffer.from(text, 'utf8').toString('base64')) },
    // 立刻执行在等的延时任务（注入钩子用了 800ms 延迟避开 shell 启动窗口）。
    // 注入的第二笔是在第一笔之后才排期的，所以默认一直排空；只跑前几轮时传
    // rounds，用例可以卡在两步之间插一手。
    flushTimers(rounds = Infinity) {
      for (let n = 0; n < rounds && timers.size; n++) {
        const pending = [...timers.values()]
        timers.clear()
        for (const t of pending) t.fn()
      }
    },
    unmount() { for (const effect of effects) effect?.cleanup?.() },
    setBroadcast(value) {
      const node = find(n => n.type === 'Switch')
      assert.ok(node, '广播开关必须渲染')
      node.props.onChange(value)
      render()
    },
  }
}

test('a typed key is drawn locally right away and still sent to the remote', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  assert.deepEqual(view.writes, ['l'], '按键要立刻上屏，不等远端回显')
  assert.equal(view.queued.length, 1, '按键仍然要发给远端')
  assert.equal(view.queued[0].command, 'terminal.write')
  assert.equal(Buffer.from(view.queued[0].args.dataBase64, 'base64').toString('utf8'), 'l')
  view.unmount()
})

test('the remote echo of a predicted key is not drawn a second time', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  view.type('s')
  assert.deepEqual(view.writes, ['l', 's'])
  view.remoteText('ls')
  assert.deepEqual(view.writes, ['l', 's'], '远端把这两个字符回显回来时不能再写一遍，否则就是双显')
  view.remoteText('\r\n')
  assert.deepEqual(view.writes, ['l', 's', '\r\n'], '回显之外的内容（换行、命令输出）照常绘制')
  view.unmount()
})

test('a diverging remote output is drawn from the point of divergence', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  view.type('s')
  view.remoteText('lX')
  assert.deepEqual(view.writes, ['l', 's', 'X'], '首字符已画过，只补画分歧之后的部分')
  view.unmount()
})

test('control keys and pasted text are sent but never drawn locally', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  assert.deepEqual(view.writes, ['l'], '可打印字符才本地绘制')
  view.type('\r')
  view.type('\x7f')
  view.type('\x1b[200~abc\x1b[201~')
  assert.deepEqual(view.writes, ['l'], '回车/退格/粘贴序列交给远端回显')
  assert.equal(view.queued.length, 4, '这些输入同样要发出去')
  view.unmount()
})

test('broadcasting never draws locally', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  assert.deepEqual(view.writes, ['l'], '单会话时按预测绘制')
  view.setBroadcast(true)
  view.type('l')
  assert.deepEqual(view.writes, ['l'], '广播时同一个按键进多个会话，本地绘制无从抵消')
  assert.equal(view.queued[1].command, 'terminal.writeMulti', '多目标走 writeMulti')
  view.setBroadcast(false)
  view.type('l')
  assert.deepEqual(view.writes, ['l', 'l'], '关掉广播后恢复本地绘制')
  view.unmount()
})

test('input refused by a full queue is not drawn locally', async () => {
  const view = fixture({ localEcho: true, refuseWrites: true })
  view.type('l')
  assert.deepEqual(view.writes, [], '入队被拒时远端不会回显，本地画就是错字')
  assert.equal(view.queued.length, 0)
  view.unmount()
})

test('a key that never reached the remote is not drawn locally', async () => {
  const view = fixture({ localEcho: true })
  view.sinks.at(-1).onEnd(false, undefined)
  view.type('l')
  assert.deepEqual(view.writes, [], '没送出去的输入远端不会回显，画上屏就是错字')
  assert.equal(view.queued.length, 0, '会话已结束，输入不再入队')
  assert.deepEqual(view.messages.filter(m => m.type === 'warning').map(m => m.text), ['term.inputClosed'])
  view.unmount()
})

test('the settings switch decides whether local drawing happens', async () => {
  const on = fixture({ localEcho: true })
  on.type('l')
  assert.deepEqual(on.writes, ['l'], '打开后按键先本地画上屏')
  on.unmount()
  const off = fixture({ localEcho: false })
  off.type('l')
  assert.deepEqual(off.writes, [], '设置里关掉后不再本地绘制')
  assert.equal(off.queued.length, 1, '输入照常送出')
  off.unmount()
  // 老版本设置文件里没有这个字段：默认关——用户没开过的功能不该自己亮起来。
  const legacy = fixture()
  legacy.type('l')
  assert.deepEqual(legacy.writes, [], '缺字段按关闭处理')
  legacy.unmount()
})

test('a configured jump command moves the tree when it is submitted', async () => {
  const view = fixture({ treeCommands: [{ name: 'logs', path: '/var/log' }] })
  const jumps = []
  view.props.onJump = path => jumps.push(path)
  view.render()
  for (const key of '#logs') view.type(key)
  assert.deepEqual(jumps, [], '还没回车就不能跳')
  view.type('\r')
  assert.deepEqual(jumps, ['/var/log'], '整行命中映射才跳转')
  // 命中后不能把回车原样发出去、事后再补一条 cd：两次写入之间的缝隙会让补上去的
  // cd 和远端打印提示符赛跑，跑赢了屏幕上就多印一行没头没尾的 cd。回车这一笔直接
  // 换成「Ctrl-U 清掉已输入的那几个字符 + 执行 cd」。
  assert.equal(sentTexts(view).at(-1), "\x15cd '/var/log'\r", '回车那一笔要换成清行 + cd')
  assert.equal(view.queued.length, 6, '前五个字符照常发过去，第六笔是替换后的 cd')
  // 不带前缀的同名命令是用户真打在终端里的东西，不能被映射吃掉。
  for (const key of 'logs') view.type(key)
  view.type('\r')
  assert.deepEqual(jumps, ['/var/log'], '没前缀就不认，哪怕名字对得上')
  view.type('l')
  view.type('\r')
  assert.deepEqual(jumps, ['/var/log'], '没配的命令不受影响')
  view.unmount()
})

test('a jump mapping configured after the session started takes effect without reopening the terminal', async () => {
  const view = fixture()
  const jumps = []
  view.props.onJump = path => jumps.push(path)
  for (const key of '#logs') view.type(key)
  view.type('\r')
  assert.deepEqual(jumps, [], '还没配映射，先确认不跳')
  // 用户在设置里配上映射并保存：上层把新设置推下来，终端不该要求重开。
  view.props.treeCommands = [{ name: 'logs', path: '/var/log' }]
  view.render()
  for (const key of '#logs') view.type(key)
  view.type('\r')
  assert.deepEqual(jumps, ['/var/log'], '改完设置当场生效，不用新开终端')
  view.unmount()
})

test('turning the local echo switch off applies to the running terminal', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  assert.deepEqual(view.writes, ['l'], '开着就先画上屏')
  view.props.localEcho = false
  view.render()
  view.type('s')
  assert.deepEqual(view.writes, ['l'], '关掉开关当场停画，不用重开终端')
  view.unmount()
})

test('a jump command typed with a stray argument does not fire', async () => {
  const view = fixture({ treeCommands: [{ name: 'logs', path: '/var/log' }] })
  const jumps = []
  view.props.onJump = path => jumps.push(path)
  view.render()
  for (const key of '#logs /tmp') view.type(key)
  view.type('\r')
  assert.deepEqual(jumps, [], '只有整行精确匹配才算这条映射')
  view.unmount()
})

test('a half-typed jump command does not carry into a rebuilt session', async () => {
  const view = fixture({ treeCommands: [{ name: 'logs', path: '/var/log' }] })
  for (const key of '#log') view.type(key)
  const jumps = []
  view.props.onJump = path => jumps.push(path)
  view.unmount()
  view.props.tab = { tabKey: 't2', connectionId: 'c1', sessionKey: 's2' }
  view.render()
  view.type('s')
  view.type('\r')
  assert.deepEqual(jumps, [], '新会话不该把上一会话的半截命令拼成命中')
  view.unmount()
})

// 每一步真正写出去的字节。
const sentTexts = view => view.queued
  .map(item => Buffer.from(item.args.dataBase64, 'base64').toString('utf8'))

test('directory follow hands the hook to a silent remote read instead of typing it at the prompt', async () => {
  const view = fixture()
  view.props.followCwd = true
  view.render()
  view.flushTimers()
  const sent = sentTexts(view)
  assert.equal(sent.length, 2, '两步注入：先让远端静默读一行，再把钩子交给它')
  assert.match(sent[0], /^read -rs /, '第一步用 read -s：读这一行期间远端不回显')
  assert.ok(sent[1].includes('PROMPT_COMMAND'), '第二步才是 OSC7 上报钩子')
  assert.ok(sent.every(text => text.endsWith('\r')), '两步都要回车提交')
  // 第二步的函数名必须真能被第一步的 case 认出来，否则 eval 被挡掉、钩子悄悄装不上。
  const guard = sent[0].match(/in (\w+)\*/)[1]
  assert.ok(sent[1].startsWith(guard), `注入的钩子要以 ${guard} 开头，白名单才认`)
  // 第一步那行是当着用户敲的，会留在远端命令历史里。钩子里要顺手把它删掉，
  // 否则用户按 ↑ 会翻到一条自己没敲过的命令，共享账号的人同样看得见。
  assert.ok(/history -d/.test(sent[1]), 'bash 下要把那行从历史里删掉')
  assert.ok(/fc -d/.test(sent[1]), 'zsh 用 fc -d 删同样的东西')
  // 第一步那行短，远端按原样回显，逐字节吃干净，只留换行。
  view.remoteText(sent[0].replace(/\r$/, '') + '\r\n')
  assert.deepEqual(view.writes, ['\r\n'], '提示符另起一行，屏幕上没有多余代码')
  // 第二步是 read -s 读走的：内核根本不回显它，钩子跑完提示符照旧。
  view.remoteText('bash-5.1$ ls\r\nfile.txt\r\n')
  assert.deepEqual(view.writes, ['\r\n', 'bash-5.1$ ls\r\nfile.txt\r\n'], '钩子之后远端输出一切照旧')
  view.unmount()
})

test('real output is never eaten when the reader line gets no echo at all', async () => {
  // 要吃的只有第一步那行。远端万一没回显它（远端 echo 早被关掉之类），
  // 后面第一条真实输出不能被当成回显吞掉。
  const view = fixture()
  view.props.followCwd = true
  view.render()
  view.flushTimers()
  view.remoteText('bash-5.1$ ls\r\n')
  assert.deepEqual(view.writes, ['bash-5.1$ ls\r\n'], '真实输出一个字都不能少')
  view.unmount()
})

test('typing before the injection starts leaves the remote shell alone', async () => {
  const view = fixture()
  view.props.followCwd = true
  view.render()
  view.type('l')
  view.flushTimers()
  assert.deepEqual(sentTexts(view), ['l'], '用户已经在敲命令，就不再往他的行里塞东西')
  view.unmount()
})

test('typing caught between the two steps releases the read without running that text', async () => {
  const view = fixture()
  view.props.followCwd = true
  view.render()
  view.flushTimers(1)      // 只跑第一步：read 已经发出去了
  view.type('l')           // 这两步之间用户抢先打了字
  view.flushTimers()
  const sent = sentTexts(view)
  // 钩子不送了（会拼进用户正在敲的命令），但 read 那行已经进了远端历史，
  // 得补一条只做清理的命令替它收尾——否则用户按 ↑ 会翻到一条自己没敲过的命令。
  const last = sent.at(-1)
  assert.ok(last.startsWith('__g7'), `收尾命令要以 __g7 开头，reader 的 case 才认它：${last}`)
  assert.ok(last.includes('history -d'), '收尾命令要删掉 reader 那条历史')
  assert.equal(sent.some(text => text.includes('PROMPT_COMMAND')), false, '不送钩子，免得拼进用户的命令')
  // read 把用户那半截命令读走后交给 case 挡掉：钩子命令里没有 eval 任意输入的口子。
  assert.match(sent[0], /case "\$\w+" in \w+\*\)eval "\$\w+";;esac/)
  view.unmount()
})

test('a session that ended during injection stops writing', async () => {
  const view = fixture()
  view.props.followCwd = true
  view.render()
  // 定时器还没触发会话就没了：三步一步都不该发出去，更不该把远端留在关回显的状态。
  view.sinks.at(-1).onEnd(false, undefined)
  view.flushTimers()
  assert.equal(view.queued.length, 0, '会话已经没了就别再往远端写')
  view.unmount()
})

test('the reader line stays hidden whichever way the pty echoes the carriage return', async () => {
  // ICRNL 会把写进去的 \r 变成 \n 或 \r\n 再回显，三种形态都要能对上。
  for (const ending of ['\n', '\r\n', '\r']) {
    const view = fixture()
    view.props.followCwd = true
    view.render()
    view.flushTimers()
    const reader = sentTexts(view)[0]
    view.remoteText(reader.replace(/\r$/, '') + ending)
    assert.deepEqual(view.writes, [ending], `回显以 ${JSON.stringify(ending)} 结尾时那行 read 仍要被吃掉`)
    view.unmount()
  }
})

test('the reader line stays hidden when its echo arrives split across chunks', async () => {
  const view = fixture()
  view.props.followCwd = true
  view.render()
  view.flushTimers()
  const reader = sentTexts(view)[0].replace(/\r$/, '')
  view.remoteText(reader.slice(0, 12))
  assert.deepEqual(view.writes, [], '远端还没回显完就先攒着，别急着画')
  view.remoteText(reader.slice(12))
  assert.deepEqual(view.writes, [], '整行对上了，仍然什么都没画出')
  view.remoteText('\r\n')
  assert.deepEqual(view.writes, ['\r\n'], '命令正文吃掉，只留远端补的换行')
  view.unmount()
})

test('directory follow off never touches the remote shell', async () => {
  const view = fixture()
  view.render()
  view.flushTimers()
  assert.equal(view.queued.length, 0, '开关关着就不该往远端写任何东西')
  view.unmount()
})

test('a new session starts with an empty pending buffer', async () => {
  const view = fixture({ localEcho: true })
  view.type('l')
  assert.deepEqual(view.writes, ['l'])
  view.unmount()
  view.props.tab = { tabKey: 't2', connectionId: 'c1', sessionKey: 's2' }
  view.render()
  // 新会话没有未确认预测：远端回显原样绘制（不能因为旧缓冲而抵消掉）。
  view.remoteText('l')
  assert.deepEqual(view.writes, ['l', 'l'], '重建终端后旧预测必须作废')
  view.unmount()
})
