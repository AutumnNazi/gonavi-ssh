const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 终端旁的单栏远端文件浏览：跟随终端目录、响应跳转命令、懒加载当前目录。
// 目录列表由 sftp.list 提供，这里用假桥驱动，断言的是请求与渲染，不是 SFTP。
function fixture(reply = async () => ({ entries: [], home: '/root' }), overrides = {}, bridge = {}) {
  const hooks = [], effects = [], scheduled = [], calls = [], messages = [], modalCalls = []
  let cursor = 0, tree
  const react = {
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value } },
    useState(initial) {
      const i = cursor++
      hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[i].value, next => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
    },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useEffect(run, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((value, n) => value !== old.deps[n])) scheduled.push(() => {
        old?.cleanup?.()
        effects[i] = { deps, cleanup: run() }
      })
    },
  }
  const jsx = (type, props) => ({ type, props })
  // List 桩要真的调 renderItem，否则断言不到行。
  const List = ({ dataSource = [], renderItem, footer }) => ({ type: 'List', props: { children: [...dataSource.map(renderItem), footer] } })
  Object.assign(List, { Item: ({ children, ...rest }) => ({ type: 'List.Item', props: { ...rest, children } }) })
  const antd = new Proxy({
    List,
    Checkbox: ({ checked, onChange, children }) => ({ type: 'Checkbox', props: { checked, onChange, children } }),
    Tooltip: ({ children }) => children,
    Space: ({ children }) => ({ type: 'Space', props: { children } }),
    Spin: () => ({ type: 'Spin', props: {} }),
    Input: props => ({ type: 'Input', props }),
    // 新建目录/重命名/删除确认都走 Modal.confirm：桩把参数记下来，由用例决定是否点确定。
    Modal: Object.assign(() => null, {
      confirm: options => { modalCalls.push(options); return { destroy() {} } },
    }),
    message: Object.fromEntries(['error', 'warning', 'success'].map(type => [type, text => messages.push({ type, text })])),
  }, { get: (target, key) => target[key] ?? String(key) })
  const module = { exports: {} }
  const load = (file, globals = {}) => {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    const target = { exports: {} }
    vm.runInNewContext(code, { module: target, exports: target.exports, ...globals }, { filename: file })
    return target.exports
  }
  const output = fs.readFileSync(path.join(__dirname, 'FileTreePanel.tsx'), 'utf8')
  vm.runInNewContext(ts.transpileModule(output, {
    fileName: 'FileTreePanel.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === 'antd') return antd
      if (name === '@ant-design/icons') return new Proxy({}, { get: (_t, key) => String(key) })
      if (name === '../bridge') return {
        // 组件在 vm 里造的参数对象原型来自另一个 realm，deepStrictEqual 会判成不等；
        // 记录时搬回宿主 realm，断言才是在比内容而不是比原型。
        invokeAs: async (command, args) => {
          calls.push({ command, args: args === undefined ? args : JSON.parse(JSON.stringify(args)) })
          return reply(command, args)
        },
        describeError: error => error.message || String(error),
      }
      if (name === '../fsFormat') return load(path.join(__dirname, '..', 'fsFormat.ts'))
      if (name === '../i18n') return { t: key => key }
      if (name === '../usePanelResize') return load(path.join(__dirname, '..', 'usePanelResize.ts'), { require: () => react })
      if (name === './PathBreadcrumb') return load(path.join(__dirname, 'PathBreadcrumb.tsx'), {
        require: n => (n === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: 'Fragment' } : {}),
      })
      return {}
    },
    // 宿主桥：上传/下载目录靠原生选择器，没有桥就没有这些动作。
    window: { gonaviPlugin: bridge.gonaviPlugin ?? {} },
  }, { filename: 'FileTreePanel.tsx' })

  const props = {
    connectionId: 'c1', jump: null, follow: false, onFollowChange: () => {}, onCollapse: () => {},
    downloadDir: '/local/drops', onDownloadDirChange: () => {}, ...overrides,
  }
  function render() {
    cursor = 0
    tree = module.exports.FileTreePanel(props)
    for (const effect of scheduled.splice(0)) effect()
    return tree
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found } return undefined }
    if (predicate(node)) return node
    // 行与页脚挂在 props 上而不是 children 上（函数组件不由假渲染器展开），
    // 找按钮这类节点时得跟 rows() 一样手动展开。
    if (node.props?.renderItem && Array.isArray(node.props.dataSource)) {
      for (const item of node.props.dataSource) {
        const found = find(predicate, node.props.renderItem(item))
        if (found) return found
      }
      // 页脚可能没有：不能直接把 undefined 传下去，find 的默认参数会当成 tree 再来一遍。
      return node.props.footer === undefined ? undefined : find(predicate, node.props.footer)
    }
    return node.props?.children === undefined ? undefined : find(predicate, node.props.children)
  }
  function findIn(node, predicate) {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { const found = findIn(child, predicate); if (found) return found } return undefined }
    if (predicate(node)) return node
    return node.props?.children === undefined ? undefined : findIn(node.props.children, predicate)
  }
  const rows = () => {
    const out = []
    // 函数组件在真实 React 里由协调器展开；这里手动展开 List 的行。
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props?.renderItem && Array.isArray(node.props.dataSource)) {
        for (const item of node.props.dataSource) walk(node.props.renderItem(item))
        walk(node.props.footer)
        return
      }
      if (node.props?.['data-path'] !== undefined) out.push(node)
      walk(node.props?.children)
    }
    walk(tree)
    return out
  }
  const row = target => {
    const found = rows().find(r => r.props['data-path'] === target)
    assert.ok(found, `row ${target} must exist`)
    return found
  }
  const button = label => {
    const direct = find(n => n.type === 'Button' && n.props['aria-label'] === label)
    const menu = find(n => n.type === 'Dropdown' && n.props.trigger?.includes('click'))?.props.menu
    const item = menu?.items.find(item => item.label === label)
    const node = direct ?? (item && { props: { onClick: item.onClick, disabled: item.disabled } })
    assert.ok(node, `button ${label} must exist`)
    return node
  }
  render()
  return {
    props, render, find, rows, calls, messages, button, row,
    /** 某一行的某一列（大小/时间）——不同行的同名 className 靠行定位区分。 */
    cell: (rowPath, className) => findIn(row(rowPath), n => n.props?.className === className),
    get tree() { return tree },
    /** 双击某一行（目录进入、.. 返回上级）。 */
    open: target => row(target).props.onDoubleClick(),
    /** 单击选中一行（工具栏的下载/重命名/删除都作用于选中项）。 */
    select: target => row(target).props.onClick({ stopPropagation() {} }),
    click: label => button(label).props.onClick(),
    /** 最后一次弹窗（新建目录/重命名/删除确认），由用例决定点确定还是取消。 */
    modal: () => modalCalls.at(-1),
    /** 底部的「下载到」投放区：拖进来的行会下载到那个目录。 */
    dropArea: () => {
      const node = find(n => n.props?.['data-drop'] === 'download')
      assert.ok(node, '下载投放区必须渲染')
      return node
    },
    followToggle: () => {
      const node = find(n => typeof n.props?.checked === 'boolean' && typeof n.props?.onChange === 'function')
      assert.ok(node, 'follow checkbox must render')
      node.props.onChange({ target: { checked: !node.props.checked } })
    },
    paths: () => calls.filter(call => call.command === 'sftp.list').map(call => call.args.path),
  }
}

