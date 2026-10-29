const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function loadTs(file, globals = {}) {
  const source = readFileSync(file, 'utf8')
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, AbortController, setTimeout, clearTimeout, ...globals }, { filename: file })
  return module.exports
}

// Replay the production queue from HEAD, not a copy of its algorithm.
function legacyQueue(write, warn, globals = {}) {
  const source = execFileSync('git', ['show', '8b19576:frontend/src/components/TerminalView.tsx'], { encoding: 'utf8' })
  const ast = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === 'TerminalView')
  const declarations = component.body.statements.filter(s => ts.isVariableStatement(s) &&
    s.declarationList.declarations.some(d => ['enqueueWrite', 'pumpWrites'].includes(d.name.getText(ast))))
  assert.equal(declarations.length, 2)
  const output = ts.transpileModule(declarations.map(s => s.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021 },
  }).outputText
  const pendingWrites = { current: [] }
  const stoppedRef = { current: false }
  const context = {
    pendingWrites, stoppedRef, pumping: { current: false }, inputWarned: { current: false },
    sessionKey: 'session', targets: () => [], encodeText: text => text,
    invokeAs: (_command, args) => write(args.dataBase64), message: { warning: warn }, t: key => key,
    setTimeout, clearTimeout, ...globals,
  }
  return vm.runInNewContext(output + '\n({ enqueue: text => { enqueueWrite(text); return true }, hasWork: () => pendingWrites.current.length > 0, stop: () => { stoppedRef.current = true; pendingWrites.current = [] } })', context)
}

function queue(write, warn = () => {}, globals = {}) {
  const file = path.join(__dirname, 'terminalWriteQueue.ts')
  if (process.env.TEST_LEGACY_QUEUE === '1' || !existsSync(file)) return legacyQueue(write, warn, globals)
  return loadTs(file, globals).createTerminalWriteQueue(write, warn)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('delayed first write plus 513 enqueues preserves every accepted input exactly once', async () => {
  const first = deferred()
  const writes = []
  let warnings = 0
  const input = queue(async text => {
    writes.push(text)
    if (writes.length === 1) await first.promise
  }, () => warnings++)
  const accepted = [], rejected = []
  for (let i = 0; i < 514; i++) {
    const text = String(i)
    ;(input.enqueue(text) ? accepted : rejected).push(text)
  }
  assert.equal(input.hasWork(), true)
  first.resolve()
  await tick()
  assert.equal(writes.length, accepted.length, 'accepted input must not be spliced or shifted before sending')
  assert.deepEqual(writes, accepted)
  assert.equal(new Set(writes).size, accepted.length)
  assert.equal(rejected.length, 1)
  assert.equal(warnings, rejected.length, 'each refused input must be visible')
  assert.equal(input.hasWork(), false)
})


function clock() {
  const scheduled = []
  return {
    scheduled,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false }
      scheduled.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
    async next() {
      const timer = scheduled.find(timer => !timer.cleared)
      assert.ok(timer, 'expected a retry timer')
      timer.cleared = true
      timer.fn()
      await tick()
      return timer.delay
    },
  }
}

test('too_many_requests retries only the same in-flight item before the next input', async () => {
  const time = clock()
  const attempts = [], sent = []
  let warnings = 0
  const input = queue(async item => {
    attempts.push(item)
    if (attempts.length <= 2) throw { code: 'too_many_requests' }
    sent.push(item)
  }, () => warnings++, time)
  input.enqueue('first')
  input.enqueue('second')
  await tick()
  assert.deepEqual(attempts, ['first'])
  assert.equal(input.hasWork(), true)
  assert.equal(await time.next(), 100)
  assert.deepEqual(attempts, ['first', 'first'])
  assert.equal(await time.next(), 200)
  assert.deepEqual(attempts, ['first', 'first', 'first', 'second'])
  assert.deepEqual(sent, ['first', 'second'])
  assert.equal(warnings, 0)
  assert.equal(input.hasWork(), false)
})

test('ambiguous errors including busy/revoked and numeric 429 are never replayed and always visible', async () => {
  for (const code of ['window_busy_or_revoked', 429, 'timeout', 'unknown_response', undefined]) {
    const time = clock()
    const attempts = []
    let warnings = 0
    const input = queue(async item => { attempts.push(item); throw { code } }, () => warnings++, time)
    input.enqueue('command\r')
    input.enqueue('next\r')
    await tick()
    assert.deepEqual(attempts, ['command\r', 'next\r'], 'unknown outcomes must not block or replay accepted input')
    assert.equal(warnings, 2, 'each unknown outcome needs feedback')
    assert.equal(time.scheduled.length, 0, 'unknown outcomes must not schedule retries')
    assert.equal(input.hasWork(), false)
  }
})

