// Real React + AntD against the production bundle, using a deterministic host bridge.
// Run after building: node scripts/ui-smoke.mjs
// UI_ASSET_ROOT can point to frontend/ extracted from the final release archive.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const dist = process.env.UI_ASSET_ROOT ? path.resolve(process.env.UI_ASSET_ROOT) : path.join(root, 'frontend', 'dist')
await fs.access(path.join(dist, 'index.html'))
const errors = []
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return }
    const relative = url.pathname === '/' ? 'index.html'
      : decodeURIComponent(url.pathname).replace(/^\/plugin-assets\/frontend\//, '')
    const file = path.resolve(dist, relative)
    if (!file.startsWith(dist + path.sep)) throw new Error('outside asset directory')
    const content = await fs.readFile(file)
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream')
    res.end(content)
  } catch {
    res.writeHead(404).end('Not found')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const executablePath = process.env.UI_BROWSER || (process.platform === 'win32' && existsSync(edge) ? edge : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('requestfailed', r => errors.push(`${r.url()}: ${r.failure()?.errorText}`))
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`) })
  await page.addInitScript(() => {
    const files = { '/smoke.conf': 'first original', '/next.conf': 'second original' }
    const writes = []
    const previews = new Map()
    window.__uiTest = {
      writes,
      releasePreview(path) { const resolve = previews.get(path); if (!resolve) throw new Error('No pending preview'); previews.delete(path); resolve({ dataBase64: btoa(files[path]) }) },
    }
    window.gonaviHostPrefs = { locale: 'en-US', theme: 'light' }
    window.gonaviPlugin = {
      ready: Promise.resolve({ pluginId: 'gh-autumnnazi.ssh' }),
      close: async () => {},
      async invoke(command, args = {}) {
        switch (command) {
          case 'session.teardown': return { interrupted: 0 }
          case 'profile.list': return { profiles: [{ id: 'fixture', name: 'Fixture server', host: 'fixture.invalid', port: 22, user: 'test', authMethod: 'none' }] }
          case 'conn.status': return { connections: [{ connectionId: 'fixture-connection', profileId: 'fixture', state: 'ready', alive: true }] }
          case 'settings.get': return { settings: { readOnly: false, sudoAllowlist: [], quickCommands: [], historyLimit: 500 } }
          case 'transfer.list': return { tasks: [] }
          case 'knownHosts.list': return { entries: [] }
          case 'fs.listLocal': return { entries: [], home: '/local' }
          case 'sftp.pwd': return { path: '/' }
          case 'sftp.list': return { entries: Object.keys(files).map(path => ({ path, name: path.slice(1), size: files[path].length, mode: '-rw-------', isDir: false, isLink: false, mtime: '2026-01-01T00:00:00Z' })), more: false, path: '/' }
          case 'sftp.preview': return new Promise(resolve => previews.set(args.path, resolve))
          case 'sftp.writeFile': files[args.path] = atob(args.dataBase64); writes.push({ path: args.path, content: files[args.path] }); return {}
          default: throw new Error(`Unexpected bridge command: ${command}`)
        }
      },
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' })
  assert.ok(await page.locator('#root > *').count(), 'React root is empty')
  const output = path.join(root, 'output', 'playwright')
  await fs.mkdir(output, { recursive: true })
  // These interactions distinguish the redesigned UI from the old, otherwise working bundle.
  const search = page.getByRole('textbox', { name: 'Search connections', exact: true })
  assert.equal(await search.count(), 1, 'The redesigned connection search is missing; stale frontend bundle')
  await search.fill('no-such-server')
  await page.getByText('No matching connections', { exact: true }).waitFor({ state: 'visible' })
  await search.fill('')
  await page.getByRole('button', { name: 'Connect Fixture server', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Hide connections', exact: true }).click()
  assert.equal(await page.locator('#connection-sidebar').isVisible(), false, 'Connection sidebar did not collapse')
  await page.getByRole('button', { name: 'Show connections', exact: true }).click()
  assert.equal(await page.locator('#connection-sidebar').isVisible(), true, 'Connection sidebar did not reopen')
  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  assert.equal(await page.locator('.settings-nav button').count(), 4, 'The redesigned settings navigation is missing')
  await page.locator('.settings-nav').getByRole('button', { name: 'Agent security', exact: true }).click()
  await page.locator('#settings-security').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#settings-terminal').isVisible(), false, 'Settings sections did not switch')
  await page.screenshot({ path: path.join(output, 'ui-settings.png') })
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  assert.equal(await page.locator('.file-columns').count(), 2, 'The redesigned file columns are missing')
  for (const [name, content] of [['smoke.conf', 'first edited'], ['next.conf', 'second edited']]) {
    await page.getByText(name, { exact: true }).dblclick()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isEnabled(), false, 'Save is enabled before preview has loaded')
    await page.evaluate(path => window.__uiTest.releasePreview(path), `/${name}`)
    await page.waitForFunction(() => !document.querySelector('.ant-modal-footer .ant-btn-primary')?.disabled)
    await dialog.locator('textarea').fill(content)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(await page.evaluate(() => window.__uiTest.writes), [
    { path: '/smoke.conf', content: 'first edited' }, { path: '/next.conf', content: 'second edited' },
  ])
  if (process.argv.includes('--inject-page-error')) {
    await page.evaluate(() => { setTimeout(() => { throw new Error('intentional smoke failure') }, 0) })
    await page.waitForFunction(() => !!document.getElementById('__fatal'))
  }
  assert.equal(await page.locator('#__fatal').count(), 0, 'Fatal error overlay appeared')
  assert.deepEqual(errors, [], 'Browser errors were reported')
  await page.screenshot({ path: path.join(output, 'ui-smoke.png') })
  console.log(`UI smoke passed (${dist}): redesigned search/sidebar/settings/file columns, loading guard, two consecutive saves, no browser errors.`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