// 展示的是本地时间，用本地日期构造输入，让 UTC 的 CI 与桌面时区断言相同内容。
const entry = (name, extra = {}) => ({ name, path: '/root/' + name, size: 12, mode: '-rw-r--r--', isDir: false, isLink: false, mtime: new Date(2026, 10, 6, 14, 57, 41).toISOString(), ...extra })

test('the tree lists the current directory with directories first', async () => {
  const view = fixture(async () => ({ entries: [entry('b.txt'), entry('zdir', { isDir: true }), entry('a.txt')], home: '/root' }))
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  if (process.env.DUMP) console.log(require('node:util').inspect(view.tree.props.children[1], { depth: 6 }).slice(0, 2500))
  assert.deepEqual(view.paths(), ['.'], '首次加载用 . 让后端解析 home')
  assert.deepEqual(
    view.rows().map(row => row.props['data-path']),
    ['/root/zdir', '/root/a.txt', '/root/b.txt'],
    "目录在前、其余按名称排；还在 home（'.'）时没有上一级，不显示「..」",
  )
  assert.equal(view.cell('/root/a.txt', 'fs-meta').props.children, '12 B', '文件显示大小')
  assert.equal(view.rows().find(row => row.props['data-path'] === '/root/a.txt').props.title, 'a.txt\n12 B\n2026-11-06 14:57', '时间放进悬停详情，为文件名保留宽度')
})