test('stop aborts a pending write and rejects further input without sending queued items', async () => {
  const first = deferred()
  const attempts = []
  let signal, warnings = 0
  const input = queue(async (item, currentSignal) => {
    signal = currentSignal
    attempts.push(item)
    await first.promise
  }, () => warnings++)
  input.enqueue('first')
  input.enqueue('second')
  input.stop()
  assert.equal(input.hasWork(), false)
  assert.equal(input.enqueue('after-stop'), false)
  assert.ok(signal, 'in-flight bridge call needs a cancellation signal')
  assert.equal(signal.aborted, true)
  first.reject({ code: 'too_many_requests' })
  await tick()
  assert.deepEqual(attempts, ['first'])
  assert.equal(warnings, 1, 'new refused input is visible; cancelled late result is ignored')
})

test('stop clears busy retry timers and never sends the next item', async () => {
  const time = clock()
  const attempts = []
  const input = queue(async item => { attempts.push(item); throw { code: 'too_many_requests' } }, () => {}, time)
  input.enqueue('first')
  input.enqueue('second')
  await tick()
  assert.equal(time.scheduled.length, 1)
  input.stop()
  await tick()
  assert.equal(time.scheduled.filter(timer => !timer.cleared).length, 0, 'stop must release pending backoff')
  assert.deepEqual(attempts, ['first'])
  assert.equal(input.hasWork(), false)
})

test('session-ended error stops the queue with visible feedback', async () => {
  const attempts = []
  let warnings = 0
  const input = queue(async item => { attempts.push(item); throw { code: 4101 } }, () => warnings++)
  input.enqueue('first')
  input.enqueue('second')
  await tick()
  assert.deepEqual(attempts, ['first'])
  assert.equal(input.hasWork(), false)
  assert.equal(warnings, 1)
  assert.equal(input.enqueue('after-close'), false)
  assert.equal(warnings, 2)
})

test('retry exhaustion is bounded and reports unsent input instead of silently clearing it', async () => {
  const time = clock()
  const attempts = []
  let warnings = 0
  const input = queue(async item => { attempts.push(item); throw { code: 'too_many_requests' } }, () => warnings++, time)
  input.enqueue('first')
  input.enqueue('second')
  await tick()
  for (let retry = 1; retry <= 40; retry++) await time.next()
  assert.equal(attempts.length, 41)
  assert.ok(attempts.every(item => item === 'first'))
  assert.equal(warnings, 1)
  assert.equal(input.hasWork(), false)
  assert.equal(time.scheduled.filter(timer => !timer.cleared).length, 0)
  assert.equal(input.enqueue('after-exhaustion'), false)
  assert.equal(warnings, 2)
})

test('busy overflow preserves the in-flight request identity and every accepted queued byte', async () => {
  const time = clock()
  const first = deferred()
  const attempts = [], sent = [], accepted = [], rejected = []
  let warnings = 0
  const input = queue(async item => {
    attempts.push(item)
    if (attempts.length === 1) await first.promise
    sent.push(item)
  }, () => warnings++, time)
  const request = { command: 'terminal.writeMulti', sessionKeys: ['a', 'b'], data: 'first\r' }
  assert.equal(input.enqueue(request), true)
  accepted.push(request)
  for (let i = 0; i < 513; i++) {
    const item = { data: String(i) }
    ;(input.enqueue(item) ? accepted : rejected).push(item)
  }
  first.reject({ code: 'too_many_requests' })
  await tick()
  assert.equal(attempts.length, 1)
  await time.next()
  assert.equal(attempts[0], attempts[1], 'retry must use the identical request and broadcast targets')
  assert.deepEqual(sent, accepted)
  assert.equal(rejected.length, 1)
  assert.equal(warnings, 1)
})

test('unknown first outcome after overflow cannot shift any unsent item', async () => {
  const first = deferred()
  const attempted = [], accepted = []
  let rejected = 0, warnings = 0
  const input = queue(async item => { attempted.push(item); if (attempted.length === 1) await first.promise }, () => warnings++)
  for (let i = 0; i < 514; i++) {
    if (input.enqueue(String(i))) accepted.push(String(i))
    else rejected++
  }
  first.reject({ code: 'timeout' })
  await tick()
  assert.deepEqual(attempted, accepted)
  assert.equal(rejected, 1)
  assert.equal(warnings, 2, 'capacity refusal and unknown outcome both need feedback')
})

