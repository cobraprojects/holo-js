import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import adapter from '../src/node'

const execute = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(workspaceRoot, 'apps/blog-sveltekit/package.json'))
const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')

async function buildOriginResponses(canonicalOrigin?: string, out = 'build'): Promise<number[]> {
  const root = await mkdtemp(join(workspaceRoot, '.holo-origin-'))
  try {
    await symlink(join(workspaceRoot, 'apps/blog-sveltekit/node_modules'), join(root, 'node_modules'), 'dir')
    await mkdir(join(root, 'src/routes'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'src/app.html'), '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>')
    await writeFile(join(root, 'src/routes/+server.js'), 'export async function POST({ request }) { await request.text(); return new Response("accepted") }')
    await writeFile(join(root, 'vite.config.js'), `
import adapter from '@holo-js/adapter-sveltekit/node'
import { sveltekit } from '@sveltejs/kit/vite'
import { withHoloSvelteKit } from ${JSON.stringify(join(workspaceRoot, 'packages/adapter-sveltekit/dist/config.mjs'))}
export default { plugins: [sveltekit(withHoloSvelteKit({ adapter: adapter({ out: ${JSON.stringify(out)} }), paths: ${JSON.stringify(canonicalOrigin ? { origin: canonicalOrigin } : {})} }))] }
`)
    await execute(process.execPath, [vite, 'build', '--logLevel', 'error'], {
      cwd: root,
      env: { ...process.env, APP_URL: 'http://127.0.0.1:43203' },
    })
    await access(join(root, out, 'index.js'))
    if (out !== 'build') await expect(access(join(root, 'build'))).rejects.toThrow()
    const responses = await Promise.all([0, 1].map(async (deployment) => {
      const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
import { createServer } from 'node:net'
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const runtimeOrigin = 'http://127.0.0.1:' + port
process.env.APP_URL = runtimeOrigin
process.env.PORT = String(port)
process.env.HOST = '127.0.0.1'
${deployment === 0 ? 'delete process.env.BODY_SIZE_LIMIT' : "process.env.BODY_SIZE_LIMIT = '2M'"}
const { server } = await import(${JSON.stringify('./' + out + '/index.js')})
const statuses = []
try {
  for (const origin of [runtimeOrigin, 'http://127.0.0.1:43203', 'https://attacker.example', 'https://canonical.example', null]) {
    const response = await fetch(runtimeOrigin, {
      method: 'POST',
      headers: {
        ...(origin ? { origin } : {}),
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      },
      body: 'value=ok',
    })
    statuses.push(response.status)
    await response.text()
  }
  const headers = { origin: ${JSON.stringify(canonicalOrigin)} ?? runtimeOrigin, 'content-type': 'application/x-www-form-urlencoded' }
  const sized = await fetch(runtimeOrigin, { method: 'POST', headers, body: 'a'.repeat(1024 * 1024) })
  if (sized.status !== ${deployment === 0 ? 413 : 200}) throw new Error('Configured body limit failed: ' + sized.status)
  await sized.text()
  const streamed = await fetch(runtimeOrigin, {
    method: 'POST', headers, duplex: 'half',
    body: new ReadableStream({ start(controller) {
      for (let index = 0; index < 3; index++) controller.enqueue(new Uint8Array(1024 * 1024))
      controller.close()
    } }),
  })
  if (streamed.status !== 413) throw new Error('Streaming body limit failed: ' + streamed.status)
  await streamed.text()
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
console.log(JSON.stringify(statuses))
`], { cwd: root, env: { ...process.env, APP_URL: 'http://127.0.0.1:43233' } })
      return JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null') as number[]
    }))
    return responses.flat()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('built SvelteKit form origin boundary', () => {
  it.each(['', '.', '..', '../outside', '/tmp/holo-output'])('rejects unsafe output directory %j', (out) => {
    expect(() => adapter({ out })).toThrow('out must name a directory inside the project')
  })

  it('refuses to replace application source with build output', async () => {
    await expect(buildOriginResponses(undefined, 'src')).rejects.toThrow('out must not overlap source or framework directories')
  }, 60_000)

  it('accepts deployment origins after building once and rejects other origins', async () => {
    expect(await buildOriginResponses()).toEqual([200, 403, 403, 403, 403, 200, 403, 403, 403, 403])
  }, 60_000)

  it('runs custom output without a default build and preserves an explicit canonical origin', async () => {
    expect(await buildOriginResponses('https://canonical.example', '.e2e/build')).toEqual([403, 403, 403, 200, 403, 403, 403, 403, 200, 403])
  }, 60_000)
})
