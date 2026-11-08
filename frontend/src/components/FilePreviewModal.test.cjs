const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 预览弹窗：拉取 → 编辑 → 写回远端。
//
// 这里断言的重点是竞态：迟到的响应、过期的保存都不能落到"当前打开的这个文件"上。
// 错了的后果不是界面抖动，而是用户看着 A 的内容把 B 覆盖掉。
function fixture(invoke = async () => ({})) {
  const hooks = [], effects = [], scheduled = [], calls = [], messages = []
  let cursor = 0, tree, changed = false
  const react = {
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, next => {
        const value = typeof next === 'function' ? next(hooks[i].value) : next
        if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; changed = true }
      }]
    },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const jsx = (type, props) => ({ type, props })
  // Modal 与 TextArea 用字符串 type：harness 只造元素对象、不渲染组件，
  // 用例按 type 找节点就行，不必真造一个函数出来。
  const antd = new Proxy({
    Input: { TextArea: 'TextArea' },
    Modal: 'Modal',
    message: Object.fromEntries(['error', 'warning', 'success'].map(type => [
      type,
      text => messages.push({ type, text }),
    ])),
  }, { get: (target, key) => target[key] ?? String(key) })
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'FilePreviewModal.tsx'), 'utf8'), {
    fileName: 'FilePreviewModal.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module, exports: module.exports, console,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === 'antd') return antd
      if (name === '../bridge') return {
        invokeAs: async (command, args) => { calls.push({ command, args }); return invoke(command, args) },
        describeError: error => error.message || String(error),
      }
      // base64 只是过桥的壳：这里断言的是路径与竞态，不是编解码。
      if (name === '../b64') return { decodeText: text => text, encodeText: text => text }
      if (name === '../i18n') return { t: key => key }
      return {}
    },
    setTimeout, clearTimeout,
  }, { filename: 'FilePreviewModal.tsx' })

  // onClose 要像真实父组件那样把 target 置空——否则 open 永远为真，
  // "失败就关窗"这类断言会变成永真式，测了个寂寞。
  const props = {
    target: null,
    onClose: () => { calls.push({ command: 'onClose' }); props.target = null },
  }
  function render() {
    for (let rounds = 0; rounds < 10; rounds++) {
      changed = false; cursor = 0
      tree = module.exports.FilePreviewModal(props)
      for (const run of scheduled.splice(0)) run()
      if (!changed) return tree
    }
    throw new Error('fixture render did not converge')
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) { if (child == null) continue; const hit = find(predicate, child); if (hit) return hit }
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
    props, render, settle, find, calls, messages,
    open: target => { props.target = target; return settle() },
    modal: () => find(node => node.type === 'Modal'),
    textarea: () => find(node => node.type === 'TextArea'),
    writes: () => calls.filter(call => call.command === 'sftp.writeFile'),
    closed: () => calls.filter(call => call.command === 'onClose').length,
  }
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const at = (path, name) => ({ connectionId: 'c1', path, name })

test('a late response for a previously opened file never lands on the current one', async () => {
  const first = deferred(), second = deferred()
  const view = fixture(async (command, args) =>
    command === 'sftp.preview' ? (args.path === '/A' ? first.promise : second.promise) : {})
  try {
    void view.open(at('/A', 'A'))
    void view.open(at('/B', 'B'))
    second.resolve({ dataBase64: 'B content' })
    await view.settle()
    first.resolve({ dataBase64: 'A late content' })
    await view.settle()
    assert.equal(view.modal().props.title, 'sftp.preview: /B', '迟到的 A 不能把标题改回去')
    assert.equal(view.textarea().props.value, 'B content', '迟到的 A 内容不能覆盖 B')
  } finally { first.resolve({ dataBase64: '' }) }
})

test('a failed fetch closes the editor instead of leaving an empty one', async () => {
  const view = fixture(async command => {
    if (command === 'sftp.preview') throw new Error('read failed')
    return {}
  })
  await view.open(at('/A', 'A'))
  assert.equal(view.modal().props.open, false, '拉取失败就关掉，不能留个空编辑器让用户往远端写空文件')
  assert.equal(view.messages.length, 1)
})

