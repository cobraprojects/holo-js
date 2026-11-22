import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { nextBin, nextEnv } from './support/next-first-visit-app'

const repository = resolve(import.meta.dirname, '../../..')
const run = promisify(execFile)

function appFiles(root: string): Readonly<Record<string, string>> {
  const source = (path: string) => JSON.stringify(relative(root, join(repository, 'packages', path)))
  const security = source('security/src/index.ts')
  const session = source('session/src/index.ts')
  const accessor = source('core/src/portable/csrfSession.ts')
  const sessionPath = JSON.stringify(join(root, 'sessions'))
  return {
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'next.config.mjs': `import { withHolo } from ${JSON.stringify(join(repository, 'packages/adapter-next/dist/config.mjs'))}
export default withHolo({ experimental: { externalDir: true }, turbopack: { root: ${JSON.stringify(repository)} } })`,
    'security.js': `
import { configureSecurityRuntime, defineSecurityConfig } from ${security}
import * as session from ${session}
import { createCsrfSessionAccessor } from ${accessor}
session.configureSessionRuntime({
  config: session.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: ${sessionPath} } } }),
  stores: { file: session.createFileSessionStore(${sessionPath}) }, appKey: 'server-action-csrf-key',
})
configureSecurityRuntime({
  config: defineSecurityConfig({ csrf: { enabled: true } }), csrfSigningKey: 'server-action-csrf-key',
  csrfSession: createCsrfSessionAccessor(session, () => 'holo_session'),
})
`,
    'proxy.js': `
import './security.js'
import { csrfProtection } from ${source('security/src/next/server.ts')}
export const proxy = csrfProtection()
export const config = { matcher: ['/((?!_next).*)'] }
`,
    'app/layout.js': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }',
    'app/actions.js': `'use server'
export async function retire(organization) { return \`retired \${organization}\` }
`,
    'app/page.js': `import Retire from './retire.js'
export const dynamic = 'force-dynamic'
export default function Page() { return <Retire /> }`,
    'app/retire.js': `'use client'
import { useState } from 'react'
import { retire } from './actions.js'
function csrfCookie() {
  return decodeURIComponent(document.cookie.split('; ').find(entry => entry.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length) ?? '')
}
export default function Retire() {
  const [result, setResult] = useState('')
  async function submit() {
    const formData = new FormData()
    formData.set('_token', csrfCookie())
    try {
      setResult(await retire.bind(null, 'acme')(formData))
    } catch {
      setResult('refused')
    }
  }
  return <><button onClick={submit}>Retire</button><output>{result}</output></>
}`,
  }
}

async function startNext(root: string): Promise<{ readonly baseUrl: string, stop(): Promise<void> }> {
  const server = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: nextEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const baseUrl = await new Promise<string>((ready, reject) => {
    let output = ''
    const inspect = (chunk: Buffer) => {
      output += chunk.toString()
      const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output)?.[1]
      if (url) ready(url)
    }
    server.stdout.on('data', inspect)
    server.stderr.on('data', inspect)
    server.once('error', reject)
    server.once('exit', () => reject(new Error(`Next exited before readiness: ${output}`)))
  })
  return {
    baseUrl,
    async stop() {
      if (server.exitCode !== null || server.signalCode !== null) return
      const closed = new Promise<void>(done => server.once('exit', () => done()))
      server.kill('SIGTERM')
      await closed
    },
  }
}

it.each(['webpack', 'turbopack'])('accepts the CSRF token of a server action that declares no form data in native Next %s', async (compiler) => {
  const root = await mkdtemp(join(repository, '.holo-server-action-csrf-'))
  try {
    await symlink(join(repository, 'apps/blog-next/node_modules'), join(root, 'node_modules'), 'dir')
    for (const [name, content] of Object.entries(appFiles(root))) {
      const path = join(root, name)
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    await run(process.execPath, [nextBin, 'build', `--${compiler}`], { cwd: root, env: nextEnv, timeout: 120_000, maxBuffer: 8 * 1_048_576 })
    const next = await startNext(root)
    try {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(next.baseUrl)
        await page.getByRole('button', { name: 'Retire' }).click()
        await expect.poll(() => page.locator('output').textContent()).toBe('retired acme')
      } finally {
        await browser.close()
      }
    } finally {
      await next.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)
