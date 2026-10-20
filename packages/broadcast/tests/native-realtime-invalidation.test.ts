import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { configureDB, createConnectionManager, createDatabase, createDialect, queryCacheInternals, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { startRedisService } from '../../session/tests/support/redis'
import { normalizeBroadcastConfig, startBroadcastWorker, workerInternals } from '../src'
import { query } from '../../realtime/src'
import { configureRealtimeRuntime, executeRealtimeQuery, realtimeServerInternals, resetRealtimeRuntime, subscribeRealtimeQuery } from '../../realtime/src/server'

type Packet = { event: string; data: { id?: string; snapshot?: { data: { score: number } } } & Record<string, unknown> }

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No native worker port available')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function openScoresDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'holo-realtime-invalidation-'))
  const filename = join(directory, 'scores.sqlite')
  const adapter = createSQLiteAdapter({ filename })
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDB()
    resetDatabaseDependencyInvalidationListeners()
    await adapter.disconnect()
    await rm(directory, { recursive: true, force: true })
  })
  await adapter.execute('CREATE TABLE scores (id INTEGER PRIMARY KEY, score INTEGER NOT NULL)')
  await adapter.execute('INSERT INTO scores VALUES (1, 10)')
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db })
  return { db, filename }
}

async function writeFromAnotherProcess(filename: string, score: number, redisPort: number, appId = 'app'): Promise<void> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--conditions=@holo-js/source',
    fileURLToPath(new URL('./support/invalidation-writer.ts', import.meta.url)),
    filename,
    String(score),
    String(redisPort),
    appId,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childErrors = ''
  child.stderr.on('data', chunk => { childErrors += String(chunk) })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(childErrors || `Invalidation writer exited with ${String(code)}`)
}

async function startScoresWorker(
  db: Awaited<ReturnType<typeof openScoresDatabase>>['db'],
  redisPort: number,
  options: { readonly nodeId?: string, readonly appId?: string, readonly key?: string, readonly databaseInvalidation?: NonNullable<Parameters<typeof startBroadcastWorker>[0]['realtime']>['databaseInvalidation'] } = {},
) {
  const scores = query({
    name: 'scores.current',
    access: 'public',
    handler: async () => {
      const row = await db.table('scores').where('id', 1).first()
      return { score: row?.score }
    },
  })
  const port = await reservePort()
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: options.appId ?? 'app', key: options.key ?? 'key', secret: 'secret', options: { host: '127.0.0.1', port, scheme: 'http' } } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({
      default: 'shared',
      connections: { shared: { host: '127.0.0.1', port: redisPort } },
    }),
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    realtime: {
      databaseInvalidation: options.databaseInvalidation ?? realtimeServerInternals.createRealtimeDatabaseInvalidationBridge(),
      query: async () => await executeRealtimeQuery(scores),
      mutate: async () => { throw new Error('No mutation is registered') },
      subscribe: async (_name, _args, options) => await subscribeRealtimeQuery(scores, {}, options),
    },
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await worker.stop()
  }
  onTestFinished(stop)
  return { ...worker, stop }
}