test('directories show no size and carry their own path', async () => {
  const view = fixture(async () => ({ entries: [entry('zdir', { isDir: true, size: 4096 })], home: '/root' }))
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.equal(view.cell('/root/zdir', 'fs-meta').props.children, '', '目录不显示大小')
})

test('double clicking a directory (and ..) navigates', async () => {
  const view = fixture(async (command, args) => args.path === '/root/zdir'
    ? { entries: [{ ...entry('inner.txt'), path: '/root/zdir/inner.txt' }], home: '/root' }
    : { entries: [entry('zdir', { isDir: true })], home: '/root' })
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  view.open('/root/zdir')
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.deepEqual(view.paths(), ['.', '/root/zdir'])
  assert.ok(view.rows().some(row => row.props['data-path'] === '/root/zdir/inner.txt'), '进入后列出子目录内容')
  assert.equal(view.rows()[0].props['data-path'], '..', '「..」排在列表最前面，跟在末尾会悬在下方空白上')
  view.open('..')
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.equal(view.paths().at(-1), '/root', '.. 从 /root/zdir 回到 /root')
})

test('the follow checkbox reports the new value without owning the setting', async () => {
  const view = fixture()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  const changes = []
  view.props.onFollowChange = next => changes.push(next)
  view.render()
  view.followToggle()
  assert.deepEqual(changes, [true], '勾选框只上报，不自己改设置')
})

test('refresh and collapse buttons call back', async () => {
  const view = fixture()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  const collapsed = []
  view.props.onCollapse = () => collapsed.push(true)
  view.render()
  view.click('tree.collapse')
  assert.deepEqual(collapsed, [true])
  view.click('sftp.refresh')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.paths(), ['.', '.'], '刷新重新加载当前目录')
})

test('a jump target opens that directory even when following is off', async () => {
  const view = fixture(async (command, args) => ({
    entries: args.path === '/var/log' ? [{ ...entry('syslog'), path: '/var/log/syslog' }] : [],
    home: '/root',
  }))
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  // 命令跳转是显式意图，与"跟随终端目录"开关无关，由上层决定是否给目标。
  view.props.jump = { path: '/var/log', seq: 1 }
  view.render()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.equal(view.paths().at(-1), '/var/log')
  assert.ok(view.rows().some(row => row.props['data-path'] === '/var/log/syslog'))
})

test('a truncated listing offers the next page instead of silently showing 500 rows', async () => {
  const view = fixture(async (command, args) => args.offset
    ? { entries: [{ ...entry('second.txt'), path: '/root/second.txt' }], more: false }
    : { entries: [entry('first.txt'), entry('second.txt')], more: true })
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  const first = view.calls.filter(call => call.command === 'sftp.list')[0]
  assert.equal(first.args.limit, 500, '必须显式按页请求')
  assert.equal(first.args.offset, 0)
  view.click('tree.more')
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  const last = view.calls.filter(call => call.command === 'sftp.list').at(-1)
  assert.equal(last.args.offset, 500, '取下一页要接着上一页的偏移')
  assert.ok(view.rows().some(row => row.props['data-path'] === '/root/first.txt'), '追加而不是替换')
  assert.ok(view.find(n => n.type === 'Button' && n.props['aria-label'] === 'tree.more') === undefined, '取完就没有下一页按钮了')
})

