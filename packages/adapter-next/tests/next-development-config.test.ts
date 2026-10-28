import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { nextBin } from './support/next-first-visit-app'

it('loads and reloads native config files in Turbopack without dynamic resolution warnings', async () => {
  const repository = resolve(import.meta.dirname, '../../..')
  await mkdir(join(repository, '.tmp'), { recursive: true })
  const root = await mkdtemp(join(repository, '.tmp/next-config-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await symlink(join(repository, 'apps/blog-next/node_modules'), join(root, 'node_modules'), 'dir')
  const files = {
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'next.config.mjs': `import { withHolo } from '@holo-js/adapter-next/config'
export default withHolo({ turbopack: { root: ${JSON.stringify(repository)} } })`,
    'app/layout.js': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }',
    'app/page.js': `import { loadConfigDirectory } from '@holo-js/config'
export const dynamic = 'force-dynamic'
export default async function Page() {
  const loaded = await loadConfigDirectory(process.cwd(), { preferCache: false })
  return <p>{[loaded.custom.common.value, loaded.custom.esm.value, loaded.custom.typed.value].join('|')}</p>
}`,
    'config/common.cjs': "module.exports = { value: 'first' }",
    'config/esm.mjs': "export default { value: 'esm' }",
    'config/typed.ts': "const value: string = 'typescript'; export default { value }",
  }
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(resolve(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), contents)
  }
  const server = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const closed = new Promise<void>(done => server.once('exit', () => done()))
    server.kill('SIGTERM')
    await closed
  })
  let output = ''
  const baseUrl = await new Promise<string>((ready, reject) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString()
      const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output)?.[1]
      if (url && output.includes('✓ Ready')) ready(url)
    }
    server.stdout.on('data', inspect)
    server.stderr.on('data', inspect)
    server.once('error', reject)
    server.once('exit', () => reject(new Error(`Next exited before readiness:\n${output}`)))
  })
  const first = await fetch(baseUrl)
  expect(first.status, output).toBe(200)
  expect(await first.text(), output).toContain('first|esm|typescript')
  await writeFile(join(root, 'config/common.cjs'), "module.exports = { value: 'second' }")
  const second = await fetch(baseUrl)
  expect(second.status, output).toBe(200)
  expect(await second.text(), output).toContain('second|esm|typescript')
  expect(output).not.toContain("Warning: Module not found: Can't resolve <dynamic>")
}, 120_000)