it('refreshes a live query subscription when a write commits in another process through Redis scaling', async () => {
  const { db, filename } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const worker = await startScoresWorker(db, redisPort, { nodeId: 'worker-a' })

  const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/key`)
  onTestFinished(() => socket.terminate())
  const packets: Packet[] = []
  socket.on('message', data => {
    const packet = JSON.parse(data.toString())
    packets.push({ ...packet, data: typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data })
  })
  await once(socket, 'open')
  await expect.poll(() => packets.some(packet => packet.event === 'pusher:connection_established')).toBe(true)
  socket.send(JSON.stringify({ event: 'holo:realtime', data: { id: 'subscription', action: 'subscribe', name: 'scores.current', args: {} } }))
  await expect.poll(() => packets.find(packet => packet.data.id === 'subscription')?.data.snapshot?.data.score).toBe(10)

  await writeFromAnotherProcess(filename, 42, redisPort)

  await expect.poll(() => packets.some(packet => packet.data.id === 'subscription' && packet.event === 'holo:realtime:snapshot' && packet.data.snapshot?.data.score === 42), { timeout: 10_000 }).toBe(true)
}, 30_000)

it('keeps a written column value off the scaling channel while the subscription still refreshes to it', async () => {
  const { db, filename } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const worker = await startScoresWorker(db, redisPort, { nodeId: 'worker-a' })
  const invalidations = await subscribeToScalingEvents(redis)
  const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/key`)
  onTestFinished(() => socket.terminate())
  const packets: Packet[] = []
  socket.on('message', data => {
    const packet = JSON.parse(data.toString())
    packets.push({ ...packet, data: typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data })
  })
  await once(socket, 'open')
  await expect.poll(() => packets.some(packet => packet.event === 'pusher:connection_established')).toBe(true)
  socket.send(JSON.stringify({ event: 'holo:realtime', data: { id: 'subscription', action: 'subscribe', name: 'scores.current', args: {} } }))
  await expect.poll(() => packets.find(packet => packet.data.id === 'subscription')?.data.snapshot?.data.score).toBe(10)

  await writeFromAnotherProcess(filename, 4242, redisPort)

  await expect.poll(() => packets.some(packet => packet.data.id === 'subscription' && packet.event === 'holo:realtime:snapshot' && packet.data.snapshot?.data.score === 4242), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => invalidations.length).toBeGreaterThan(0)
  expect(JSON.stringify(invalidations)).not.toContain('4242')
}, 30_000)

it('publishes a worker\'s own committed writes to the scaling channel for the other worker nodes', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  await startScoresWorker(db, redisPort, { nodeId: 'worker-a' })
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const subscriber = client.duplicate()
  onTestFinished(() => subscriber.disconnect())
  const messages: string[] = []
  subscriber.on('message', (_channel: string, message: string) => { messages.push(message) })
  await subscriber.subscribe('holo:broadcast:scaling:shared:events')

  await db.table('scores').where('id', 1).update({ score: 7 })

  await expect.poll(() => messages.map(message => JSON.parse(message) as { type: string, originNodeId: string, invalidation: { connectionName: string, dependencies: string[] } }).find(message => message.type === 'database-invalidation')).toMatchObject({
    originNodeId: 'worker-a',
    invalidation: { connectionName: 'main', dependencies: expect.arrayContaining(['db:main:scores']) },
  })
  expect(messages.join('\n')).not.toContain('contextId')
}, 30_000)

it('publishes one invalidation per mutation and does not refresh from its own write when the app sender and the worker share a process', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const config = normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
    worker: { host: '127.0.0.1', port: 1, scaling: { driver: 'redis', connection: 'shared' } },
  })
  const redisConfig = normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort } } })
  const sender = workerInternals.createScalingInvalidationSender({
    config: config.worker.scaling as Exclude<typeof config.worker.scaling, false>,
    redis: redisConfig,
    appId: 'app',
  })
  const unsubscribeSender = queryCacheInternals.onDatabaseDependencyInvalidationPublished(sender.publish)
  onTestFinished(async () => {
    unsubscribeSender()
    await sender.close()
  })
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const received: unknown[] = []
  await startScoresWorker(db, redisPort, {
    databaseInvalidation: {
      connect: bridge.connect,
      receive: async invalidation => {
        received.push(invalidation)
        await bridge.receive(invalidation)
      },
    },
  })
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const subscriber = client.duplicate()
  onTestFinished(() => subscriber.disconnect())
  const messages: string[] = []
  subscriber.on('message', (_channel: string, message: string) => { messages.push(message) })
  await subscriber.subscribe('holo:broadcast:scaling:shared:events')

  await db.table('scores').where('id', 1).update({ score: 7 })

  await expect.poll(() => messages.filter(message => JSON.parse(message).type === 'database-invalidation').length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(messages.filter(message => JSON.parse(message).type === 'database-invalidation')).toHaveLength(1)
  expect(received).toEqual([])
}, 30_000)