function pollLoop(globals) {
  const source = readFileSync(path.join(__dirname, 'components/TerminalView.tsx'), 'utf8')
  const ast = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let poll
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'pollLoop') poll = node
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(poll, 'production polling loop is present')
  const output = ts.transpileModule(poll.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText
  const context = {
    stopped: false, RETRY_MAX: 8, RETRY_BASE_MS: 500, RETRY_CAP_MS: 5000,
    setStatus: () => {}, setDetail: () => {}, describeError: String, t: key => key,
    osc7Re: /never-match/, onCwdRef: { current: () => {} }, ...globals,
  }
  const run = vm.runInNewContext(output + '\npollLoop', context)
  return { run, stop() { context.stopped = true; globals.writeQueue.stop() } }
}

test('exactly eight silent reads give the local input retry a slot before reading again', async () => {
  const time = clock()
  const reads = [], sent = [], views = [], running = []
  let activeReads = 0, warnings = 0
  const invokeAs = async (command, args) => {
    if (command === 'terminal.read') {
      assert.equal(args.waitMillis, 20000)
      const result = deferred()
      reads.push({ result, sessionKey: args.sessionKey })
      activeReads++
      try { return await result.promise } finally { activeReads-- }
    }
    if (activeReads >= 8) throw { code: 'too_many_requests' }
    sent.push(args.data)
  }
  for (let i = 0; i < 8; i++) {
    const writeQueue = queue(item => invokeAs('terminal.write', { data: item }), () => warnings++, time)
    const view = pollLoop({
      ...time, sessionKey: String(i), writeQueue, invokeAs,
      decodeChunk: () => '', term: { write: () => {} },
    })
    views.push({ ...view, writeQueue })
    running.push(view.run())
  }
  assert.equal(activeReads, 8)
  views[0].writeQueue.enqueue('你好\r')
  await tick()
  assert.equal(sent.length, 0)
  reads[0].result.resolve({ dataBase64: '', eof: false })
  await tick()
  assert.equal(activeReads, 7)
  assert.equal(await time.next(), 100, 'first busy backoff remains below the 1500ms read yield')
  assert.deepEqual(sent, ['你好\r'])
  assert.equal(await time.next(), 50, 'read yield checks local pending/in-flight work every 50ms')
  assert.equal(activeReads, 8)
  assert.equal(reads.length, 9)
  assert.equal(warnings, 0)
  for (const view of views) view.stop()
  for (const read of reads) read.result.resolve({ dataBase64: '', eof: false })
  await Promise.all(running)
})

test('in-flight write alone keeps read yielding bounded at 1500ms', async () => {
  const time = clock()
  const writes = deferred(), reads = deferred()
  let readCount = 0, now = 0
  const input = queue(() => writes.promise)
  input.enqueue('first')
  const view = pollLoop({
    ...time, Date: { now: () => now }, sessionKey: 'session', writeQueue: input,
    invokeAs: async () => { readCount++; return reads.promise },
    decodeChunk: () => '', term: { write: () => {} },
  })
  const running = view.run()
  assert.equal(readCount, 0, 'in-flight item must participate in the read yield')
  for (let step = 0; step < 30; step++) {
    now += 50
    assert.equal(await time.next(), 50)
  }
  assert.equal(readCount, 1, 'read must resume at the existing 1500ms limit even if write has not resolved')
  view.stop()
  writes.resolve()
  reads.resolve({ dataBase64: '', eof: false })
  await running
})

test('poll EOF and exhausted read retries stop writes before reporting terminal state', async () => {
  for (const exhausted of [false, true]) {
    const time = clock()
    const input = queue(async () => {})
    let count = 0, state
    const view = pollLoop({
      ...time, sessionKey: 'session', writeQueue: input,
      invokeAs: async () => {
        count++
        if (exhausted) throw new Error('read failed')
        return { dataBase64: '', eof: true, hasExit: false }
      },
      decodeChunk: () => '', term: { write: () => {} },
      setStatus: value => { state = value; assert.equal(input.enqueue('after-stop'), false) },
    })
    const running = view.run()
    await tick()
    if (exhausted) for (let retry = 0; retry < 8; retry++) await time.next()
    await running
    assert.equal(count, exhausted ? 9 : 1)
    assert.equal(state, exhausted ? 'error' : 'closed')
  }
})