test('a repeated jump to the same path reloads it', async () => {
  const view = fixture()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  view.props.jump = { path: '/var/log', seq: 1 }
  view.render()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  view.props.jump = { path: '/var/log', seq: 2 }
  view.render()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(view.paths(), ['.', '/var/log', '/var/log'], 'seq 变化就算同路径也要重新定位')
})

test('a late listing for the previous connection cannot overwrite the new one', async () => {
  const pending = {}
  const view = fixture((command, args) => args.connectionId === 'c1'
    ? new Promise(resolve => { pending.resolve = () => resolve({ entries: [entry('old.txt')], home: '/root' }) })
    : Promise.resolve({ entries: [entry('new.txt')], home: '/root' }))
  await new Promise(resolve => setImmediate(resolve))
  view.props.connectionId = 'c2'
  view.render()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  pending.resolve()
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.ok(view.rows().some(row => row.props['data-path'] === '/root/new.txt'))
  assert.equal(view.rows().some(row => row.props['data-path'] === '/root/old.txt'), false, '旧连接的迟到响应必须丢弃')
})

test('a listing failure is reported without wiping the current view', async () => {
  let fail = false
  const view = fixture(async () => {
    if (fail) throw new Error('listing refused')
    return { entries: [entry('kept.txt')], home: '/root' }
  })
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  fail = true
  view.click('sftp.refresh')
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.deepEqual(view.messages.map(message => message.text), ['listing refused'])
  assert.ok(view.rows().some(row => row.props['data-path'] === '/root/kept.txt'), '失败不该清空已有列表')
})

test('a listing rejected after disconnect does not report an obsolete error', async () => {
  let rejectList
  const view = fixture(() => new Promise((_, reject) => { rejectList = reject }))
  view.props.connectionId = null
  view.render()
  rejectList(new Error('old connection closed'))
  await settle()
  assert.deepEqual(view.messages, [])
})

test('completing a remote action after a connection switch cannot reload the old connection', async () => {
  let finishAction
  const view = fixture(async (command, args) => command === 'sftp.mkdir'
    ? new Promise(resolve => { finishAction = resolve })
    : { entries: [entry(args.connectionId + '.txt')] })
  await settle()
  view.render()
  view.click('sftp.mkdir')
  view.modal().content.props.onChange({ target: { value: 'logs' } })
  view.modal().onOk()
  await settle()
  view.props.connectionId = 'c2'
  view.render()
  await settle()
  finishAction({})
  await settle()
  view.render()
  assert.equal(view.calls.filter(call => call.command === 'sftp.list').length, 2)
  assert.deepEqual(view.rows().map(row => row.props['data-path']), ['/root/c2.txt'])
})

test('confirming an obsolete file action after switching connections cannot mutate the old server', async () => {
  const view = await listed([entry('a.txt')])
  view.click('sftp.mkdir')
  const mkdir = view.modal()
  mkdir.content.props.onChange({ target: { value: 'logs' } })
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.remove')
  const remove = view.modal()
  view.props.connectionId = 'c2'
  view.render()
  await settle()
  mkdir.onOk()
  await remove.onOk()
  await settle()
  assert.equal(view.calls.some(call => ['sftp.mkdir', 'sftp.remove'].includes(call.command)), false)
})

test('following terminal directories still allows file preview and switching connections closes it', async () => {
  const view = await listed([entry('a.txt'), entry('dir', { isDir: true })], { follow: true })
  view.open('/root/dir')
  assert.deepEqual(view.paths(), ['.'])
  view.open('/root/a.txt')
  view.render()
  assert.equal(view.find(node => node.props?.target?.path === '/root/a.txt')?.props.target.connectionId, 'c1')
  view.props.connectionId = 'c2'
  view.render()
  await settle()
  view.render()
  assert.equal(view.find(node => node.props?.target?.path === '/root/a.txt'), undefined)
})