async function subscribeToScalingEvents(redis: Awaited<ReturnType<typeof startRedisService>>) {
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const subscriber = client.duplicate()
  onTestFinished(() => subscriber.disconnect())
  const invalidations: unknown[] = []
  subscriber.on('message', (_channel: string, message: string) => {
    const parsed = JSON.parse(message) as { type: string, invalidation?: unknown }
    if (parsed.type === 'database-invalidation') invalidations.push(parsed.invalidation)
  })
  await subscriber.subscribe('holo:broadcast:scaling:shared:events')
  return invalidations
}

function createScalingSender(redisPort: number) {
  const config = normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
    worker: { host: '127.0.0.1', port: 1, scaling: { driver: 'redis', connection: 'shared' } },
  })
  const sender = workerInternals.createScalingInvalidationSender({
    config: config.worker.scaling as Exclude<typeof config.worker.scaling, false>,
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort } } }),
    appId: 'app',
  })
  onTestFinished(() => sender.close())
  return sender
}

it('keeps publishing once per mutation after the worker stops when the app sender was registered before the worker started', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const sender = createScalingSender(redisPort)
  const unsubscribeSender = queryCacheInternals.onDatabaseDependencyInvalidationPublished(sender.publish)
  onTestFinished(unsubscribeSender)
  const worker = await startScoresWorker(db, redisPort)
  const invalidations = await subscribeToScalingEvents(redis)

  await worker.stop()
  await db.table('scores').where('id', 1).update({ score: 8 })

  await expect.poll(() => invalidations.length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(invalidations).toHaveLength(1)
}, 30_000)

it('publishes once per mutation when the worker starts first and the app sender is registered after it, and keeps publishing after the worker stops', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const worker = await startScoresWorker(db, redisPort)
  const invalidations = await subscribeToScalingEvents(redis)
  const sender = createScalingSender(redisPort)
  const unsubscribeSender = queryCacheInternals.onDatabaseDependencyInvalidationPublished(sender.publish)
  onTestFinished(unsubscribeSender)

  await db.table('scores').where('id', 1).update({ score: 8 })
  await expect.poll(() => invalidations.length).toBe(1)
  await worker.stop()
  await db.table('scores').where('id', 1).update({ score: 9 })

  await expect.poll(() => invalidations.length).toBe(2)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(invalidations).toHaveLength(2)
}, 30_000)

it('leaves no publisher registered and no Redis connection open when the worker cannot bind its port', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const connections = async () => String(await client.client('LIST')).trim().split('\n').length
  const baseline = await connections()
  const occupant = createServer()
  await new Promise<void>(resolve => occupant.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>(resolve => occupant.close(() => resolve())))
  const address = occupant.address()
  if (!address || typeof address === 'string') throw new Error('No occupied port available')
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await expect(startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret', options: { host: '127.0.0.1', port: address.port, scheme: 'http' } } },
      worker: { host: '127.0.0.1', port: address.port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort } } }),
    realtime: {
      databaseInvalidation: bridge,
      query: async () => { throw new Error('No query is registered') },
      mutate: async () => { throw new Error('No mutation is registered') },
      subscribe: async () => { throw new Error('No subscription is registered') },
    },
  })).rejects.toThrow()

  expect(queryCacheInternals.hasDatabaseDependencyInvalidationPublisher()).toBe(false)
  await expect.poll(connections).toBe(baseline)
  void db
}, 30_000)

it('leaves no publisher registered and no Redis connection open when the Node websocket server constructor throws', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const connections = async () => String(await client.client('LIST')).trim().split('\n').length
  const baseline = await connections()
  const port = await reservePort()
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await expect(startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret', options: { host: '127.0.0.1', port, scheme: 'http' } } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort } } }),
    loadWebSocketModule: async () => ({
      WebSocketServer: class {
        constructor() {
          throw new Error('websocket server constructor failed')
        }
      },
    }),
    realtime: {
      databaseInvalidation: bridge,
      query: async () => { throw new Error('No query is registered') },
      mutate: async () => { throw new Error('No mutation is registered') },
      subscribe: async () => { throw new Error('No subscription is registered') },
    },
  })).rejects.toThrow('websocket server constructor failed')

  expect(queryCacheInternals.hasDatabaseDependencyInvalidationPublisher()).toBe(false)
  await expect.poll(connections).toBe(baseline)
  void db
}, 30_000)

