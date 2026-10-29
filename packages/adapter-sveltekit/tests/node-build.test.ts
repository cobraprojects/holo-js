import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(workspaceRoot, 'apps/blog-sveltekit/package.json'))
const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(workspaceRoot, '.holo-node-'))
  await symlink(join(workspaceRoot, 'apps/blog-sveltekit/node_modules'), join(root, 'node_modules'), 'dir')
  const files = {
    'package.json': JSON.stringify({ type: 'module' }),
    'src/app.html': '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>',
    'src/routes/always/+page.js': "export const prerender = true; export const trailingSlash = 'always'",
    'src/routes/always/+page.svelte': '<h1>Always</h1>',
    'src/routes/never/+page.js': "export const prerender = true; export const trailingSlash = 'never'",
    'src/routes/never/+page.svelte': '<h1>Never</h1>',
    'src/routes/events/+server.js': `export function GET() {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: connected\\n\\n')) },
  }), { headers: { 'content-type': 'text/event-stream' } })
}`,
    'static/robots.txt': 'User-agent: *',
    'vite.config.js': `import adapter from '@holo-js/adapter-sveltekit/node'
import { sveltekit } from '@sveltejs/kit/vite'
export default { plugins: [sveltekit({ adapter: adapter(), paths: { base: '/app' } })] }
`,
  }
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }))
  await execute(process.execPath, [vite, 'build', '--logLevel', 'error'], { cwd: root })
  await rm(join(root, '.svelte-kit'), { recursive: true, force: true })
}, 60_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

async function runServer(script: string): Promise<string> {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
process.env.PORT = '0'
process.env.HOST = '127.0.0.1'
const { server } = await import('./build/index.js')
const origin = 'http://127.0.0.1:' + server.address().port
try {
${script}
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
`], { cwd: root, timeout: 35_000, killSignal: 'SIGKILL' })
  return stdout.trim().split('\n').at(-1) ?? ''
}

describe('built SvelteKit Node server', () => {
  it('redirects prerendered pages to their canonical trailing-slash URLs', async () => {
    const result = await runServer(`
const responses = []
for (const path of ['/app/always?value=1', '/app/always/', '/app/never/?value=2', '/app/never']) {
  const response = await fetch(origin + path, { redirect: 'manual' })
  responses.push({ status: response.status, location: response.headers.get('location') })
  await response.text()
}
console.log(JSON.stringify(responses))
`)
    expect(JSON.parse(result)).toEqual([
      { status: 308, location: '/app/always/?value=1' },
      { status: 200, location: null },
      { status: 308, location: '/app/never?value=2' },
      { status: 200, location: null },
    ])
  })

  it('caches hashed client assets immutably without caching pages or ordinary static files', async () => {
    const result = await runServer(`
const page = await fetch(origin + '/app/always/')
const html = await page.text()
const assetPath = html.split('"').find(value => value.includes('_app/immutable/'))
if (!assetPath) throw new Error('The page must reference a hashed client asset')
const asset = await fetch(new URL(assetPath, origin + '/app/always/'))
await asset.arrayBuffer()
const staticFile = await fetch(origin + '/app/robots.txt')
await staticFile.text()
console.log(JSON.stringify({
  assetStatus: asset.status,
  asset: asset.headers.get('cache-control'),
  page: page.headers.get('cache-control'),
  staticFile: staticFile.headers.get('cache-control'),
}))
`)
    expect(JSON.parse(result)).toEqual({
      assetStatus: 200,
      asset: 'public,max-age=31536000,immutable',
      page: null,
      staticFile: null,
    })
  })

  it('completes framework shutdown after SIGTERM even with an active event stream', async () => {
    const result = await runServer(`
const stream = await fetch(origin + '/app/events')
if (stream.headers.get('content-type') !== 'text/event-stream') throw new Error('Expected an event stream')
await stream.body.getReader().read()
const shutdown = new Promise(resolve => process.once('sveltekit:shutdown', resolve))
process.kill(process.pid, 'SIGTERM')
await shutdown
console.log('shutdown complete')
`)
    expect(result).toBe('shutdown complete')
  }, 40_000)
})
