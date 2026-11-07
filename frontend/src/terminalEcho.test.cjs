const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')

function loadTs(file) {
  const source = readFileSync(file, 'utf8')
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: file })
  return module.exports
}

// 时钟与阈值都固定下来，用例只断言判定结果，不依赖真实时间。
function echo(overrides = {}) {
  const clock = { t: 10_000 }
  const subject = loadTs(path.join(__dirname, 'terminalEcho.ts')).createLocalEcho({
    now: () => clock.t,
    quietMs: 50,
    cooldownMs: 1_000,
    maxPending: 8,
    maxPredict: 4,
    ...overrides,
  })
  return { echo: subject, clock }
}

// 远端安静下来（越过静默窗口）后时钟前进。
function idle(clock) { clock.t += 51 }

test('a printable ascii key is drawn immediately and waits for the remote echo', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  assert.equal(subject.predict('l', true), 'l', '按键要立刻上屏')
  assert.equal(subject.predict('s', true), 's')
  assert.equal(subject.pending(), 'ls', '未确认缓冲要记着这两个字符，等远端回显抵消')
})

test('prediction is skipped when the caller says it is not allowed', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  assert.equal(subject.predict('l', false), '', '广播或输入不可用时不能预测')
  assert.equal(subject.pending(), '')
})

test('control characters and non-ascii input are never predicted', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  for (const data of ['\r', '\x7f', '\x03', '\t', '\x1b[A', '中', 'ab中', 'ls\r', '\x1b[200~ls\x1b[201~']) {
    assert.equal(subject.predict(data, true), '', `不该预测 ${JSON.stringify(data)}`)
  }
  assert.equal(subject.pending(), '', '被拒绝的输入不能进缓冲')
})

test('a remote echo of the prediction is not drawn twice', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  subject.predict('s', true)
  assert.equal(subject.consume('ls'), '', '远端回显已经画过的字符，不能再写一遍')
  assert.equal(subject.pending(), '')
})

test('a partial echo only consumes the matching prefix', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  subject.predict('s', true)
  assert.equal(subject.consume('l'), '', '远端只回了一半（分片），不能当成分歧')
  assert.equal(subject.pending(), 's', '已确认的部分出缓冲，剩下的继续等')
  assert.equal(subject.consume('s\r\n'), '\r\n', '确认后余下的输出照常绘制')
  assert.equal(subject.pending(), '')
})

test('an echo followed by more output draws only the extra part', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  assert.equal(subject.consume('l$ '), '$ ', '回显抵消后，额外输出照常绘制')
  assert.equal(subject.pending(), '')
})

test('a diverging echo drops the buffer and draws from the divergence point', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  subject.predict('s', true)
  assert.equal(subject.consume('lX'), 'X', '相同的首字符已画过，只画分歧起的部分')
  assert.equal(subject.pending(), '', '分歧后缓冲必须清空，否则后续回显会被误抵消')
})

test('after a divergence prediction pauses, then resumes', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  subject.consume('X')
  clock.t += 10
  assert.equal(subject.predict('a', true), '', '刚分歧过要冷静，别继续画')
  clock.t += 1_000
  assert.equal(subject.predict('a', true), 'a', '冷静期过后恢复预测')
})

test('a busy remote suppresses prediction until it goes quiet', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.consume('total 12\n')
  assert.equal(subject.predict('x', true), '', '远端正在输出，画上去会落到错误位置')
  idle(clock)
  assert.equal(subject.predict('x', true), 'x', '远端安静下来才预测')
})

test('the pending buffer is capped so a silent remote cannot fill the screen', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  let drawn = ''
  for (let i = 0; i < 20; i++) {
    clock.t += 51
    drawn += subject.predict('a', true)
  }
  assert.equal(drawn.length, 8, '上限 8：远端不回显时不能无限堆字符')
  assert.equal(subject.pending().length, 8)
})

test('a single long input string (paste) is not predicted', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  assert.equal(subject.predict('abcde', true), '', '超过单次上限的串按粘贴处理，不预测')
  assert.equal(subject.predict('abcd', true), 'abcd', '上限之内照常预测')
})

test('reset drops unconfirmed predictions and allows immediate prediction', () => {
  const { echo: subject } = echo()
  subject.predict('l', true)
  assert.equal(subject.pending(), 'l')
  subject.reset()
  assert.equal(subject.pending(), '', '新会话/新屏幕不能带着旧预测')
  assert.equal(subject.predict('l', true), 'l', 'reset 后立刻可预测，不受静默窗口限制')
})

test('an empty remote chunk neither draws nor disturbs the buffer', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  subject.predict('l', true)
  assert.equal(subject.consume(''), '')
  assert.equal(subject.pending(), 'l', '空分片不能清缓冲')
})

test('with nothing pending the remote output passes through untouched', () => {
  const { echo: subject } = echo()
  assert.equal(subject.consume('\x1b]0;title\x07boot\n'), '\x1b]0;title\x07boot\n')
})

test('space is predictable but a bare control byte is not', () => {
  const { echo: subject, clock } = echo()
  idle(clock)
  assert.equal(subject.predict(' ', true), ' ')
  assert.equal(subject.predict('\x00', true), '')
})
