import { createHash } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { createBroadcastWorkerRuntime, defineChannel, normalizeBroadcastConfig, workerInternals, type BroadcastChannelAuthRuntimeBindings, type BroadcastRealtimeRuntimeBindings } from '../src'

const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }

type Packet = { readonly event: string, readonly channel?: string, readonly data: string }
type Close = { readonly code?: number, readonly reason?: string }

function createRuntime(options: { realtime?: BroadcastRealtimeRuntimeBindings, channelAuth?: BroadcastChannelAuthRuntimeBindings, scaling?: Parameters<typeof createBroadcastWorkerRuntime>[0]['scaling'], now?: () => number } = {}) {
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } },
    }),
    ...options,
  })
  onTestFinished(() => runtime.close())
  return runtime
}

function connect(runtime: ReturnType<typeof createRuntime>, socketId: string, bufferedAmount: () => number = () => 0, onSend?: (payload: string) => void, closesSynchronously = false) {
  const sent: Packet[] = []
  const closes: Close[] = []
  runtime.connectWebSocket({
    socketId,
    app,
    headers: new Headers(),
    send: (payload) => {
      onSend?.(payload)
      sent.push(JSON.parse(payload) as Packet)
    },
    close: (code, reason) => {
      closes.push({ code, reason })
      if (closesSynchronously) runtime.disconnectWebSocket(socketId)
    },
    bufferedAmount,
  })
  return { sent, closes }
}

function subscribe(channel: string): string {
  return JSON.stringify({ event: 'pusher:subscribe', data: { channel } })
}

function presenceRuntime() {
  return createRuntime({
    channelAuth: {
      resolveUser: ({ socketId }) => ({ id: socketId }),
      definitions: [defineChannel('room.1', { type: 'presence', authorize: user => typeof user === 'object' && user !== null && 'id' in user ? { id: user.id } : false })],
    },
  })
}

