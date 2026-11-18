import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeExampleAppBrowser, newExampleAppContext } from './example-app-browser.mjs'
import { stopExampleAppProcess } from './example-app-process.mjs'

const base = '/dashboard'
const cwd = process.cwd()
const framework = basename(cwd).replace(/^blog-/, '')
const configPatches = {
  next: ['next.config.ts', 'withHolo({', `withHolo({\n  basePath: '${base}',`],
  nuxt: ['nuxt.config.ts', "modules: ['@holo-js/adapter-nuxt'],", `modules: ['@holo-js/adapter-nuxt'],\n  app: { baseURL: '${base}/' },`],
  sveltekit: ['vite.config.ts', 'adapter: adapter(),', `adapter: adapter(),\n      paths: { base: '${base}' },`],
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(String(port)))
    })
  })
}

const port = await availablePort()
let broadcastPort = await availablePort()
while (broadcastPort === port) broadcastPort = await availablePort()
const host = framework === 'next' ? 'localhost' : '127.0.0.1'
const origin = `http://${host}:${port}`
const children = []
let output = ''

function childEnv(overrides = {}) {
  const env = { APP_ENV: 'development', ...process.env, BROADCAST_HOST: '127.0.0.1', BROADCAST_PORT: broadcastPort, APP_URL: origin, ...overrides }
  const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
  if (existsSync(runtimeSchemaPath)) {
    const preload = `--import=${pathToFileURL(runtimeSchemaPath).href}`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload
  }
  return env
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', args, { cwd, env: childEnv(), stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`bun ${args.join(' ')} exited with ${code}`)))
  })
}

function start(args, env = {}) {
  const child = spawn('bun', args, { cwd, detached: true, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk.toString()
      process.stdout.write(chunk)
    })
  }
  children.push(child)
}

async function waitUntil(check, message, timeoutMs = 60000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(message)
}

function fixtureProcessesRunning() {
  return execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' }).split('\n').some(command => command.includes(cwd) && command.includes('detached-flush'))
}

async function patchFile(file, search, replacement) {
  const path = join(cwd, file)
  const contents = await readFile(path, 'utf8')
  assert.ok(contents.includes(search), `${file} must contain ${search} to set the base path`)
  await writeFile(path, contents.replace(search, replacement))
}

async function patchBasePath() {
  await patchFile(...configPatches[framework])
  await patchFile('config/broadcast.ts', '/broadcasting/auth`', `${base}/broadcasting/auth\``)
}

function startApp() {
  if (framework === 'sveltekit') return start(['run', 'dev', '--host', '127.0.0.1', '--port', port])
  const bundlerArgs = process.env.HOLO_EXAMPLE_NEXT_BUNDLER === 'webpack' ? ['--webpack'] : []
  start(['run', 'dev', ...bundlerArgs], { PORT: port, HOST: host, NITRO_HOST: host })
}