function terminalView(write, clipboard = { writeText: async () => {} }, initialPrefs) {
  const time = clock()
  const hooks = [], effects = [], pending = [], terminals = [], warnings = [], notices = [], reads = [], observers = []
  let cursor = 0, now = 0, hostVisible = true, rendered
  const body = {}
  const window = new EventTarget()
  window.gonaviHostPrefs = initialPrefs
  const document = { body, activeElement: body, createElement: () => ({ style: {} }) }
  const host = { getClientRects: () => hostVisible ? [{}] : [], contains: element => !!element?.insideTerminal }
  const react = {
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value } },
    useState(value) {
      const index = cursor++
      hooks[index] ??= { current: value }
      return [hooks[index].current, next => { hooks[index].current = next }]
    },
    useEffect(run, deps) {
      const index = cursor++
      const prior = effects[index]
      if (!prior || deps.some((value, i) => value !== prior.deps[i])) pending.push(() => {
        prior?.cleanup?.()
        effects[index] = { deps, cleanup: run() }
      })
    },
  }
  class Terminal {
    constructor(options) { this.options = options; this.selection = ''; this.bufferText = ''; this.focusCount = 0; terminals.push(this) }
    loadAddon() {}
    open() {}
    focus() { this.focusCount++; document.activeElement = this.element ??= { insideTerminal: true } }
    write(text) { this.bufferText += text }
    onData(input) { this.input = input; return { dispose() {} } }
    onResize() { return { dispose() {} } }
    getSelection() { return this.selection }
    onSelectionChange(listener) { this.selectionChange = listener; return { dispose: () => { this.selectionDisposed = true } } }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler }
    dispose() { this.disposed = true }
  }
  class FitAddon { fit() {} }
  class ResizeObserver { constructor(callback) { this.callback = callback; observers.push(this) }; observe() {}; disconnect() { this.disconnected = true } }
  function jsx(type, props) {
    if (props.ref) props.ref.current = host
    return { type, props }
  }
  const b64 = loadTs(path.join(__dirname, 'b64.ts'), { TextEncoder, TextDecoder, atob, btoa })
  const createTerminalWriteQueue = loadTs(path.join(__dirname, 'terminalWriteQueue.ts'), time).createTerminalWriteQueue
  const invokeAs = async (command, args, options) => {
    if (command === 'terminal.read') {
      const result = deferred()
      reads.push(result)
      return result.promise
    }
    if (command === 'settings.get') return { settings: { quickCommands: [], cwdFollow: false } }
    return write(command, args, options)
  }
  const hostPrefs = loadTs(path.join(__dirname, 'hostPrefs.ts'), { window, navigator: { language: 'en-US' }, document })
  const terminalTheme = existsSync(path.join(__dirname, 'terminalTheme.ts')) ? loadTs(path.join(__dirname, 'terminalTheme.ts'), { document }) : {}
  const exports = loadTs(path.join(__dirname, 'components/TerminalView.tsx'), {
    ...time, Date: { now: () => now }, Terminal, FitAddon, ResizeObserver, navigator: { clipboard }, document,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return { message: { warning: text => warnings.push({ text, at: now }), error: text => { warnings.push({ text, at: now }); notices.push({ type: 'error', text }) }, success: text => notices.push({ type: 'success', text }) } }
      if (name === '@xterm/xterm') return { Terminal }
      if (name === '@xterm/addon-fit') return { FitAddon }
      if (name === '../terminalWriteQueue') return { createTerminalWriteQueue }
      if (name === '../bridge') return { invokeAs, describeError: String }
      if (name === '../b64') return b64
      if (name === '../i18n') return { t: key => key }
      if (name === '../hostPrefs') return hostPrefs
      if (name === '../terminalTheme') return terminalTheme
      return {}
    },
  })
  function render(sessionKey = 'session') {
    cursor = 0
    rendered = exports.TerminalView({ tab: { sessionKey, connectionId: 'connection', tabKey: 'tab' }, allTabs: [], onCwd() {} })
    for (const run of pending.splice(0)) run()
    return terminals.at(-1).input
  }
  return {
    warnings, notices, time, terminals, render, observers, document, hostPrefs,
    get tree() { return rendered },
    preferences(value) { window.gonaviHostPrefs = value; window.dispatchEvent(new Event('gonavi:host-preferences')) },
    setVisible(value) { hostVisible = value; observers.at(-1).callback() },
    setNow(value) { now = value },
    closeSession() { reads.at(-1).resolve({ dataBase64: '', eof: true, hasExit: false }) },
    async unmount() {
      for (const effect of effects) effect?.cleanup?.()
      for (const result of reads) result.resolve({ dataBase64: '', eof: false })
      await tick()
    },
  }
}

