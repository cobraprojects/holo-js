import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../../..')

export const nextBin = createRequire(join(repository, 'apps/blog-next/package.json')).resolve('next/dist/bin/next')
export const nextEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' }

function runNextBuild(root: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [nextBin, 'build', '--webpack'], { cwd: root, env: nextEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`next build exited with ${code}.\n${output}`)))
  })
}

// Built once in global setup so the timed test only starts the production server.
export async function buildNextFirstVisitApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-next-first-visit-'))
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
  await runNextBuild(root)
  return root
}
