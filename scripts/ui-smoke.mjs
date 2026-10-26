// UI 渲染冒烟测试：用系统 Edge（与 WebView2 同内核）加载构建产物，
// 断言根节点挂载、无 pageerror、无 fatal 覆盖层。
// 用法：
//   cp -r frontend/dist /tmp/plugin-ui-test && 注入 mock（见 README 测试章节）
//   cd /tmp/plugin-ui-test && python -m http.server 8899 &
//   npx playwright-core 或本地安装后：node scripts/ui-smoke.mjs
// 依赖：playwright-core（不进 package.json，按需 npm i -D playwright-core）
import { chromium } from 'playwright-core'
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push('[console.error] ' + m.text().slice(0, 300)) })
page.on('pageerror', e => errors.push('[pageerror] ' + e.message + ' | ' + (e.stack || '').split('\n').slice(0, 3).join(' ')))
page.on('requestfailed', r => errors.push('[requestfailed] ' + r.url() + ' ' + (r.failure()?.errorText || '')))
await page.goto('http://127.0.0.1:8899/', { waitUntil: 'networkidle', timeout: 20000 })
await page.waitForTimeout(1500)
const probe = await page.evaluate(() => ({
  rootChildren: document.getElementById('root')?.children.length ?? -1,
  fatal: document.getElementById('__fatal')?.textContent?.slice(0, 1200) ?? null,
  bodyText: document.body.innerText.slice(0, 300),
}))
console.log(JSON.stringify({ probe, errors }, null, 1))
await page.screenshot({ path: '/tmp/plugin-ui.png' })
await browser.close()