test('selected Ctrl+C copies instead of sending SIGINT, while unselected Ctrl+C remains terminal input', async () => {
  const sent = [], copied = []
  const view = terminalView(async (_command, args) => sent.push(args.dataBase64), { writeText: async text => copied.push(text) })
  const input = view.render()
  const term = view.terminals[0]
  const key = { type: 'keydown', key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() {} }
  try {
    term.selection = 'selected 中文'
    const allowed = term.keyHandler?.(key) ?? true
    if (allowed) input('')
    await tick()
    assert.deepEqual(sent, [], 'selected copy must not enter the terminal write queue')
    assert.deepEqual(copied, ['selected 中文'])
    term.selection = ''
    assert.equal(term.keyHandler(key), true, 'unselected Ctrl+C must remain SIGINT')
    input('')
    await tick()
    assert.deepEqual(sent, ['Aw=='])
  } finally { await view.unmount() }
})

test('Ctrl+Shift+C never sends a control byte and denied copy shows feedback without losing the selection', async () => {
  const sent = []
  const view = terminalView(async (_command, args) => sent.push(args), { writeText: async () => { throw new Error('denied') } })
  view.render()
  const term = view.terminals[0]
  const key = { type: 'keydown', key: 'C', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, preventDefault() {} }
  try {
    assert.equal(term.keyHandler(key), false, 'an empty selection still consumes copy shortcut')
    term.selection = 'retained selection'
    assert.equal(term.keyHandler(key), false)
    assert.equal(term.keyHandler({ ...key, type: 'keyup' }), false)
    await tick()
    assert.equal(term.selection, 'retained selection')
    assert.deepEqual(sent, [])
    assert.deepEqual(view.warnings.map(x => x.text), ['term.copyFailed'])
    assert.equal(term.focusCount, 2)
  } finally { await view.unmount() }
  assert.equal(term.selectionDisposed, true)
  assert.equal(view.observers[0].disconnected, true)
})



function copySelected(view) {
  const term = view.terminals.at(-1)
  term.selection = 'clipboard selected text'
  term.keyHandler({ type: 'keydown', key: 'c', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() {} })
}

function pasteButton(tree) {
  if (!tree || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) return tree.map(pasteButton).find(Boolean)
  if (tree.type === 'button' && tree.props?.['aria-label'] === 'form.paste') return tree
  return pasteButton(tree.props?.children)
}

for (const outcome of ['resolve', 'reject']) {
  for (const lifecycle of ['unmount', 'replace', 'hide']) {
    test('delayed copy ' + outcome + ' ignores a ' + lifecycle + ' source terminal', async () => {
      const completion = deferred()
      const view = terminalView(async () => {}, { writeText: () => completion.promise })
      view.render('source')
      const source = view.terminals[0]
      copySelected(view)
      if (lifecycle === 'unmount') await view.unmount()
      else if (lifecycle === 'replace') view.render('replacement')
      else view.setVisible(false)
      const focusBefore = view.terminals.map(term => term.focusCount)
      if (outcome === 'resolve') completion.resolve()
      else completion.reject(new Error('late clipboard failure'))
      await tick()
      assert.deepEqual(view.terminals.map(term => term.focusCount), focusBefore, 'late copy cannot refocus any terminal')
      assert.deepEqual(view.notices, [], 'late copy cannot notify for an inactive view')
      assert.equal(source.disposed, lifecycle === 'hide' ? undefined : true)
      if (lifecycle !== 'unmount') await view.unmount()
    })
  }
  test('delayed copy ' + outcome + ' respects focus moved to another input', async () => {
    const completion = deferred()
    const view = terminalView(async () => {}, { writeText: () => completion.promise })
    view.render()
    const term = view.terminals[0]
    copySelected(view)
    const outsideInput = { tagName: 'INPUT' }
    view.document.activeElement = outsideInput
    const focusBefore = term.focusCount
    if (outcome === 'resolve') completion.resolve()
    else completion.reject(new Error('clipboard failed'))
    await tick()
    assert.equal(view.document.activeElement, outsideInput)
    assert.equal(term.focusCount, focusBefore, 'copy must not steal another input focus')
    assert.deepEqual(view.notices, [{ type: outcome === 'resolve' ? 'success' : 'error', text: outcome === 'resolve' ? 'term.copied' : 'term.copyFailed' }])
    await view.unmount()
  })
}

for (const lifecycle of ['unmount', 'replace', 'hide']) {
  test('delayed paste never sends clipboard text after ' + lifecycle, async () => {
    const completion = deferred(), sent = []
    const view = terminalView(async (command, args) => sent.push({ command, args }), { readText: () => completion.promise })
    view.render('source')
    const button = pasteButton(view.tree)
    assert.ok(button)
    const pending = button.props.onClick({ currentTarget: view.document.activeElement })
    if (lifecycle === 'unmount') await view.unmount()
    else if (lifecycle === 'replace') view.render('replacement')
    else view.setVisible(false)
    const focusBefore = view.terminals.map(term => term.focusCount)
    completion.resolve('must not reach a replacement shell\r')
    await pending; await tick()
    assert.deepEqual(sent, [], 'old paste may not write to a new or inactive session')
    assert.deepEqual(view.terminals.map(term => term.focusCount), focusBefore)
    assert.deepEqual(view.notices, [])
    if (lifecycle !== 'unmount') await view.unmount()
  })
}