it('holds one Redis connection for a publish-only scaling adapter and a second one once it subscribes', async () => {
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const client = redis.clients[0]
  if (!client) throw new Error('No native Redis client available')
  const connections = async () => String(await client.client('LIST')).trim().split('\n').length
  const baseline = await connections()
  const publisher = await workerInternals.createRedisScalingAdapter({ host: '127.0.0.1', port: redisPort, db: 0 })
  onTestFinished(() => publisher.close())

  await publisher.publish('holo:broadcast:scaling:shared:events', '{}')
  await expect.poll(connections).toBe(baseline + 1)

  const subscriber = await workerInternals.createRedisScalingAdapter({ host: '127.0.0.1', port: redisPort, db: 0 })
  onTestFinished(() => subscriber.close())
  await subscriber.subscribe('holo:broadcast:scaling:shared:events', () => undefined)
  await expect.poll(connections).toBe(baseline + 3)
  await subscriber.close()
  await publisher.close()
  await expect.poll(connections).toBe(baseline)
}, 30_000)

async function startScopedWorkerProcess(filename: string, redisPort: number, appId: string, key: string): Promise<{ readonly host: string, readonly port: number }> {
  const port = await reservePort()
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--conditions=@holo-js/source',
    fileURLToPath(new URL('./support/scoped-worker.ts', import.meta.url)),
    filename,
    String(redisPort),
    String(port),
    appId,
    key,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  onTestFinished(() => { child.kill('SIGKILL') })
  let childErrors = ''
  child.stderr.on('data', chunk => { childErrors += String(chunk) })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(() => lines.close())
  const readiness = await Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    once(child, 'exit').then(() => { throw new Error(childErrors || 'Scoped worker exited before startup') }),
  ])
  if (readiness !== 'ready') throw new Error(`Unexpected scoped worker output: ${readiness}`)
  return { host: '127.0.0.1', port }
}

async function connectScoresSubscriber(host: string, port: number, key: string) {
  const socket = new WebSocket(`ws://${host}:${port}/app/${key}`)
  onTestFinished(() => socket.terminate())
  const packets: Packet[] = []
  socket.on('message', data => {
    const packet = JSON.parse(data.toString())
    packets.push({ ...packet, data: typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data })
  })
  await once(socket, 'open')
  await expect.poll(() => packets.some(packet => packet.event === 'pusher:connection_established')).toBe(true)
  socket.send(JSON.stringify({ event: 'holo:realtime', data: { id: 'subscription', action: 'subscribe', name: 'scores.current', args: {} } }))
  await expect.poll(() => packets.find(packet => packet.data.id === 'subscription')?.data.snapshot?.data.score).toBe(10)
  return {
    hasScore: (score: number) => packets.some(packet => packet.data.id === 'subscription' && packet.event === 'holo:realtime:snapshot' && packet.data.snapshot?.data.score === score),
  }
}

it('refreshes only the subscriptions of the writing app when two apps share one Redis connection name', async () => {
  const { db, filename } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const appA = await startScoresWorker(db, redisPort, { nodeId: 'worker-a2', appId: 'app-a', key: 'key-a' })
  const appB = await startScopedWorkerProcess(filename, redisPort, 'app-b', 'key-b')
  const subscriberA = await connectScoresSubscriber(appA.host, appA.port, 'key-a')
  const subscriberB = await connectScoresSubscriber(appB.host, appB.port, 'key-b')

  await writeFromAnotherProcess(filename, 42, redisPort, 'app-a')

  await expect.poll(() => subscriberA.hasScore(42), { timeout: 10_000 }).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 1_500))
  expect(subscriberB.hasScore(42)).toBe(false)
}, 60_000)