test('without a terminal connection the tree asks to connect instead of listing', async () => {
  const view = fixture(undefined, { connectionId: null })
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  assert.deepEqual(view.paths(), [], '没有连接就不该发请求')
  assert.ok(view.find(n => n.props?.className === 'file-tree-hint'), '要给出该连哪里的提示')
})

// ——— SFTP 动作：下载、上传、新建文件夹、重命名、删除都在这条栏里完成，
// 用户不必为了传一个文件跳到「文件」页的双栏面板去。 ———

const settle = () => new Promise(resolve => setImmediate(resolve))

async function listed(entries, overrides = {}, bridge = {}) {
  const view = fixture(async () => ({ entries, home: '/root' }), overrides, bridge)
  await settle()
  view.render()
  return view
}

test('the download action needs a selection and skips directories', async () => {
  const view = await listed([entry('a.txt'), entry('zdir', { isDir: true })])
  assert.equal(view.button('sftp.download').props.disabled, true, '没选中就没什么可下的')
  view.select('/root/zdir')
  view.render()
  assert.equal(view.button('sftp.download').props.disabled, true, '目录不能直接下，得先在远端打包')
  view.select('/root/a.txt')
  view.render()
  assert.equal(view.button('sftp.download').props.disabled, false, '选中文件后才能下载')
})

test('downloading hands the file to the transfer queue in the configured folder', async () => {
  const view = await listed([entry('a.txt')])
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.download')
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'transfer.start')?.args, {
    connectionId: 'c1', direction: 'download',
    remotePath: '/root/a.txt', localPath: '/local/drops/a.txt',
  }, '下载走传输队列，文件内容不过桥')
  assert.deepEqual(view.messages.at(-1), { type: 'success', text: 'tree.downloadStarted' })
})

test('without a download folder the panel asks for one first and remembers it', async () => {
  const changes = []
  const view = await listed([entry('a.txt')], { downloadDir: '', onDownloadDirChange: next => changes.push(next) },
    { gonaviPlugin: { pickFolder: async () => 'D:\\drops' } })
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.download')
  await settle()
  assert.deepEqual(changes, ['D:\\drops'], '挑定的目录要写回设置，下次不再问')
  assert.equal(view.calls.find(call => call.command === 'transfer.start')?.args.localPath, 'D:\\drops\\a.txt')
})

test('cancelling the folder picker downloads nothing', async () => {
  const view = await listed([entry('a.txt')], { downloadDir: '' },
    { gonaviPlugin: { pickFolder: async () => null } })
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.download')
  await settle()
  assert.equal(view.calls.some(call => call.command === 'transfer.start'), false, '没挑目录就别悄悄下到别处')
})

test('a host without a folder picker says so instead of failing silently', async () => {
  const view = await listed([entry('a.txt')], { downloadDir: '' })
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.download')
  await settle()
  assert.deepEqual(view.messages.at(-1), { type: 'warning', text: 'tree.noPicker' })
  assert.equal(view.calls.some(call => call.command === 'transfer.start'), false)
})

test('the download folder can be pointed somewhere else from the panel', async () => {
  const changes = []
  const view = await listed([], { downloadDir: '/old', onDownloadDirChange: next => changes.push(next) },
    { gonaviPlugin: { pickFolder: async () => '/new' } })
  view.click('tree.chooseDir')
  await settle()
  assert.deepEqual(changes, ['/new'])
})

test('uploading picks a local file and sends it to the open directory', async () => {
  const view = await listed([], {}, { gonaviPlugin: { pickFile: async () => 'C:\\tmp\\x.txt' } })
  view.click('sftp.upload')
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'transfer.start')?.args, {
    connectionId: 'c1', direction: 'upload', localPath: 'C:\\tmp\\x.txt', remotePath: 'x.txt',
  }, '当前目录还是 home 简写时就把文件放进 home')
})

