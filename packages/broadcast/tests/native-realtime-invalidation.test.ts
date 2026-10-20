import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { configureDB, createConnectionManager, createDatabase, createDialect, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { startRedisService } from '../../session/tests/support/redis'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../src'
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

async function writeFromAnotherProcess(filename: string, score: number, redisPort: number): Promise<void> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--conditions=@holo-js/source',
    fileURLToPath(new URL('./support/invalidation-writer.ts', import.meta.url)),
    filename,
    String(score),
    String(redisPort),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childErrors = ''
  child.stderr.on('data', chunk => { childErrors += String(chunk) })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(childErrors || `Invalidation writer exited with ${String(code)}`)
}

async function startScoresWorker(db: Awaited<ReturnType<typeof openScoresDatabase>>['db'], redisPort: number, nodeId: string) {
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
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret', options: { host: '127.0.0.1', port, scheme: 'http' } } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({
      default: 'shared',
      connections: { shared: { host: '127.0.0.1', port: redisPort } },
    }),
    nodeId,
    realtime: {
      databaseInvalidation: realtimeServerInternals.createRealtimeDatabaseInvalidationBridge(),
      query: async () => await executeRealtimeQuery(scores),
      mutate: async () => { throw new Error('No mutation is registered') },
      subscribe: async (_name, _args, options) => await subscribeRealtimeQuery(scores, {}, options),
    },
  })
  onTestFinished(() => worker.stop())
  return worker
}

it('refreshes a live query subscription when a write commits in another process through Redis scaling', async () => {
  const { db, filename } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  const worker = await startScoresWorker(db, redisPort, 'worker-a')

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

it('publishes a worker\'s own committed writes to the scaling channel for the other worker nodes', async () => {
  const { db } = await openScoresDatabase()
  const redis = await startRedisService()
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  await startScoresWorker(db, redisPort, 'worker-a')
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
