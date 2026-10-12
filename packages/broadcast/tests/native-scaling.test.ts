import { once } from 'node:events'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import { createFluxClient, fluxInternals } from '../../flux/src'
import { defineSchema, field } from '@holo-js/validation'
import { startRedisService } from '../../session/tests/support/redis'
import { defineChannel, normalizeBroadcastConfig, startBroadcastWorker } from '../src'

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No native worker port available')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function publishNativeEvent(worker: { host: string; port: number }, event: string, payload: Record<string, string>): Promise<Response> {
    const body = JSON.stringify({ name: event, channels: ['private-orders.1'], data: JSON.stringify(payload) })
    const url = new URL(`/apps/app/events`, `http://${worker.host}:${worker.port}`)
    url.searchParams.set('auth_key', 'key')
    url.searchParams.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
    url.searchParams.set('auth_version', '1.0')
    url.searchParams.set('body_md5', createHash('md5').update(body).digest('hex'))
    const query = [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&')
    url.searchParams.set('auth_signature', createHmac('sha256', 'secret').update(`POST\n${url.pathname}\n${query}`).digest('hex'))
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return response
}

it.each([
  { name: 'Redis', cluster: false, tls: false, socket: false },
  { name: 'Redis with TLS', cluster: false, tls: true, socket: false },
  { name: 'Redis Unix socket', cluster: false, tls: false, socket: true },
  { name: 'Redis Cluster', cluster: true, tls: false, socket: false },
  { name: 'Redis Cluster with TLS', cluster: true, tls: true, socket: false },
])('delivers cross-worker events, notifications, and presence through real $name', async ({ cluster, tls, socket }) => {
  const redis = await startRedisService({ cluster, tls })
  const redisPort = redis.ports[0]
  if (!redisPort) throw new Error('No native Redis port available')
  await Promise.all(redis.clients.map(client => client.acl('SETUSER', 'holo', 'on', '>native-secret', '~*', '&*', '+@all')))
  const redisConfig = normalizeRedisConfig({
    default: 'shared',
    connections: { shared: {
      ...(cluster
        ? { clusters: redis.ports.map(port => ({ url: `${tls ? 'rediss' : 'redis'}://127.0.0.1:${port}` })) }
        : socket ? { socketPath: redis.socket } : { url: `${tls ? 'rediss' : 'redis'}://127.0.0.1:${redisPort}` }),
      username: 'holo',
      password: 'native-secret',
    } },
  })
  const start = async (id: string) => {
    const port = await reservePort()
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret', options: { host: '127.0.0.1', port, scheme: 'http' } } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    })
    const worker = await startBroadcastWorker({
      config,
      redis: redisConfig,
      nodeId: id,
      channelAuth: {
        resolveUser: () => ({ id }),
        definitions: [
          defineChannel('orders.1', { type: 'private', authorize: user => Boolean(user), whispers: { typing: defineSchema({ editing: field.boolean().required() }) } }),
          defineChannel('chat.1', { type: 'presence', authorize: () => ({ id }) }),
        ],
      },
    })
    const clients: Array<{ disconnect(): Promise<void> }> = []
    const createClient = () => {
      const client = createFluxClient({
        connector: fluxInternals.createHoloWebSocketConnector({ key: 'key', host: worker.host, port: worker.port, scheme: 'http' }),
        manifest: {
          version: 1,
          generatedAt: '2026-10-12T00:00:00.000Z',
          events: [{ name: 'orders.updated', channels: [{ pattern: 'orders.1', type: 'private', params: [] }] }],
          channels: [
            { name: 'orders.1', pattern: 'orders.1', type: 'private', params: [], whispers: ['typing'] },
            { name: 'chat.1', pattern: 'chat.1', type: 'presence', params: [], whispers: [], member: { id: '' as string } },
          ],
        } as const,
      })
      clients.push(client)
      return client
    }
    const client = createClient()
    onTestFinished(async () => {
      await Promise.all(clients.map(client => client.disconnect()))
      await worker.stop()
    })
    return { worker, client, createClient }
  }
  const first = await start('first')
  const second = await start('second')
  const presenceFirst = first.client.presence('chat.1')
  const events: string[] = []
  const notifications: string[] = []
  const whispers: boolean[] = []
  second.client.private('orders.1')
    .listen('orders.updated', payload => events.push(String(payload.title)))
    .notification(payload => notifications.push(String(payload.type)))
    .listenForWhisper('typing', payload => whispers.push(payload.editing === true))
  await first.client.connect()
  await expect.poll(() => presenceFirst.members.map(member => member.id)).toEqual(['first'])
  const presenceSecond = second.client.presence('chat.1')
  await second.client.connect()
  await expect.poll(() => presenceFirst.members.map(member => member.id).sort()).toEqual(['first', 'second'])
  await expect.poll(() => presenceSecond.members.map(member => member.id).sort()).toEqual(['first', 'second'])
  const publish = async (event: string, payload: Record<string, string>) => {
    const response = await publishNativeEvent(first.worker, event, payload)
    expect(response.status, await response.text()).toBe(200)
  }
  await publish('orders.updated', { title: 'Native Redis delivery' })
  await expect.poll(() => events).toEqual(['Native Redis delivery'])
  await publish('notifications.message', { type: 'OrderShipped' })
  await expect.poll(() => notifications).toEqual(['OrderShipped'])
  await first.client.private('orders.1').whisper('typing', { editing: true })
  await expect.poll(() => whispers).toEqual([true])
  const duplicate = first.createClient()
  const duplicatePresence = duplicate.presence('chat.1')
  await duplicate.connect()
  await expect.poll(() => duplicatePresence.members.map(member => member.id).sort()).toEqual(['first', 'second'])
  presenceFirst.leaveChannel()
  await publish('orders.updated', { title: 'Membership barrier' })
  await expect.poll(() => events).toEqual(['Native Redis delivery', 'Membership barrier'])
  expect(presenceSecond.members.map(member => member.id).sort()).toEqual(['first', 'second'])
  presenceSecond.leaveChannel()
  await expect.poll(() => duplicatePresence.members.map(member => member.id)).toEqual(['first'])
}, 20000)