test('cancelling the file picker uploads nothing', async () => {
  const view = await listed([], {}, { gonaviPlugin: { pickFile: async () => null } })
  view.click('sftp.upload')
  await settle()
  assert.equal(view.calls.some(call => call.command === 'transfer.start'), false)
})

test('removing asks first and picks the recursive call for directories', async () => {
  const view = await listed([entry('a.txt'), entry('zdir', { isDir: true })])
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.remove')
  assert.equal(view.calls.some(call => call.command === 'sftp.remove'), false, '确认之前不能真删')
  view.modal().onOk()
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'sftp.remove')?.args, {
    connectionId: 'c1', path: '/root/a.txt',
  })
  view.select('/root/zdir')
  view.render()
  view.click('sftp.remove')
  view.modal().onOk()
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'sftp.removeRecursive')?.args, {
    connectionId: 'c1', path: '/root/zdir',
  }, '目录要连内容一起删，普通 remove 会被 SFTP 拒绝')
})

test('a removal only happens on confirm', async () => {
  // 取消就是不点确定：弹窗本身不产生任何远端动作。
  const view = await listed([entry('a.txt')])
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.remove')
  assert.ok(view.modal(), '先确认弹窗确实弹出来了')
  await settle()
  assert.equal(view.calls.some(call => call.command === 'sftp.remove'), false, '没点确定就什么都不该发生')
})

test('a new directory is created inside the open directory', async () => {
  const view = await listed([])
  view.click('sftp.mkdir')
  assert.ok(view.modal(), '要问一个名字')
  view.modal().content.props.onChange({ target: { value: 'logs' } })
  view.modal().onOk()
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'sftp.mkdir')?.args, {
    connectionId: 'c1', path: 'logs',
  })
  assert.deepEqual(view.paths(), ['.', '.'], '建完要重新拉一次，否则用户看不到自己刚建的东西')
})

test('a blank name creates nothing', async () => {
  const view = await listed([])
  view.click('sftp.mkdir')
  view.modal().content.props.onChange({ target: { value: '   ' } })
  view.modal().onOk()
  await settle()
  assert.equal(view.calls.some(call => call.command === 'sftp.mkdir'), false, '只有空白不是名字')
})

test('renaming keeps the file in its own directory', async () => {
  const view = await listed([entry('a.txt')])
  view.select('/root/a.txt')
  view.render()
  view.click('sftp.rename')
  view.modal().content.props.onChange({ target: { value: 'b.txt' } })
  view.modal().onOk()
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'sftp.rename')?.args, {
    connectionId: 'c1', oldPath: '/root/a.txt', newPath: '/root/b.txt',
  })
})

test('a failed remote action is reported and the list is kept', async () => {
  const view = fixture(async (command) => {
    if (command === 'sftp.mkdir') throw new Error('permission denied')
    return { entries: [entry('kept.txt')], home: '/root' }
  })
  await settle()
  view.render()
  view.click('sftp.mkdir')
  view.modal().content.props.onChange({ target: { value: 'logs' } })
  view.modal().onOk()
  await settle()
  view.render()
  assert.deepEqual(view.messages.at(-1), { type: 'error', text: 'permission denied' })
  assert.ok(view.rows().some(row => row.props['data-path'] === '/root/kept.txt'), '动作失败不该清空列表')
})

test('dragging a row onto the download area downloads it there', async () => {
  const view = await listed([entry('a.txt')])
  view.row('/root/a.txt').props.onDragStart()
  view.dropArea().props.onDragOver({ preventDefault() {} })
  view.dropArea().props.onDrop({ preventDefault() {} })
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'transfer.start')?.args, {
    connectionId: 'c1', direction: 'download',
    remotePath: '/root/a.txt', localPath: '/local/drops/a.txt',
  })
})

