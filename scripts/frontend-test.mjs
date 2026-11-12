import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../frontend/', import.meta.url))
const files = readdirSync(path.join(root, 'src'), { recursive: true })
  .filter(file => file.endsWith('.test.cjs')).map(file => path.join(root, 'src', file))
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