async function signIn(context) {
  assert.equal((await context.request.get(`${base}/login`)).status(), 200)
  const token = decodeURIComponent((await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')?.value ?? '')
  assert.ok(token, 'The app must issue a CSRF token under the base path.')
  const credentials = { email: 'editor@example.com', password: 'secret-secret' }
  const response = framework === 'sveltekit'
    ? await context.request.post(`${base}/login`, { headers: { 'X-CSRF-TOKEN': token, Accept: 'text/html' }, form: { ...credentials, _token: token }, maxRedirects: 0 })
    : await context.request.post(`${base}/api/login`, { headers: { 'X-CSRF-TOKEN': token }, data: credentials })
  assert.equal(response.status(), framework === 'sveltekit' ? 303 : 200, await response.text())
}

function waitForPost(page, path, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method)
}

async function openHydrated(page, path, waitUntil = 'networkidle') {
  if (framework !== 'next') return await page.goto(path, { waitUntil })
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached' })
}

async function navigateToRealtimeDemo(page) {
  await openHydrated(page, `${base}/admin/posts`)
  if (framework !== 'sveltekit') {
    await page.getByRole('link', { name: /realtime demo/i }).click()
    return
  }
  await page.evaluate((href) => {
    const { document } = globalThis
    const link = Object.assign(document.createElement('a'), { href, textContent: 'base-path realtime demo' })
    document.body.append(link)
    link.click()
  }, `${base}/admin/posts/realtime`)
}

function watchSockets(page) {
  const received = []
  page.on('websocket', (socket) => {
    if (socket.url().includes('/app/')) socket.on('framereceived', frame => received.push(String(frame.payload)))
  })
  return received
}

async function assertClientsUseTheBasePath() {
  const context = await newExampleAppContext({ baseURL: origin })
  const requested = []
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === origin) requested.push(url.pathname)
  })
  try {
    await signIn(context)

    const admin = await context.newPage()
    const fluxSockets = watchSockets(admin)
    const fluxConfig = admin.waitForResponse(response => new URL(response.url()).pathname === `${base}/broadcasting/config`)
    const presenceAuth = waitForPost(admin, `${base}/broadcasting/auth`)
    await admin.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' })
    assert.equal((await fluxConfig).status(), 200, 'Flux must discover the broadcast config under the base path.')
    assert.equal((await presenceAuth).status(), 200, 'Flux must authorize its presence channel under the base path.')
    await waitUntil(async () => fluxSockets.length > 0, 'Flux must open its broadcast socket after discovering the config under the base path.')

    const live = await context.newPage()
    const liveFrames = watchSockets(live)
    const query = waitForPost(live, `${base}/holo/realtime/query`)
    await navigateToRealtimeDemo(live)
    assert.equal((await query).status(), 200, 'The realtime query must reach the app under the base path.')
    await live.locator('[data-post-id]').first().waitFor({ timeout: 20000 })
    await waitUntil(async () => liveFrames.some(frame => JSON.parse(frame).event === 'holo:realtime:snapshot'), 'The realtime subscription must deliver a snapshot after discovering the config under the base path.')

    const offline = await context.newPage()
    await offline.route(`**${base}/broadcasting/config`, route => route.fulfill({ status: 503, body: '' }))
    await openHydrated(offline, `${base}/admin/posts/realtime`, 'domcontentloaded')
    const post = offline.locator('[data-post-id]').first()
    await post.waitFor({ timeout: 20000 })
    await post.getByRole('button', { name: /edit title/i }).click()
    await offline.getByLabel('Realtime post title').fill(`Base path ${framework} ${Date.now()}`)
    const mutation = waitForPost(offline, `${base}/holo/realtime/mutation`)
    await offline.getByRole('button', { name: /save realtime title/i }).click()
    assert.equal((await mutation).status(), 200, 'A realtime mutation without a socket must reach the app under the base path.')

    const outsideBase = requested.filter(path => path !== base && !path.startsWith(`${base}/`) && !path.startsWith('/__nextjs_'))
    assert.deepEqual(outsideBase, [], 'No request may bypass the base path.')
  } finally {
    await context.close()
  }
}

try {
  await patchBasePath()
  await run(['run', 'setup'])
  await run(['x', 'holo', 'migrate:fresh', '--seed'])
  start(['x', 'holo', 'broadcast:work'])
  startApp()
  await waitUntil(async () => (await fetch(`${origin}${base}/`)).ok, `The ${framework} app must serve its home page under ${base}.`, 180000)
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${broadcastPort}/health`)).ok, 'The broadcast worker must start.')
  if (process.env.HOLO_EXAMPLE_NEXT_BUNDLER === 'webpack') assert.match(output, /Next\.js [\d.]+ \(webpack\)/, 'The Next dev server must run on webpack.')
  await assertClientsUseTheBasePath()
} finally {
  await closeExampleAppBrowser()
  for (const child of children) await stopExampleAppProcess(child)
  await waitUntil(async () => !fixtureProcessesRunning(), 'Next telemetry flush for this fixture must finish.', 30000)
}