test('dropping something that was never dragged in is ignored', async () => {
  const view = await listed([entry('a.txt')])
  view.dropArea().props.onDrop({ preventDefault() {} })
  await settle()
  assert.equal(view.calls.some(call => call.command === 'transfer.start'), false, '没有拖拽来源就不猜下载哪个')
})

// 模拟捕获阶段清除旧目标，再冒泡到行上选取当前右键目标。
const contextMenu = (view, path) => {
  view.find(node => node.props?.className === 'fs-scroll').props.onContextMenuCapture()
  if (path) view.row(path).props.onContextMenu()
  view.render()
  return view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu'))
}
const menuKeys = (view, path) => {
  const dropdown = contextMenu(view, path)
  assert.equal(dropdown.props.open, true)
  return dropdown.props.menu.items.map(item => item.key)
}

test('a file row menu offers open and download, a directory row menu offers cd', async () => {
  // 菜单里出现点不动的项，比干脆不出现更让人困惑：按条目类型裁剪。
  const view = await listed([entry('a.txt'), entry('zdir', { isDir: true })])
  const file = menuKeys(view, '/root/a.txt')
  assert.ok(file.includes('preview'), '文件行要能打开预览')
  assert.ok(file.includes('external'), '文件行要能用本机程序打开')
  assert.ok(file.includes('download'), '文件行要能下载')
  assert.equal(file.includes('cd'), false, '对文件谈"cd 到这里"是空点一次')

  const dir = menuKeys(view, '/root/zdir')
  assert.ok(dir.includes('cd'), '目录行要能 cd 过去')
  assert.equal(dir.includes('preview'), false, '目录不能预览')
  assert.equal(dir.includes('download'), false, '目录不能直接下载')
  for (const key of ['rename', 'remove', 'copyPath', 'mkdir', 'upload']) {
    assert.ok(dir.includes(key), `${key} 对目录也要有`)
  }
})

test('500 directory entries share one context menu and actions target the right-clicked row', async () => {
  const entries = Array.from({ length: 500 }, (_, i) => entry(`file${i}.txt`))
  const view = await listed(entries)
  let menus = 0
  view.find(node => { if (node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')) menus++; return false })
  assert.equal(view.rows().length, 500)
  assert.equal(menus, 1, 'large directories must not mount a Dropdown trigger per row')
  view.select('/root/file0.txt')
  view.render()
  contextMenu(view, '/root/file499.txt').props.menu.onClick({ key: 'download' })
  await settle()
  assert.equal(view.calls.find(call => call.command === 'transfer.start').args.remotePath, '/root/file499.txt')
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false)
  const next = contextMenu(view, '/root/file498.txt')
  next.props.menu.onClick({ key: 'rename' })
  view.modal().content.props.onChange({ target: { value: 'renamed.txt' } })
  view.modal().onOk()
  await settle()
  assert.deepEqual(view.calls.find(call => call.command === 'sftp.rename').args, {
    connectionId: 'c1', oldPath: '/root/file498.txt', newPath: '/root/renamed.txt',
  })
})

test('blank context clicks and directory or connection changes clear the menu target', async () => {
  const view = await listed([entry('a.txt'), entry('dir', { isDir: true })])
  contextMenu(view, '/root/a.txt')
  const blank = contextMenu(view)
  blank.props.onOpenChange(true)
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false)
  view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.menu.onClick({ key: 'remove' })
  assert.equal(view.modal(), undefined, 'blank space must never reuse a previous row')

  contextMenu(view, '/root/a.txt')
  view.open('/root/dir')
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false, 'close while navigation is pending')
  await settle()
  view.render()
  contextMenu(view, '/root/a.txt')
  view.props.connectionId = 'c2'
  view.render()
  await settle()
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false)
})

