import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

it('uses the proxy session for the first route token and submission in native Next', async () => {
  const repository = resolve(import.meta.dirname, '../../..')
  const root = await mkdtemp(join(tmpdir(), 'holo-next-first-visit-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const requireNext = createRequire(join(repository, 'apps/blog-next/package.json'))
  await symlink(join(repository, 'apps/blog-next/node_modules'), join(root, 'node_modules'), 'dir')
  const security = JSON.stringify(join(repository, 'packages/security/src/index.ts'))
  const session = JSON.stringify(join(repository, 'packages/session/src/index.ts'))
  const accessor = JSON.stringify(join(repository, 'packages/core/src/portable/csrfSession.ts'))
  const sessionPath = JSON.stringify(join(root, 'sessions'))
  const files = {
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'next.config.mjs': 'export default { experimental: { externalDir: true } }',
    'app/page.js': 'export default function Page() { return null }',
    'app/layout.js': 'export default function Layout({ children }) { return <html><body>{children}</body></html> }',
    'security.js': `
import { configureSecurityRuntime, defineSecurityConfig } from ${security}
import * as session from ${session}
import { createCsrfSessionAccessor } from ${accessor}
session.configureSessionRuntime({
  config: session.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: ${sessionPath} } } }),
  stores: { file: session.createFileSessionStore(${sessionPath}) }, appKey: 'next-first-visit-key',
})
configureSecurityRuntime({
  config: defineSecurityConfig({ csrf: { enabled: true } }), csrfSigningKey: 'next-first-visit-key',
  csrfSession: createCsrfSessionAccessor(session, () => 'holo_session'),
})
`,
    'proxy.js': `
import './security.js'
import { csrfProtection } from ${JSON.stringify(join(repository, 'packages/security/src/next/server.ts'))}
export const proxy = csrfProtection()
export const config = { matcher: ['/api/:path*'] }
`,
    'app/api/token/route.js': `
import '../../../security.js'
import { csrf } from ${security}
export async function GET(request) { return Response.json({ token: await csrf.token(request) }) }
`,
    'app/api/submit/route.js': `
import '../../../security.js'
import { csrf } from ${security}
export async function POST(request) { await csrf.verify(request); return Response.json({ ok: true }) }
`,
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  const portServer = createServer()
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port')
  await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()))
  const server = spawn(process.execPath, [requireNext.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(address.port)], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', chunk => { output += chunk.toString() })
  server.stderr.on('data', chunk => { output += chunk.toString() })
  onTestFinished(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const closed = new Promise<void>(resolve => server.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await closed
  })
  const baseUrl = `http://127.0.0.1:${address.port}`
  // Readiness is the dev server accepting connections. An HTTP probe would also wait for the first page compile,
  // which is not part of starting the server and is not bounded by it.
  await vi.waitUntil(async () => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Next exited before it was ready')
    return acceptsConnections(address.port)
  }, { timeout: 60_000, interval: 100 }).catch(error => {
    throw new Error(`Next did not start listening: ${output}`, { cause: error })
  })
  const first = await fetch(`${baseUrl}/api/token`)
  expect(first.status, output).toBe(200)
  const payload: unknown = await first.json()
  if (!payload || typeof payload !== 'object' || !('token' in payload) || typeof payload.token !== 'string') {
    throw new Error('Expected the token endpoint response')
  }
  const cookies = first.headers.getSetCookie()
  expect(cookies.filter(cookie => cookie.startsWith('holo_session='))).toHaveLength(1)
  const submitted = await fetch(`${baseUrl}/api/submit`, {
    method: 'POST',
    headers: { cookie: cookies.map(cookie => cookie.split(';', 1)[0]).join('; '), 'X-CSRF-TOKEN': payload.token },
  })
  expect(submitted.status, output).toBe(200)
  await expect(submitted.json()).resolves.toEqual({ ok: true })
}, 120_000)
