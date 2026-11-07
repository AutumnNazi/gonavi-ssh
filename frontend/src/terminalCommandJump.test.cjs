const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function loadTs(file) {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: file })
  return module.exports
}

const { createInputLine, matchCommandJump } = loadTs(path.join(__dirname, 'terminalCommandJump.ts'))

// 把一串按键喂进行缓冲，返回每次回车提交出来的整行。
function lines(...inputs) {
  const buffer = createInputLine()
  const submitted = []
  for (const input of inputs) {
    const line = buffer.feed(input)
    if (line !== null) submitted.push(line)
  }
  return submitted
}

test('a whole line is submitted on enter and the buffer starts over', () => {
  assert.deepEqual(lines('l', 's', '\r'), ['ls'])
  assert.deepEqual(lines('l', 's', '\r', 'p', 'w', 'd', '\r'), ['ls', 'pwd'])
  assert.deepEqual(lines('l', 's', '\n'), ['ls'], '远端回显里换行也可能是 \\n')
})

test('backspace removes the last character instead of leaving it in the line', () => {
  assert.deepEqual(lines('l', 's', 'x', '\x7f', '\r'), ['ls'])
  assert.deepEqual(lines('a', '\x7f', '\x7f', 'b', '\r'), ['b'], '退格删空后不能把行清成负长度')
  assert.deepEqual(lines('中', '文', '\x7f', '\r'), ['中'], '退格按字符删，不能只删半个代理对')
})

test('ctrl-c and ctrl-u cancel the line so a cancelled command never matches', () => {
  assert.deepEqual(lines('l', 'o', 'g', 's', '\x03', '\r'), [''])
  assert.deepEqual(lines('l', 'o', 'g', 's', '\x15', '\r'), [''])
})

test('arrow keys and other escape sequences do not leak into the line', () => {
  assert.deepEqual(lines('l', '\x1b[A', '\x1b[1;5C', '\x1bOD', 's', '\r'), ['ls'])
  assert.deepEqual(lines('\x1b[200~ls\x1b[201~', '\r'), ['ls'], '括号粘贴的包裹序列要丢掉，内容要留下')
})

test('an empty enter submits an empty line but a bare keystroke submits nothing', () => {
  const buffer = createInputLine()
  assert.equal(buffer.feed('l'), null, '没有回车就不算提交')
  assert.equal(buffer.current(), 'l')
  assert.equal(buffer.feed('\r'), 'l', '回车提交整行')
  assert.equal(buffer.current(), '', '提交后缓冲要清空')
  assert.equal(buffer.feed(''), null, '空输入不提交')
  assert.equal(buffer.feed('\r'), '', '空行回车提交空串，映射不该命中')
})

test('a jump command needs the # prefix so a real command is never hijacked', () => {
  const jumps = [{ name: 'logs', path: '/var/log' }, { name: 'app', path: '/opt/app' }]
  assert.equal(matchCommandJump('#logs', jumps), '/var/log')
  assert.equal(matchCommandJump('  #logs  ', jumps), '/var/log', '两侧空白不算区别')
  assert.equal(matchCommandJump('# logs', jumps), '/var/log', '井号后留个空格也认')
  assert.equal(matchCommandJump('#app', jumps), '/opt/app')
  assert.equal(matchCommandJump('logs', jumps), null, '不加前缀就是普通命令，别劫持用户真打在终端里的东西')
  assert.equal(matchCommandJump('cd /var/log', jumps), null)
  assert.equal(matchCommandJump('#', jumps), null, '只有一个井号不算命令')
  assert.equal(matchCommandJump('##logs', jumps), null, '只认一个前缀，多打的也算命令正文')
})

test('a jump matches only a whole trimmed line', () => {
  const jumps = [{ name: 'logs', path: '/var/log' }]
  assert.equal(matchCommandJump('#logs /tmp', jumps), null, '带参数的命令不是这条映射，别猜')
  assert.equal(matchCommandJump('#cd logs', jumps), null)
  assert.equal(matchCommandJump('#LOGS', jumps), null, '命令名大小写敏感')
  assert.equal(matchCommandJump('', jumps), null)
  assert.equal(matchCommandJump('#logs', []), null)
  assert.equal(matchCommandJump('#logs', undefined), null, '设置还没加载出来时不能崩')
})

test('the mapping entry is accepted with or without the prefix', () => {
  // 用户照着设置里的提示把 # 一起填进命令框也很正常，两种写法都得能用。
  assert.equal(matchCommandJump('#logs', [{ name: '#logs', path: '/var/log' }]), '/var/log')
  assert.equal(matchCommandJump('#logs', [{ name: ' logs ', path: '/var/log' }]), '/var/log')
})

test('an incomplete or blank mapping entry is skipped rather than remembered', () => {
  const jumps = [{ name: '', path: '/x' }, { name: '#app', path: '' }, { name: 'logs', path: '/var/log' }]
  assert.equal(matchCommandJump('#', jumps), null, '空命令名不能匹配到任何输入')
  assert.equal(matchCommandJump('#app', jumps), null, '没有目录的条目等于没配')
  assert.equal(matchCommandJump('#logs', jumps), '/var/log')
})

test('a jump is reported only when the submitted line matches', () => {
  const jumps = [{ name: 'logs', path: '/var/log' }]
  const buffer = createInputLine()
  const hits = []
  for (const input of ['#', 'l', 'o', 'g', 's']) {
    const line = buffer.feed(input)
    const path = line === null ? null : matchCommandJump(line, jumps)
    if (path) hits.push(path)
  }
  assert.deepEqual(hits, [], '没按回车就不能跳')
  const line = buffer.feed('\r')
  const path = matchCommandJump(line, jumps)
  if (path) hits.push(path)
  assert.deepEqual(hits, ['/var/log'])
})