test('selecting a row and a pending listing completing both dismiss old context actions', async () => {
  let finish
  const view = fixture(async (_command, args) => args.path === '.'
    ? { entries: [entry('old.txt'), entry('dir', { isDir: true })] }
    : new Promise(resolve => { finish = resolve }))
  await settle()
  view.render()
  contextMenu(view, '/root/old.txt')
  view.select('/root/dir')
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false, 'left click dismisses the menu')
  view.open('/root/dir')
  contextMenu(view, '/root/old.txt')
  finish({ entries: [entry('new.txt')] })
  await settle()
  view.render()
  assert.equal(view.find(node => node.type === 'Dropdown' && node.props.trigger?.includes('contextMenu')).props.open, false, 'a response must dismiss menus opened during its request')
})


test('file pane resize clamps width, commits once, cancels cleanly and supports keyboard reset', () => {
  const saved = []
  const view = fixture(async () => ({ entries: [] }), { width: 260, onWidthChange: value => saved.push(value) })
  const separator = view.find(node => node.props?.role === 'separator').props
  const attributes = new Map(), captures = new Set()
  const container = { clientWidth: 900 }
  const pane = {
    parentElement: container, style: { width: '260px' },
    getBoundingClientRect() { return { width: Math.min(Number.parseFloat(this.style.width), Math.max(160, container.clientWidth - 200)) } },
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
  }
  const handle = {
    parentElement: pane, focus() {}, setAttribute: (key, value) => attributes.set(key, value),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
  }
  const event = (clientX, extra = {}) => ({ currentTarget: handle, pointerId: 1, clientX, button: 0, isPrimary: true, preventDefault() {}, ...extra })
  separator.onPointerDown(event(100, { button: 2 }))
  separator.onPointerMove(event(300))
  assert.equal(pane.style.width, '260px', 'secondary buttons cannot resize')
  separator.onPointerDown(event(100))
  separator.onPointerMove(event(200))
  assert.equal(pane.style.width, '360px')
  separator.onPointerMove(event(900))
  assert.equal(pane.style.width, '700px')
  assert.deepEqual(saved, [], 'moving must not re-render the file list or persist every pointer event')
  separator.onPointerUp(event(900))
  assert.deepEqual(saved, [700])
  assert.equal(captures.size, 0)
  assert.equal(attributes.has('data-resizing'), false)
  container.clientWidth = 700
  separator.onKeyDown(event(0, { key: 'End' }))
  assert.equal(pane.style.width, '500px', 'leave 200px for the terminal')
  separator.onPointerDown(event(100))
  separator.onPointerMove(event(-900))
  assert.equal(pane.style.width, '160px')
  separator.onPointerCancel(event(-900))
  assert.equal(pane.style.width, '500px')
  assert.deepEqual(saved, [700, 500], 'cancel restores the starting size without committing')
  separator.onKeyDown(event(0, { key: 'Home' }))
  separator.onKeyDown(event(0, { key: 'ArrowRight' }))
  assert.equal(pane.style.width, '176px')
  separator.onDoubleClick(event(0))
  assert.equal(pane.style.width, '260px')
  separator.onPointerDown(event(100))
  separator.onPointerMove(event(200))
  separator.onKeyDown(event(0, { key: 'Escape' }))
  assert.equal(pane.style.width, '260px')
  separator.onLostPointerCapture(event(0))
  assert.deepEqual(saved, [700, 500, 160, 176, 260])
  assert.equal(attributes.get('aria-valuenow'), '260')
  container.clientWidth = 1600
  separator.onKeyDown(event(0, { key: 'End' }))
  assert.equal(pane.style.width, '1400px', 'wide windows must not have a fixed sidebar cap')
  assert.equal(attributes.get('aria-valuemax'), '1400')
  container.clientWidth = 500
  separator.onPointerDown(event(100))
  separator.onPointerMove(event(50))
  separator.onKeyDown(event(0, { key: 'Escape' }))
  assert.equal(pane.style.width, '1400px', 'cancel must preserve the preferred width before CSS viewport clamping')
  assert.equal(attributes.get('aria-valuenow'), '300', 'accessibility reports the rendered width')
  container.clientWidth = 1600
  assert.equal(pane.getBoundingClientRect().width, 1400, 'the pane regains its preferred width when the window grows')
})
