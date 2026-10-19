import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { stagePublishedPackage, symlinkPackageDependency } from '../../../tests/support/published-package'

const execute = promisify(execFile)
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { readonly headers: Record<string, string> }) => WebSocket
const root = resolve(import.meta.dirname, '../../..')

it('reports an actionable install hint when the real CLI cannot resolve the broadcast package', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-native-broadcast-installation-'))
  try {
    await mkdir(join(projectRoot, 'config'), { recursive: true })
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(projectRoot, 'config/broadcast.mjs'), "export default { default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main', secret: 'secret' } } }")
    await stagePublishedPackage(join(root, 'packages/cli'), join(projectRoot, 'node_modules/@holo-js/cli'), join(root, 'packages/cli/dist'))
    const result = await execute(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('@holo-js/broadcast'), { code: 'MODULE_NOT_FOUND' })
const result = spawnSync(process.execPath, ['./node_modules/@holo-js/cli/dist/bin/holo.mjs', 'broadcast:work'], { encoding: 'utf8', timeout: 10000 })
assert.equal(result.error, undefined)
assert.notEqual(result.status, 0)
assert.match(result.stderr, /Unable to load @holo-js\\/broadcast/)
assert.match(result.stderr, /holo install broadcast/)
console.log('Native broadcast installation behavior passed')
`], { cwd: projectRoot })
    expect(result.stdout).toContain('Native broadcast installation behavior passed')
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}, 30000)

it('refreshes prepared channel discovery and authorizes fresh private subscriptions with the authenticated user through the real CLI worker', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-native-broadcast-lifecycle-'))
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Expected a native worker port')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  let worker: ReturnType<typeof spawn> | undefined
  const sockets: WebSocket[] = []
  try {
    await mkdir(join(projectRoot, 'config'), { recursive: true })
    await mkdir(join(projectRoot, 'server/channels'), { recursive: true })
    await writeFile(join(projectRoot, '.npmrc'), 'registry=http://127.0.0.1:1\nfetch-retries=0\n')
    for (const name of ['cli', 'broadcast', 'db-sqlite', 'flux', 'auth', 'session']) {
      await stagePublishedPackage(join(root, 'packages', name), join(projectRoot, 'node_modules/@holo-js', name), join(root, 'packages', name, 'dist'))
    }
    const packagesRoot = join(projectRoot, 'packages')
    await rename(join(projectRoot, 'node_modules/@holo-js'), packagesRoot)
    for (const name of await readdir(packagesRoot)) {
      const packageRoot = join(packagesRoot, name)
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name: string, version: string }
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.0-lifecycle-local' }))
      await symlinkPackageDependency(join(projectRoot, 'node_modules'), manifest.name, packageRoot)
    }
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: Object.fromEntries(['cli', 'broadcast', 'core', 'kernel', 'db-sqlite', 'flux'].map(name => [`@holo-js/${name}`, 'workspace:*'])),
    }))
    await mkdir(join(projectRoot, 'server/models'), { recursive: true })
    await mkdir(join(projectRoot, 'storage'), { recursive: true })
    await writeFile(join(projectRoot, 'config/app.ts'), "export default { name: 'Broadcast Lifecycle', key: 'test-key' }")
    await writeFile(join(projectRoot, 'config/database.ts'), "export default { defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: './storage/database.sqlite' } } }")
    await writeFile(join(projectRoot, 'server/models/User.ts'), "import { column, defineGeneratedTable, defineModel } from '@holo-js/db'; export default defineModel(defineGeneratedTable('users', { id: column.integer().primaryKey(), email: column.string() }), { timestamps: false, fillable: ['email'] })")
    await writeFile(join(projectRoot, 'config/broadcast.ts'), `import { defineBroadcastConfig } from '@holo-js/broadcast'; export default defineBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'key', secret: 'secret' } }, worker: { host: '127.0.0.1', port: ${address.port} } })`)
    const cli = join(projectRoot, 'node_modules/@holo-js/cli/dist/bin/holo.mjs')
    await writeFile(join(projectRoot, 'server/channels/old.ts'), "import { defineChannel } from '@holo-js/broadcast'; export default defineChannel('old.{id}', { type: 'private', authorize() { return false } })")
    await execute(process.execPath, [cli, 'prepare'], { cwd: projectRoot })
    await writeFile(join(projectRoot, 'config/auth.ts'), "export default { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' } }, providers: { users: { model: 'User' } } }")
    await writeFile(join(projectRoot, 'config/session.ts'), "export default { driver: 'file', stores: { file: { driver: 'file', path: './storage/sessions' } } }")
    await rm(join(projectRoot, 'server/channels/old.ts'))
    await writeFile(join(projectRoot, 'server/channels/fresh.ts'), "import { defineChannel } from '@holo-js/broadcast'; export default defineChannel('fresh.{id}', { type: 'private', authorize(user, params) { return user?.email === 'native@example.com' && params.id === '42' } })")
    const login = await execute(process.execPath, ['--input-type=module', '--eval', `