test('delayed paste respects another input while targeting only its original session', async () => {
  const completion = deferred(), sent = []
  const view = terminalView(async (command, args) => sent.push({ command, args }), { readText: () => completion.promise })
  view.render('source')
  const term = view.terminals[0], pending = pasteButton(view.tree).props.onClick({ currentTarget: view.document.activeElement })
  const outsideInput = { tagName: 'INPUT' }
  view.document.activeElement = outsideInput
  const focusBefore = term.focusCount
  completion.resolve('paste text')
  await pending; await tick()
  assert.equal(view.document.activeElement, outsideInput)
  assert.equal(term.focusCount, focusBefore)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].args.sessionKey, 'source')
  assert.equal(new TextDecoder().decode(Buffer.from(sent[0].args.dataBase64, 'base64')), 'paste text')
  await view.unmount()
})



for (const outcome of ['resolve', 'reject']) {
  test('clipboard action buttons restore focus only while their own action retains it: ' + outcome, async () => {
    const copy = deferred(), paste = deferred(), sent = []
    const view = terminalView(async (_command, args) => sent.push(args), { writeText: () => copy.promise, readText: () => paste.promise })
    view.render('original')
    const term = view.terminals[0]
    const nodes = []
    const visit = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children) }
    visit(view.tree)
    term.selection = 'selected'
    const action = { tagName: 'BUTTON' }
    view.document.activeElement = action
    nodes.find(node => node.type === 'button' && node.props['aria-label'] === 'term.copy').props.onClick({ currentTarget: action })
    if (outcome === 'resolve') copy.resolve()
    else copy.reject(new Error('denied'))
    await tick()
    assert.equal(term.focusCount, 2)
    assert.equal(view.document.activeElement, term.element)
    view.document.activeElement = action
    const pending = pasteButton(view.tree).props.onClick({ currentTarget: action })
    if (outcome === 'resolve') paste.resolve('normal paste')
    else paste.reject(new Error('denied'))
    await pending; await tick()
    assert.equal(term.focusCount, 3)
    assert.equal(view.document.activeElement, term.element)
    assert.equal(sent.length, outcome === 'resolve' ? 1 : 0)
    assert.deepEqual(view.notices.map(n => n.text), outcome === 'resolve' ? ['term.copied'] : ['term.copyFailed', 'term.pasteFailed'])
    await view.unmount()
  })
}

for (const lifecycle of ['unmount', 'replace', 'hide']) {
  test('delayed paste rejection is silent after ' + lifecycle, async () => {
      const completion = deferred()
      const view = terminalView(async () => {}, { readText: () => completion.promise })
      view.render('source')
      const pending = pasteButton(view.tree).props.onClick({ currentTarget: view.document.activeElement })
      if (lifecycle === 'unmount') await view.unmount()
      else if (lifecycle === 'replace') view.render('replacement')
      else view.setVisible(false)
      const before = view.terminals.map(term => term.focusCount)
      completion.reject(new Error('late read denial'))
      await pending; await tick()
      assert.deepEqual(view.notices, [])
      assert.deepEqual(view.terminals.map(term => term.focusCount), before)
      if (lifecycle !== 'unmount') await view.unmount()
  })
}

test('only hidden-to-visible terminal transitions restore focus, keeping the same selection and instance', async () => {
  const view = terminalView(async () => {})
  view.render()
  const term = view.terminals[0]
  try {
    term.selection = 'keep selection'
    view.setVisible(true)
    assert.equal(term.focusCount, 1, 'ordinary resizing must not steal focus from toolbar controls')
    view.setVisible(false)
    assert.equal(term.focusCount, 1)
    view.setVisible(true)
    assert.equal(term.focusCount, 2, 'visible terminal must be ready for keyboard input')
    assert.equal(term.selection, 'keep selection')
    assert.equal(view.terminals.length, 1)
    view.setVisible(false)
    view.document.activeElement = { tagName: 'INPUT' }
    view.setVisible(true)
    assert.equal(term.focusCount, 2, 'an unrelated input must keep focus when a terminal becomes visible')
  } finally { await view.unmount() }
})

