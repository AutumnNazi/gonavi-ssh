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
  vm.runInNewContext(output, { module, exports: module.exports, Date }, { filename: file })
  return module.exports
}

const { fmtBytes, fmtMtime, joinRemote, joinLocal, quoteShellArg } = loadTs(path.join(__dirname, 'fsFormat.ts'))

test('byte sizes keep the unit boundaries the file panels already used', () => {
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(1023), '1023 B')
  assert.equal(fmtBytes(1024), '1.0 KB')
  assert.equal(fmtBytes(1536), '1.5 KB')
  assert.equal(fmtBytes(1 << 20), '1.0 MB')
  assert.equal(fmtBytes(1 << 30), '1.0 GB')
})

test('mtimes render as a local year-month-day hour:minute', () => {
  // 用本地时间构造，避免用例依赖运行机器的时区。
  const at = new Date(2026, 10, 6, 14, 57, 41)
  assert.equal(fmtMtime(at.toISOString()), '2026-11-06 14:57')
  assert.equal(fmtMtime(''), '', '空时间不编造日期')
  assert.equal(fmtMtime('not-a-date'), 'not-a-date', '解析不了就原样显示（截断到 16 字符）')
  assert.equal(fmtMtime('not-a-date-but-rather-long-value'), 'not-a-date-but-r')
})

test('remote paths join without turning the home shorthand into a relative path', () => {
  assert.equal(joinRemote('/var/log', 'syslog'), '/var/log/syslog')
  assert.equal(joinRemote('/var/log/', 'syslog'), '/var/log/syslog', '多余的斜杠要收掉')
  assert.equal(joinRemote('.', 'x.txt'), 'x.txt', '`.` 是后端的 home 简写，不能拼成 `./x.txt`')
  assert.equal(joinRemote('', 'x.txt'), 'x.txt')
  assert.equal(joinRemote('/', 'etc'), '/etc', '根目录不能拼成 //etc')
})

test('local paths join with the separator the folder already uses', () => {
  assert.equal(joinLocal('/home/me', 'x.txt'), '/home/me/x.txt')
  assert.equal(joinLocal('/home/me/', 'x.txt'), '/home/me/x.txt')
  assert.equal(joinLocal('D:\\drops', 'x.txt'), 'D:\\drops\\x.txt', 'Windows 目录下不能混出 D:\\drops/x.txt')
  assert.equal(joinLocal('', 'x.txt'), 'x.txt')
})

test('shell arguments are quoted so remote paths survive word splitting', () => {
  assert.equal(quoteShellArg('/opt/tomcat'), "'/opt/tomcat'")
  assert.equal(quoteShellArg('/var/my logs'), "'/var/my logs'", '带空格的目录不能被拆成两条参数')
  // 单引号内部无法转义自身：按 POSIX 的写法断开再拼接。
  assert.equal(quoteShellArg("/it's/here"), "'/it'\\''s/here'")
  assert.equal(quoteShellArg('$(rm -rf /)'), "'$(rm -rf /)'", '命令替换必须留在引号里，到了远端也只是字面量')
})