function publishRequest(channels: readonly string[]): Request {
  const body = JSON.stringify({ name: 'news.posted', channels, data: '{}' })
  const params = new URLSearchParams({
    auth_key: 'main-key',
    auth_timestamp: String(Math.floor(Date.now() / 1000)),
    auth_version: '1.0',
    body_md5: createHash('md5').update(body).digest('hex'),
  })
  params.set('auth_signature', workerInternals.createPusherSignature('main-secret', 'POST', '/apps/main/events', params))
  return new Request(`http://worker.test/apps/main/events?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function realtimeSubscribe(id: string): string {
  return JSON.stringify({ event: 'holo:realtime', data: { id, action: 'subscribe', name: 'records.list', args: {} } })
}

it('refuses a channel subscription beyond the per-connection limit and keeps the socket open', async () => {
  const runtime = createRuntime()
  const client = connect(runtime, '1.1')
  for (let index = 0; index < 100; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', subscribe(`news.${index}`))
  }
  await runtime.receiveWebSocketMessage('1.1', subscribe('news.100'))

  expect(client.sent.filter(packet => packet.event === 'pusher:subscription_error')).toEqual([{
    event: 'pusher:subscription_error',
    channel: 'news.100',
    data: JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 429 }),
  }])
  expect(client.closes).toEqual([])
  expect(runtime.getStats()).toMatchObject({ connectionCount: 1, subscribedChannelCount: 100 })
})

it('frees a channel slot when the connection unsubscribes', async () => {
  const runtime = createRuntime()
  const client = connect(runtime, '1.1')
  for (let index = 0; index < 100; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', subscribe(`news.${index}`))
  }
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:unsubscribe', data: { channel: 'news.0' } }))
  await runtime.receiveWebSocketMessage('1.1', subscribe('news.100'))

  expect(client.sent.some(packet => packet.event === 'pusher:subscription_error')).toBe(false)
  expect(client.sent.some(packet => packet.event === 'pusher_internal:subscription_succeeded' && packet.channel === 'news.100')).toBe(true)
})

it('refuses a live-query subscription beyond the per-connection limit with a realtime error and keeps the socket open', async () => {
  const realtime: BroadcastRealtimeRuntimeBindings = {
    query: async () => { throw new Error('not used') },
    mutate: async () => { throw new Error('not used') },
    subscribe: async () => ({
      id: 'subscription',
      current: { name: 'records.list', data: {}, dependencies: [], version: 1 },
      unsubscribe() {},
    }),
  }
  const runtime = createRuntime({ realtime })
  const client = connect(runtime, '1.1')
  for (let index = 0; index < 100; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', realtimeSubscribe(`subscription-${index}`))
  }
  await runtime.receiveWebSocketMessage('1.1', realtimeSubscribe('overflow'))

  expect(client.sent.filter(packet => packet.event === 'holo:realtime:error')).toEqual([{
    event: 'holo:realtime:error',
    data: JSON.stringify({ id: 'overflow', message: 'Too many realtime subscriptions.', kind: 'runtime', status: 429 }),
  }])
  expect(client.closes).toEqual([])
  expect(runtime.getStats().connectionCount).toBe(1)
})

it('closes a connection that exceeds its message rate within one second and admits messages again in the next window', async () => {
  let clock = 0
  const runtime = createRuntime({ now: () => clock })
  const client = connect(runtime, '1.1')
  for (let index = 0; index < 200; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  }
  expect(client.closes).toEqual([])

  clock = 1_000
  for (let index = 0; index < 200; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  }
  expect(client.closes).toEqual([])

  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  expect(client.closes).toEqual([{ code: 1008, reason: 'Message rate limit exceeded' }])
  expect(runtime.getStats().connectionCount).toBe(0)
})

it('reports only the sockets a publish reached, not sockets whose output was refused over the buffer bound', async () => {
  const runtime = createRuntime()
  let buffered = 0
  connect(runtime, '1.1', () => buffered)
  const healthy = connect(runtime, '2.2')
  await runtime.receiveWebSocketMessage('1.1', subscribe('news.1'))
  await runtime.receiveWebSocketMessage('1.1', subscribe('news.2'))
  await runtime.receiveWebSocketMessage('2.2', subscribe('news.1'))

  buffered = 4 * 1024 * 1024 + 1
  const response = await runtime.fetch(publishRequest(['news.1', 'news.2']))

  expect(await response.json()).toEqual({ ok: true, deliveredChannels: ['news.1'], deliveredSockets: 1 })
  expect(healthy.sent.filter(packet => packet.event === 'news.posted')).toHaveLength(1)
})

it('leaves a replacement connection with a reused socket id in place when a queued slow-consumer close runs', async () => {
  const runtime = presenceRuntime()
  let buffered = 0
  connect(runtime, '9.9')
  connect(runtime, '1.1', () => buffered, undefined, true)
  await runtime.receiveWebSocketMessage('1.1', subscribe('presence-room.1'))
  await runtime.receiveWebSocketMessage('9.9', subscribe('presence-room.1'))
  connect(runtime, '8.8')
  await runtime.receiveWebSocketMessage('8.8', subscribe('presence-room.1'))

  buffered = 4 * 1024 * 1024 + 1
  runtime.disconnectWebSocket('8.8')
  runtime.disconnectWebSocket('1.1')
  const replacement = connect(runtime, '1.1')
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(replacement.closes).toEqual([])
  expect(runtime.getStats().connectionCount).toBe(2)
})

it('refuses a payload that would take buffered output past the bound, closing the connection without handing it to the transport', async () => {
  const realtime: BroadcastRealtimeRuntimeBindings = {
    query: async () => { throw new Error('not used') },
    mutate: async () => { throw new Error('not used') },
    subscribe: async (name, _args, options) => {
      await options.onData({ name, data: 'x'.repeat(2 * 1024 * 1024), dependencies: [], version: 1 })
      return { id: 'subscription', current: { name, data: {}, dependencies: [], version: 1 }, unsubscribe() {} }
    },
  }
  const runtime = createRuntime({ realtime })
  const client = connect(runtime, '1.1', () => 3 * 1024 * 1024)
  await runtime.receiveWebSocketMessage('1.1', realtimeSubscribe('big'))

  expect(client.sent.map(packet => packet.event)).toEqual(['pusher:connection_established'])
  expect(client.closes).toEqual([{ code: 1008, reason: 'Slow consumer' }])
  expect(runtime.getStats().connectionCount).toBe(0)
})

it('counts presence channels whose failed subscription is still pending cleanup toward the channel limit', async () => {
  const redisDown = (): never => { throw new Error('Redis connection lost') }
  let hashSetCalls = 0
  const runtime = createRuntime({
    channelAuth: {
      resolveUser: ({ socketId }) => ({ id: socketId }),
      definitions: [defineChannel('room.{id}', { type: 'presence', authorize: user => typeof user === 'object' && user !== null && 'id' in user ? { id: user.id } : false })],
    },
    scaling: {
      driver: 'redis',
      connection: 'shared',
      nodeId: 'node-1',
      eventChannel: 'events',
      adapter: {
        publish: async () => {},
        subscribe: async () => () => {},
        hashSet: async () => { hashSetCalls += 1; redisDown() },
        hashGetAll: async () => redisDown(),
        hashDelete: async () => redisDown(),
        close: async () => {},
      },
    },
  })
  const client = connect(runtime, '1.1')
  for (let index = 1; index <= 100; index += 1) {
    await runtime.receiveWebSocketMessage('1.1', subscribe(`presence-room.${index}`))
  }
  expect(client.sent.filter(packet => packet.event === 'pusher:subscription_error').map(packet => JSON.parse(packet.data).status)).toEqual(Array(100).fill(500))
  expect(hashSetCalls).toBe(100)

  await runtime.receiveWebSocketMessage('1.1', subscribe('presence-room.101'))

  expect(JSON.parse(client.sent.at(-1)!.data)).toMatchObject({ status: 429 })
  expect(hashSetCalls).toBe(100)
  expect(client.closes).toEqual([])
})

it('disconnects a slow consumer as soon as one send pushes its buffered output over the bound', async () => {
  const runtime = createRuntime()
  let buffered = 0
  const slow = connect(runtime, '1.1', () => buffered, (payload) => {
    if (JSON.parse(payload).event === 'pusher:pong') buffered += 5 * 1024 * 1024
  })
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))

  expect(slow.closes).toEqual([{ code: 1008, reason: 'Slow consumer' }])
  expect(runtime.getStats().connectionCount).toBe(0)
})

it('disconnects every slow presence subscriber when one departure notifies them all', async () => {
  const runtime = presenceRuntime()
  let buffered = 0
  const subscriberCount = 1000
  for (let index = 1; index <= subscriberCount; index += 1) {
    connect(runtime, `${index}.1`, () => buffered, undefined, true)
    await runtime.receiveWebSocketMessage(`${index}.1`, JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
  }
  connect(runtime, 'leaver.1')
  await runtime.receiveWebSocketMessage('leaver.1', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))

  buffered = 4 * 1024 * 1024 + 1
  expect(() => runtime.disconnectWebSocket('leaver.1')).not.toThrow()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(runtime.getStats().connectionCount).toBe(0)
})

it('disconnects a slow consumer whose buffered output exceeds the bound and delivers nothing further to it', async () => {
  const runtime = createRuntime()
  let buffered = 0
  const slow = connect(runtime, '1.1', () => buffered)
  const healthy = connect(runtime, '1.2')
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  expect(slow.sent.map(packet => packet.event)).toEqual(['pusher:connection_established', 'pusher:pong'])

  buffered = 4 * 1024 * 1024 + 1
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  expect(slow.closes).toEqual([{ code: 1008, reason: 'Slow consumer' }])
  expect(slow.sent.map(packet => packet.event)).toEqual(['pusher:connection_established', 'pusher:pong'])
  expect(runtime.getStats().connectionCount).toBe(1)

  await runtime.receiveWebSocketMessage('1.2', JSON.stringify({ event: 'pusher:ping', data: {} }))
  expect(healthy.sent.map(packet => packet.event)).toEqual(['pusher:connection_established', 'pusher:pong'])
  expect(healthy.closes).toEqual([])
})
