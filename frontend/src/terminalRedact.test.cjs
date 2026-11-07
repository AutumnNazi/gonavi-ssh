const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

// 注入命令回显的消除：远端 PTY 会把写进去的整行原样吐回来（内核行为，关不掉）。
// 现在要剥的是注入起头那行 `read -s`（长钩子由它静默读走，不经屏幕），判定原则
// 仍是"能对上才吃，对不上就原样放行"——宁可露出这行，也不能吞掉任何真实输出。
function redactor() {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'terminalRedact.ts'), 'utf8'), {
    fileName: 'terminalRedact.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: 'terminalRedact.ts' })
  return module.exports.createEchoRedactor()
}

const INJECT = '__g7(){ printf \'\\033]7;file://%s%s\\033\\\\\' "$(hostname)" "$PWD"; }; echo ok\r'

test('the echoed injection is swallowed while the newline after it still prints', () => {
  const r = redactor()
  r.hide(INJECT)
  assert.equal(r.filter(INJECT), '', '整行回显要被吃掉')
  assert.equal(r.filter('\r\n'), '\r\n', '远端额外补的换行照常绘制（提示符要在下一行）')
})

test('a fragmented echo is swallowed across chunks', () => {
  const r = redactor()
  r.hide(INJECT)
  const chunks = [INJECT.slice(0, 7), INJECT.slice(7, 40), INJECT.slice(40)]
  assert.deepEqual(chunks.map(chunk => r.filter(chunk)), ['', '', ''], 'PTY 逐字符回显，分片也要能对上')
  assert.equal(r.filter('[root@host ~]# '), '[root@host ~]# ', '吃掉之后远端正常输出不受影响')
})

test('output that does not match the injection is passed through untouched', () => {
  const r = redactor()
  r.hide(INJECT)
  assert.equal(r.filter('[root@host ~]# cd logs\r\n'), '[root@host ~]# cd logs\r\n', '用户在注入窗口里打的字不能被吞')
})

test('a partial mismatch gives up instead of eating real output', () => {
  const r = redactor()
  r.hide(INJECT)
  assert.equal(r.filter('__g7x'), '__g7x', '对到一半发现不一样就原样放行')
  assert.equal(r.filter(INJECT), INJECT, '放弃之后不再继续吃掉后续内容')
})

test('an edit that never gets echoed does not poison later output', () => {
  const r = redactor()
  r.hide(INJECT)
  assert.equal(r.filter('total 12\r\n'), 'total 12\r\n')
  assert.equal(r.filter(INJECT), INJECT, '第一次对不上之后就不再拦了')
})

test('without a pending injection the filter is the identity', () => {
  const r = redactor()
  assert.equal(r.filter('anything'), 'anything')
  assert.equal(r.filter(''), '')
})

test('reset drops a pending injection on session rebuild', () => {
  const r = redactor()
  r.hide(INJECT)
  r.reset()
  assert.equal(r.filter(INJECT), INJECT, '换会话后旧注入的回显不能再被当成新会话的')
})

test('a later injection is swallowed too', () => {
  const r = redactor()
  r.hide('first\r')
  assert.equal(r.filter('first\r'), '', '先发的先被吃掉')
  assert.equal(r.filter('\r\n'), '\r\n')
  r.hide('second\r')
  assert.equal(r.filter('second\r'), '', '第二次注入照样要吃掉')
})