test('new terminal copy and scope messages exist in all six locale catalogs', () => {
  const source = readFileSync(path.join(__dirname, 'i18n.ts'), 'utf8')
  const ast = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true)
  const dictionaries = ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .filter(d => ['zhCN', 'zhTW', 'en', 'ja', 'de', 'ru'].includes(d.name.getText(ast)))
  assert.equal(dictionaries.length, 6)
  const newKeys = ['term.copy', 'term.broadcastScope', 'term.selectionHelp', 'term.copied', 'term.copyFailed', 'term.pasteFailed']
  for (const dict of dictionaries) {
    const properties = dict.initializer.properties
    const keys = properties.map(p => p.name.text)
    assert.equal(new Set(keys).size, keys.length, 'catalog must not contain duplicate keys')
    for (const key of newKeys) {
      const property = properties.find(p => p.name.text === key)
      assert.ok(property?.initializer.text?.trim(), dict.name.getText(ast) + ' lacks ' + key)
    }
  }
})

test('UI warnings throttle 87 capacity refusals from 600 inputs while preserving 513 accepted items', async () => {
  const first = deferred()
  const sent = [], accepted = []
  let rejected = 0
  const view = terminalView(async (_command, args) => {
    const text = new TextDecoder().decode(Buffer.from(args.dataBase64, 'base64'))
    sent.push(text)
    if (sent.length === 1) await first.promise
  })
  const input = view.render()
  try {
    for (let i = 0; i < 600; i++) {
      if (input(String(i))) accepted.push(String(i))
      else rejected++
    }
    assert.equal(rejected, 87)
    assert.equal(accepted.length, 513)
    first.resolve()
    await tick()
    assert.deepEqual(sent, accepted)
    assert.deepEqual(view.warnings, [{ text: 'term.inputDropped', at: 0 }], 'the real message.warning chain must emit once immediately, not 87 times')
  } finally { first.resolve(); await view.unmount() }
})

test('UI unknown failures are throttled without replay and restore warnings at 1500ms', async () => {
  const attempts = []
  const view = terminalView(async (_command, args) => { attempts.push(args.dataBase64); throw { code: 'timeout' } })
  const input = view.render()
  try {
    for (let i = 0; i < 100; i++) assert.equal(input(String(i)), true)
    await tick()
    assert.equal(attempts.length, 100, 'unknown input outcomes are attempted exactly once')
    assert.equal(view.warnings.length, 1)
    view.setNow(1499)
    input('before-boundary')
    await tick()
    assert.equal(view.warnings.length, 1)
    view.setNow(1500)
    input('at-boundary')
    await tick()
    assert.equal(view.warnings.length, 2)
    assert.deepEqual(view.warnings.map(warning => warning.at), [0, 1500])
    assert.equal(attempts.length, 102)
    assert.equal(view.time.scheduled.length, 0, 'warning throttling needs no timer or retry')
  } finally { await view.unmount() }
})

test('UI warning interval is shared by missing queue and stopped input across rerenders and sessions', async () => {
  const view = terminalView(async () => { throw { code: 'timeout' } })
  const firstInput = view.render()
  try {
    firstInput('unknown')
    await tick()
    assert.deepEqual(view.warnings.map(warning => warning.at), [0])
    view.setNow(1000)
    const secondInput = view.render('second')
    secondInput('unknown-after-switch')
    await tick()
    assert.equal(view.warnings.length, 1, 'switching session in the same view cannot bypass the throttle')
    view.render('second')
    secondInput('unknown-after-render')
    await tick()
    assert.equal(view.warnings.length, 1, 'ordinary rerender cannot reset the throttle')
    view.render('')
    view.setNow(1499)
    assert.equal(secondInput('missing-queue'), false)
    assert.equal(view.warnings.length, 1)
    view.setNow(1500)
    assert.equal(secondInput('missing-queue-at-boundary'), false)
    assert.deepEqual(view.warnings.map(warning => warning.at), [0, 1500])
    const stoppedInput = view.render('third')
    view.closeSession()
    await tick()
    for (let i = 0; i < 100; i++) assert.equal(stoppedInput('after-close'), false)
    assert.equal(view.warnings.length, 2, 'stopped queue warnings use the same interval as missing queue')
    view.setNow(3500)
    assert.equal(stoppedInput('after-two-seconds'), false)
    assert.deepEqual(view.warnings.map(warning => warning.at), [0, 1500, 3500])
    assert.equal(view.time.scheduled.length, 0)
  } finally { await view.unmount() }
  assert.ok(view.terminals.every(terminal => terminal.disposed))
  assert.equal(view.time.scheduled.length, 0, 'session switch and unmount leave no warning timers')
})

