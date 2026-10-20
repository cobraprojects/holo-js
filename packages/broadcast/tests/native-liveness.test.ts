import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import { startRedisService } from '../../session/tests/support/redis'
import { defineChannel, normalizeBroadcastConfig, startBroadcastWorker } from '../src'

const HEARTBEAT_INTERVAL_MS = 30_000
const ACTIVITY_TIMEOUT_MS = 120_000

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No native worker port available')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function startLivenessWorker() {
  const port = await reservePort()
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'main-key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port, statsEnabled: true },
    }),
  })
  onTestFinished(() => worker.stop())
  return worker
}

function presenceRoster(events: ReadonlyArray<{ event: string, data: string }>): string[] {
  let members = new Set<string>()
  for (const { event, data } of events) {
    if (event === 'pusher_internal:subscription_succeeded') {
      members = new Set((JSON.parse(data) as { presence: { ids: string[] } }).presence.ids)
    }
    if (event === 'pusher_internal:member_added') members.add((JSON.parse(data) as { id: string }).id)
    if (event === 'pusher_internal:member_removed') members.delete((JSON.parse(data) as { user_id: string }).user_id)
  }
  return [...members].sort()
}

async function connectPresenceClient(port: number, user: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/app/key`, { headers: { 'x-test-user': user } })
  const events: Array<{ event: string, data: string }> = []
  socket.on('message', data => events.push(JSON.parse(data.toString())))
  onTestFinished(() => socket.terminate())
  await once(socket, 'open')
  socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-chat.1' } }))
  await expect.poll(() => events.some(event => event.event === 'pusher_internal:subscription_succeeded')).toBe(true)
  return { socket, events, roster: () => presenceRoster(events) }
}

it('pings a Node socket and terminates it when the socket stops answering within the advertised activity timeout', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const worker = await startLivenessWorker()
  const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/main-key`, { autoPong: false })
  onTestFinished(() => socket.terminate())
  const pings = once(socket, 'ping')
  await once(socket, 'open')
  const closed = once(socket, 'close')

  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
  await pings
  expect(socket.readyState).toBe(WebSocket.OPEN)

  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
  expect((await closed)[0]).toBe(1006)
  const stats = await (await fetch(`http://${worker.host}:${worker.port}/stats`)).json() as { connectionCount: number }
  expect(stats.connectionCount).toBe(0)
}, 10_000)

it('keeps a Node socket open while it answers protocol pings through the activity timeout', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const worker = await startLivenessWorker()
  const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/main-key`)
  onTestFinished(() => socket.terminate())
  await once(socket, 'open')

  for (let round = 1; round <= ACTIVITY_TIMEOUT_MS / HEARTBEAT_INTERVAL_MS; round += 1) {
    const pinged = once(socket, 'ping')
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    await pinged
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  expect(socket.readyState).toBe(WebSocket.OPEN)
  const stats = await (await fetch(`http://${worker.host}:${worker.port}/stats`)).json() as { connectionCount: number }
  expect(stats.connectionCount).toBe(1)
}, 15_000)

async function startLiveNode(nodeId: string, redisPort: number, liveness: { leaseTtlMs: number, refreshIntervalMs: number }) {
  const port = await reservePort()
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort } } }),
    nodeId,
    scalingLiveness: liveness,
    channelAuth: {
      resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }),
      definitions: [defineChannel('chat.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })],
    },
  })
  onTestFinished(() => worker.stop())
  return { port }
}

it('expires the presence members of a crashed worker process while live and duplicate members remain', async () => {
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const liveness = { leaseTtlMs: 1_000, refreshIntervalMs: 200 }
  const crashedPort = await reservePort()
  const child = spawn('bun', [
    '--conditions=@holo-js/source',
    fileURLToPath(new URL('./support/presence-worker.ts', import.meta.url)),
    'crashed-node',
    String(crashedPort),
    String(redisPort),
    String(liveness.leaseTtlMs),
    String(liveness.refreshIntervalMs),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childErrors = ''
  child.stderr.on('data', chunk => { childErrors += String(chunk) })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(async () => {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })
  const readiness = await Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    once(child, 'exit').then(() => { throw new Error(childErrors || 'Crashed-node worker exited before startup') }),
  ])
  expect(readiness).toBe('ready')

  await connectPresenceClient(crashedPort, 'crashed-user')
  await connectPresenceClient(crashedPort, 'shared-user')
  const liveNode = await startLiveNode('live-node', redisPort, liveness)
  await new Promise(resolve => setTimeout(resolve, liveness.refreshIntervalMs / 2))
  const secondNode = await startLiveNode('second-live', redisPort, liveness)
  const liveUser = await connectPresenceClient(liveNode.port, 'live-user')
  const liveDuplicate = await connectPresenceClient(secondNode.port, 'shared-user')
  await expect.poll(() => liveUser.roster()).toEqual(['crashed-user', 'live-user', 'shared-user'])
  await expect.poll(() => liveDuplicate.roster()).toEqual(['crashed-user', 'live-user', 'shared-user'])

  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited

  await expect.poll(() => liveUser.roster(), { timeout: 10_000 }).toEqual(['live-user', 'shared-user'])
  await expect.poll(() => liveDuplicate.roster(), { timeout: 10_000 }).toEqual(['live-user', 'shared-user'])
  for (const observer of [liveUser, liveDuplicate]) {
    expect(observer.events.filter(event => event.event === 'pusher_internal:member_removed').map(event => JSON.parse(event.data))).toEqual([{ user_id: 'crashed-user' }])
  }

  const late = await connectPresenceClient(liveNode.port, 'late-user')
  expect(late.roster()).toEqual(['late-user', 'live-user', 'shared-user'])
}, 30_000)

it('removes a user whose duplicate memberships on other workers have all left', async () => {
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const liveness = { leaseTtlMs: 1_000, refreshIntervalMs: 200 }
  const observerNode = await startLiveNode('observer-node', redisPort, liveness)
  const firstNode = await startLiveNode('first-node', redisPort, liveness)
  const secondNode = await startLiveNode('second-node', redisPort, liveness)
  const observer = await connectPresenceClient(observerNode.port, 'live-user')
  const first = await connectPresenceClient(firstNode.port, 'shared-user')
  const second = await connectPresenceClient(secondNode.port, 'shared-user')
  await expect.poll(() => observer.roster()).toEqual(['live-user', 'shared-user'])

  first.socket.close()
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(observer.roster()).toEqual(['live-user', 'shared-user'])

  second.socket.close()
  await expect.poll(() => observer.roster(), { timeout: 10_000 }).toEqual(['live-user'])
  expect(observer.events.filter(event => event.event === 'pusher_internal:member_removed').map(event => JSON.parse(event.data))).toEqual([{ user_id: 'shared-user' }])
}, 30_000)