import { initializeHolo } from '@holo-js/core'
const runtime = await initializeHolo(process.cwd())
const { DB, createSchemaService } = await import('@holo-js/db')
const { default: auth } = await import('@holo-js/auth')
const schema = createSchemaService(DB.connection())
await schema.createTable('users', table => { table.integer('id').primaryKey(); table.string('email') })
await schema.createTable('auth_session_revocations', table => { table.string('provider'); table.string('user_id'); table.integer('generation').default(0); table.string('retained_session_id').nullable(); table.unique(['provider', 'user_id']) })
await DB.table('users').insert({ id: 1, email: 'native@example.com' })
const { sessionCookie } = await import('@holo-js/session')
const result = await runtime.runWithAuthRequestAccessors({ appendResponseCookie: () => undefined }, () => auth.loginUsingId(1))
const cookie = sessionCookie(result.sessionId).split(';', 1)[0]
await runtime.shutdown()
console.log(JSON.stringify({ cookie }))
`], { cwd: projectRoot })
    const { cookie } = JSON.parse(login.stdout.trim().split('\n').at(-1) ?? '{}') as { cookie: string }
    worker = spawn(process.execPath, [cli, 'broadcast:work'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    worker.stdout?.on('data', chunk => { output += String(chunk) })
    worker.stderr?.on('data', chunk => { output += String(chunk) })
    await expect.poll(() => {
      if (worker?.exitCode !== null) throw new Error(output)
      return output
    }, { timeout: 10000 }).toContain('[broadcast] Worker listening on')
    const connect = async (headers: Record<string, string>) => {
      const socket = new NodeWebSocket(`ws://127.0.0.1:${address.port}/app/key`, { headers })
      sockets.push(socket)
      const packets: Array<{ event: string, channel?: string, data?: string }> = []
      socket.addEventListener('message', message => { packets.push(JSON.parse(String(message.data)) as { event: string, channel?: string, data?: string }) })
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('Native worker connection failed')), { once: true })
      })
      socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-fresh.42' } }))
      return { socket, packets }
    }
    const guest = await connect({})
    await expect.poll(() => guest.packets.find(packet => packet.event === 'pusher:subscription_error' && packet.channel === 'private-fresh.42')?.data, { timeout: 10000 })
      .toBe(JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 403 }))
    expect(guest.socket.readyState).toBe(WebSocket.OPEN)
    expect(cookie.startsWith('holo_session=')).toBe(true)
    const member = await connect({ cookie })
    await expect.poll(() => member.packets.some(packet => packet.event === 'pusher_internal:subscription_succeeded' && packet.channel === 'private-fresh.42'), { timeout: 10000 }).toBe(true)
    expect(guest.packets.some(packet => packet.event === 'pusher_internal:subscription_succeeded')).toBe(false)
    const closed = once(worker, 'close')
    for (const socket of sockets) socket.close()
    worker.kill('SIGINT')
    const [code] = await closed
    if (process.platform !== 'win32') expect(code, output).toBe(0)
    await expect(fetch(`http://127.0.0.1:${address.port}/health`)).rejects.toThrow()
  } finally {
    for (const socket of sockets) socket.close()
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const closed = once(worker, 'close')
      worker.kill('SIGKILL')
      await closed
    }
    await rm(projectRoot, { recursive: true, force: true })
  }
}, 30000)