test('UI warning throttles are per view and ignore late unknown outcomes after unmount', async () => {
  const late = deferred()
  const old = terminalView(async () => late.promise)
  const input = old.render()
  input('in-flight')
  await old.unmount()
  late.reject({ code: 'timeout' })
  await tick()
  assert.equal(old.warnings.length, 0, 'cancelled late outcome must not notify a disposed view')
  assert.equal(old.time.scheduled.length, 0)
  const fresh = terminalView(async () => { throw { code: 'timeout' } })
  try {
    fresh.setNow(1000)
    fresh.render()('first-on-new-view')
    await tick()
    assert.deepEqual(fresh.warnings, [{ text: 'term.inputDropped', at: 1000 }], 'a new view immediately displays its own first warning')
  } finally { await fresh.unmount() }
})

test('stream UTF-8 survives every chunk boundary for Chinese and emoji output', () => {
  const b64 = loadTs(path.join(__dirname, 'b64.ts'), { TextEncoder, TextDecoder, atob, btoa })
  const text = '终端中文😀\r\n'
  const bytes = new TextEncoder().encode(text)
  for (let boundary = 1; boundary < bytes.length; boundary++) {
    const decode = b64.createStreamDecoder()
    const chunks = [bytes.subarray(0, boundary), bytes.subarray(boundary)]
    assert.equal(chunks.map(chunk => decode(b64.bytesToBase64(chunk))).join(''), text)
  }
})


test('host preset palette is consumed at first mount and hot changes preserve the production input queue and terminal', async () => {
  const first = deferred(), sent = []
  const view = terminalView(async (_command, args) => {
    sent.push(new TextDecoder().decode(Buffer.from(args.dataBase64, 'base64')))
    if (sent.length === 1) await first.promise
  }, undefined, { locale: 'en-US', theme: 'light', palette: { code: '#fff8ed', text: '#30251a', accent: '#a16024' } })
  const input = view.render()
  const term = view.terminals[0]
  try {
    assert.equal(term.options.theme.background, '#fff8ed', 'first-open preset must replace the fixed white background')
    term.write('retained buffer 中文')
    term.selection = 'retained selection'
    input('first'); input('queued')
    view.preferences({ locale: 'ja-JP', theme: 'light', palette: { code: '#eef8f4', text: '#213d30', accent: '#267657' } })
    view.render()
    assert.equal(term.options.theme.background, '#eef8f4', 'same-mode preset changes must update the live instance')
    assert.equal(view.hostPrefs.hostPrefs.locale, 'ja-JP')
    assert.equal(view.terminals.length, 1)
    assert.equal(term.disposed, undefined)
    assert.equal(term.bufferText, 'retained buffer 中文')
    assert.equal(term.selection, 'retained selection')
    assert.equal(term.focusCount, 1)
    first.resolve(); await tick()
    assert.deepEqual(sent, ['first', 'queued'])
  } finally { first.resolve(); await view.unmount() }
})


test('terminal preference listener unmounts without late theme mutation and font changes keep selection', async () => {
  const view = terminalView(async () => {})
  view.render()
  const term = view.terminals[0]
  term.selection = 'retain font selection'
  term.write('unchanged buffer')
  view.preferences({ locale: 'en-US', theme: 'dark', appearance: { monoFontSize: 18, monoFontFamily: 'Consolas, monospace' } })
  assert.equal(term.options.fontSize, 18)
  assert.equal(term.options.fontFamily, 'Consolas, monospace')
  assert.equal(term.selection, 'retain font selection')
  assert.equal(term.bufferText, 'unchanged buffer')
  assert.equal(view.terminals.length, 1)
  const theme = term.options.theme
  await view.unmount()
  view.preferences({ locale: 'en-US', theme: 'light', palette: { code: '#fff8ed' } })
  assert.equal(term.options.theme, theme)
  assert.equal(term.disposed, true)
})


test('terminal instructions occupy only copy and broadcast tooltips, with readable alpha selection', async () => {
  const view = terminalView(async () => {}, undefined, { locale: 'en-US', theme: 'dark', palette: { code: '#1b1d21', accentSoft: 'rgba(121, 166, 147, 0.16)' } })
  view.render()
  try {
    const nodes = []
    function visit(node) {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      nodes.push(node)
      visit(node.props?.children)
    }
    visit(view.tree)
    assert.equal(nodes.filter(node => node.props?.className === 'terminal-hints').length, 0)
    assert.equal(nodes.filter(node => node.props?.title === 'term.selectionHelp').length, 1)
    assert.equal(nodes.filter(node => node.props?.title === 'term.broadcastScope').length, 1)
    assert.equal(view.terminals[0].options.theme.selectionForeground, '#ffffff')
  } finally { await view.unmount() }
})