test('binary content is refused rather than dumped into the editor', async () => {
  // 一屏乱码看着像"文件就这样"，用户可能顺手存回去，把远端文件写坏。
  const view = fixture(async command => command === 'sftp.preview'
    ? { dataBase64: '\u0000\u0000\u0000\u0000binary' }
    : {})
  await view.open(at('/bin/thing', 'thing'))
  assert.equal(view.modal().props.open, false, '二进制文件不进编辑器')
  assert.equal(view.messages[0].type, 'warning')
})

test('a truncated file opens read-only and cannot be saved back', async () => {
  const view = fixture(async command => command === 'sftp.preview'
    ? { dataBase64: 'partial', truncated: true }
    : {})
  await view.open(at('/var/log/big.log', 'big.log'))
  assert.equal(view.textarea().props.readOnly, true, '截断的内容只能看')
  assert.equal(view.modal().props.okButtonProps.disabled, true, '截断的文件不给保存')
  await view.modal().props.onOk()
  await view.settle()
  assert.equal(view.writes().length, 0, '截断的内容不许写回：那会把远端文件截成半截')
})

test('saving writes the edited content to the file it was opened from', async () => {
  const view = fixture(async command => command === 'sftp.preview' ? { dataBase64: 'before' } : {})
  await view.open(at('/etc/app.conf', 'app.conf'))
  view.textarea().props.onChange({ target: { value: 'after' } })
  await view.settle()
  await view.modal().props.onOk()
  await view.settle()
  assert.deepEqual(
    view.writes().map(call => [call.args.connectionId, call.args.path, call.args.dataBase64]),
    [['c1', '/etc/app.conf', 'after']],
  )
  assert.equal(view.modal().props.open, false, '保存成功后关窗')
  assert.equal(view.closed(), 1, '关窗要通知调用方回列表刷新')
})

test('a save invalidated by opening another file never writes the old path', async () => {
  const saving = deferred()
  const view = fixture(async command => {
    if (command === 'sftp.preview') return { dataBase64: 'x' }
    if (command === 'sftp.writeFile') return saving.promise
    return {}
  })
  await view.open(at('/A', 'A'))
  const pending = view.modal().props.onOk()
  await view.open(at('/B', 'B'))
  saving.resolve({})
  await pending
  await view.settle()
  assert.equal(view.modal().props.title, 'sftp.preview: /B', '过期保存不能把界面拉回 A')
  assert.equal(view.closed(), 0, '过期的保存完成不该顺手关掉 B 的窗口')
})

test('saving one file leaves the next preview editable and saveable', async () => {
  const view = fixture(async command => command === 'sftp.preview' ? { dataBase64: 'before' } : {})
  for (const name of ['A', 'B']) {
    await view.open(at('/' + name, name))
    assert.equal(view.modal().props.okButtonProps.loading, false)
    view.textarea().props.onChange({ target: { value: name + ' edited' } })
    await view.settle()
    view.modal().props.onOk()
    await view.settle()
  }
  assert.deepEqual(view.writes().map(call => call.args.dataBase64), ['A edited', 'B edited'])
})

test('an unread preview cannot replace the remote file with an empty draft', async () => {
  const reading = deferred()
  const view = fixture(async command => command === 'sftp.preview' ? reading.promise : {})
  await view.open(at('/A', 'A'))
  assert.equal(view.modal().props.okButtonProps.disabled, true)
  view.modal().props.onOk()
  await view.settle()
  assert.equal(view.writes().length, 0)
  reading.resolve({ dataBase64: 'loaded' })
  await view.settle()
  assert.equal(view.modal().props.okButtonProps.disabled, false)
})

test('closing a preview discards its late read error', async () => {
  const reading = deferred()
  const view = fixture(async () => reading.promise)
  await view.open(at('/A', 'A'))
  view.modal().props.onCancel()
  await view.settle()
  reading.reject(new Error('obsolete read failed'))
  await view.settle()
  assert.deepEqual(view.messages, [])
  assert.equal(view.closed(), 1)
})

test('closing during a save does not notify or refresh a different connection', async () => {
  const writing = deferred(), saved = []
  const view = fixture(async command => command === 'sftp.preview' ? { dataBase64: 'loaded' } : writing.promise)
  view.props.onSaved = target => saved.push(target.path)
  await view.open(at('/A', 'A'))
  view.modal().props.onOk()
  view.modal().props.onCancel()
  await view.settle()
  writing.resolve({})
  await view.settle()
  assert.deepEqual(saved, [])
  assert.equal(view.closed(), 1)
  assert.deepEqual(view.messages, [])
})