it('rejects a nonzero Redis Cluster database before starting a worker', () => {
  expect(() => normalizeRedisConfig({
    default: 'shared',
    connections: { shared: { clusters: [{ host: '127.0.0.1', port: 6379 }], db: 4 } },
  })).toThrow('Redis Cluster only supports database 0')
})

it('reports a real Redis publish permission failure and recovers after permissions are restored', async () => {
  const redis = await startRedisService()
  const client = redis.clients[0]
  const redisPort = redis.ports[0]
  if (!client || !redisPort) throw new Error('No native Redis instance available')
  await client.acl('SETUSER', 'publisher', 'on', '>native-secret', '~*', '&*', '+@all')
  const port = await reservePort()
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort, username: 'publisher', password: 'native-secret' } } }),
  })
  onTestFinished(() => worker.stop())
  await client.acl('SETUSER', 'publisher', '-publish')
  const rejected = await publishNativeEvent(worker, 'orders.updated', { title: 'Denied publish' })
  expect(rejected.status).toBe(500)
  expect(await rejected.text()).toMatch(/NOPERM/)
  await client.acl('SETUSER', 'publisher', '+publish')
  const restored = await publishNativeEvent(worker, 'orders.updated', { title: 'Restored publish' })
  expect(restored.status, await restored.text()).toBe(200)
}, 15000)

it('rejects worker startup when real Redis denies the scaling subscription and releases the HTTP port', async () => {
  const redis = await startRedisService()
  const client = redis.clients[0]
  const redisPort = redis.ports[0]
  if (!client || !redisPort) throw new Error('No native Redis instance available')
  await client.acl('SETUSER', 'subscriber', 'on', '>native-secret', '~*', '&*', '+@all', '-subscribe')
  const port = await reservePort()
  await expect(startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port, scaling: { driver: 'redis', connection: 'shared' } },
    }),
    redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: redisPort, username: 'subscriber', password: 'native-secret' } } }),
  })).rejects.toThrow(/NOPERM/)
  const server = createServer()
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}, 15000)
