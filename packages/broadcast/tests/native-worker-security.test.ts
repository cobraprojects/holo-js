import { createHash, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import WebSocket from 'ws'
import { defineSchema, field } from '@holo-js/validation'
import { expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { createBroadcastWorkerRuntime, defineChannel, normalizeBroadcastConfig, renderBroadcastAuthResponse, startBroadcastWorker } from '../src'

async function startNativeWorker(options: { authorize?: () => boolean | Promise<boolean>; authEndpoint?: string; resolveUser?: () => unknown; maxMessageBytes?: number; presenceAuthorize?: () => { id: string } } = {}) {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No native worker port available')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const worker = await startBroadcastWorker({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret', ...(options.authEndpoint ? { clientOptions: { authEndpoint: options.authEndpoint } } : {}) },
        tenant: { driver: 'holo', appId: 'tenant', key: 'tenant-key', secret: 'tenant-secret' },
      },
      worker: { host: '127.0.0.1', port: address.port, statsEnabled: true, maxRequestBytes: 4096, ...(options.maxMessageBytes ? { maxMessageBytes: options.maxMessageBytes } : {}) },
    }),
    channelAuth: options.authEndpoint ? undefined : {
      resolveUser: options.resolveUser ?? (({ guard }) => ({ id: guard === 'admin' ? 'native-admin' : 'native-user' })),
      definitions: [
        defineChannel('orders.1', { type: 'private', authorize: options.authorize ?? (() => true) }),
        defineChannel('room.1', { type: 'presence', authorize: options.presenceAuthorize ?? (() => ({ id: 'guest' })) }),
        defineChannel('admins.1', { type: 'private', guard: 'admin', authorize: user => typeof user === 'object' && user !== null && 'id' in user && user.id === 'native-admin' }),
        defineChannel('dynamic.{area}', {
          type: 'private',
          guard: ({ params }) => params.area === 'admin' ? 'admin' : 'web',
          authorize: (user, params) => typeof user === 'object' && user !== null && 'id' in user && user.id === (params.area === 'admin' ? 'native-admin' : 'native-user'),
        }),
      ],
    },
  })
  const sockets: WebSocket[] = []
  let stopped = false
  onTestFinished(async () => {
    await Promise.all(sockets.map(async socket => {
      if (socket.readyState === WebSocket.CLOSED) return
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }))
    if (!stopped) await worker.stop()
  })
  const baseUrl = `http://${worker.host}:${worker.port}`
  return {
    baseUrl,
    async stop() {
      await worker.stop()
      stopped = true
    },
    async connect(app = 'main', headers: Record<string, string> = {}) {
      const socket = new WebSocket(`ws://${worker.host}:${worker.port}/app/${app}-key`, { headers })
      sockets.push(socket)
      const messages: Array<{ event: string; channel?: string; data: string }> = []
      socket.on('message', data => messages.push(JSON.parse(data.toString())))
      await once(socket, 'open')
      await expect.poll(() => messages.some(message => message.event === 'pusher:connection_established')).toBe(true)
      return { socket, messages }
    },
    request(app = 'main', timestamp = Math.floor(Date.now() / 1000)) {
      const body = JSON.stringify({ name: 'orders.updated', channels: ['private-orders.1'], data: JSON.stringify({ title: app }) })
      const url = new URL(`/apps/${app}/events`, baseUrl)
      url.searchParams.set('auth_key', `${app}-key`)
      url.searchParams.set('auth_timestamp', String(timestamp))
      url.searchParams.set('auth_version', '1.0')
      url.searchParams.set('body_md5', createHash('md5').update(body).digest('hex'))
      const query = [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&')
      url.searchParams.set('auth_signature', createHmac('sha256', `${app}-secret`).update(`POST\n${url.pathname}\n${query}`).digest('hex'))
      return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    },
    async stats() {
      const response = await fetch(`${baseUrl}/stats`)
      expect(response.status).toBe(200)
      return await response.json() as { connectionCount: number; subscribedChannelCount: number }
    },
  }
}

it('rejects invalid signatures, tampered bodies, expired signatures, and cross-app credentials over native HTTP', async () => {
  const worker = await startNativeWorker()
  expect((await fetch(worker.request())).status).toBe(200)
  const invalid = worker.request()
  const invalidUrl = new URL(invalid.url)
  invalidUrl.searchParams.set('auth_signature', 'invalid')
  expect((await fetch(new Request(invalidUrl, invalid))).status).toBe(401)
  const tampered = worker.request()
  expect((await fetch(new Request(tampered, { body: JSON.stringify({ name: 'orders.updated', channels: ['private-orders.1'], data: '{"title":"tampered"}' }) }))).status).toBe(401)
  expect((await fetch(worker.request('main', Math.floor(Date.now() / 1000) - 1000))).status).toBe(401)
  const wrongApp = worker.request()
  const wrongAppUrl = new URL(wrongApp.url)
  wrongAppUrl.pathname = '/apps/tenant/events'
  expect((await fetch(new Request(wrongAppUrl, wrongApp))).status).toBe(401)
})

it('serves health and rejects oversized native HTTP bodies before accepting a publish', async () => {
  const worker = await startNativeWorker()
  const health = await fetch(`${worker.baseUrl}/health`)
  expect(health.status).toBe(200)
  await expect(health.json()).resolves.toEqual({ ok: true })
  const rejected = await fetch(`${worker.baseUrl}/apps/main/events`, { method: 'POST', body: 'x'.repeat(4097) })
  expect(rejected.status).toBe(413)
  expect((await fetch(worker.request())).status).toBe(200)
})

it('rejects an occupied native port without interrupting its existing server', async () => {
  const server = createHttpServer((_request, response) => response.end('Existing server'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No native server port available')
  const config = normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId: 'main', key: 'key', secret: 'secret' } },
    worker: { host: '127.0.0.1', port: address.port },
  })
  await expect(startBroadcastWorker({ config })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await expect(fetch(`http://127.0.0.1:${address.port}`).then(response => response.text())).resolves.toBe('Existing server')
})

it('reports native HTTP shutdown errors when an already stopped worker is stopped again', async () => {
  const worker = await startNativeWorker()
  await worker.stop()
  await expect(worker.stop()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' })
})

it('delivers identical channel names only to the authenticated app scope over native WebSockets', async () => {
  const worker = await startNativeWorker()
  const main = await worker.connect()
  const tenant = await worker.connect('tenant')
  for (const client of [main, tenant]) {
    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
    await expect.poll(() => client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(true)
  }
  await expect(fetch(worker.request()).then(response => response.json())).resolves.toMatchObject({ deliveredSockets: 1 })
  await expect(fetch(worker.request('tenant')).then(response => response.json())).resolves.toMatchObject({ deliveredSockets: 1 })
  await expect.poll(() => main.messages.filter(message => message.event === 'orders.updated').map(message => JSON.parse(message.data))).toEqual([{ title: 'main' }])
  await expect.poll(() => tenant.messages.filter(message => message.event === 'orders.updated').map(message => JSON.parse(message.data))).toEqual([{ title: 'tenant' }])
})

it('closes a native WebSocket that sends an oversize frame with 1009 while the worker and other sockets keep running', async () => {
  const worker = await startNativeWorker({ maxMessageBytes: 512 })
  const offender = await worker.connect()
  const healthy = await worker.connect()
  const offenderClosed = once(offender.socket, 'close')
  offender.socket.send('x'.repeat(513))
  const [code] = await offenderClosed
  expect(code).toBe(1009)
  await expect.poll(async () => (await worker.stats()).connectionCount).toBe(1)
  expect(healthy.socket.readyState).toBe(WebSocket.OPEN)
  healthy.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
  await expect.poll(() => healthy.messages.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(true)
  await expect(fetch(worker.request()).then(response => response.json())).resolves.toMatchObject({ deliveredSockets: 1 })
  await expect.poll(() => healthy.messages.filter(message => message.event === 'orders.updated').map(message => JSON.parse(message.data))).toEqual([{ title: 'main' }])
  expect(await worker.stats()).toMatchObject({ connectionCount: 1, subscribedChannelCount: 1 })
})

it('removes the presence member of a socket closed for an oversize frame and tells the remaining subscribers', async () => {
  let presenceJoins = 0
  const worker = await startNativeWorker({ maxMessageBytes: 512, presenceAuthorize: () => ({ id: ++presenceJoins === 1 ? 'offender' : 'healthy' }) })
  const offender = await worker.connect()
  const healthy = await worker.connect()
  for (const client of [offender, healthy]) {
    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
    await expect.poll(() => client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'presence-room.1')).toBe(true)
  }
  const offenderClosed = once(offender.socket, 'close')
  offender.socket.send('x'.repeat(513))
  expect((await offenderClosed)[0]).toBe(1009)
  await expect.poll(() => healthy.messages.filter(message => message.event === 'pusher_internal:member_removed').map(message => JSON.parse(message.data))).toEqual([{ user_id: 'offender' }])
})

it('reports malformed socket messages to the reporter active at worker start and closes with a protocol error', async () => {
  const reports: HoloErrorReportContext[] = []
  const laterReports: HoloErrorReportContext[] = []
  errorReportingInternals.configure({ report: (_error, context) => { reports.push(context) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const worker = await startNativeWorker()
  errorReportingInternals.configure({ report: (_error, context) => { laterReports.push(context) } })
  const client = await worker.connect()
  const closed = once(client.socket, 'close')
  client.socket.send('not json')
  const [code, reason] = await closed
  expect(code).toBe(4001)
  expect(String(reason)).toBe('Protocol error')
  expect(reports).toEqual([{ capability: 'broadcast', operation: 'worker.socketMessage' }])
  expect(laterReports).toEqual([])
})

it('rejects unauthorized private subscriptions with a subscription error and keeps the socket open', async () => {
  const reports: unknown[] = []
  errorReportingInternals.configure({ report: (error) => { reports.push(error) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const worker = await startNativeWorker({ authorize: () => false })
  const client = await worker.connect()
  client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
  await expect.poll(() => client.messages.find(message => message.event === 'pusher:subscription_error')).toEqual({
    event: 'pusher:subscription_error',
    channel: 'private-orders.1',
    data: JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 403 }),
  })
  client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'news' } }))
  await expect.poll(() => client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'news')).toBe(true)
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  expect(client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'private-orders.1')).toBe(false)
  expect(await worker.stats()).toMatchObject({ connectionCount: 1, subscribedChannelCount: 1 })
  expect(reports).toEqual([])
})

it('rejects private and presence subscriptions when the default worker resolves no user', async () => {
  let authorizeCalled = false
  const worker = await startNativeWorker({ resolveUser: () => null, authorize: () => { authorizeCalled = true; return true } })
  const client = await worker.connect()
  for (const channel of ['private-orders.1', 'presence-room.1']) {
    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }))
    await expect.poll(() => client.messages.find(message => message.event === 'pusher:subscription_error' && message.channel === channel)?.data)
      .toBe(JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 403 }))
  }
  expect(authorizeCalled).toBe(false)
  expect(client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(false)
  expect(await worker.stats()).toMatchObject({ connectionCount: 1, subscribedChannelCount: 0 })
})

it('reports internal subscription failures and sends the client a generic subscription error', async () => {
  const reports: Array<{ error: unknown, context: HoloErrorReportContext }> = []
  errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const failure = new Error('connect ECONNREFUSED users-db.internal:5432')
  const worker = await startNativeWorker({ resolveUser: () => { throw failure } })
  const client = await worker.connect()
  client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
  await expect.poll(() => client.messages.find(message => message.event === 'pusher:subscription_error')).toEqual({
    event: 'pusher:subscription_error',
    channel: 'private-orders.1',
    data: JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 500 }),
  })
  expect(reports).toEqual([{ error: failure, context: { capability: 'broadcast', operation: 'worker.subscription' } }])
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
})

it('reports a presence synchronization failure as a subscription error and keeps the socket open', async () => {
  const reports: Array<{ error: unknown, context: HoloErrorReportContext }> = []
  errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const failure = new Error('NOPERM this user has no permissions to run the hset command')
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: { resolveUser: () => ({ id: 'native-user' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: () => ({ id: 'native-user' }) })] },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-1', eventChannel: 'events',
      adapter: {
        publish: async () => {}, subscribe: async () => () => {}, hashDelete: async () => {}, hashGetAll: async () => ({}), close: async () => {},
        hashSet: async () => { throw failure },
        setWithExpiry: async () => {}, exists: async () => true,
      },
    },
  })
  onTestFinished(() => runtime.close())
  const sent: Array<{ event: string, channel?: string, data: string }> = []
  runtime.connectWebSocket({ socketId: '1.1', app: { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }, headers: new Headers(), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping', data: {} }))
  expect(sent.slice(1)).toEqual([
    { event: 'pusher:subscription_error', channel: 'presence-room.1', data: JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 500 }) },
    { event: 'pusher:pong', data: '{}' },
  ])
  expect(reports).toEqual([{ error: failure, context: { capability: 'broadcast', operation: 'worker.subscription' } }])
  expect(runtime.getStats()).toMatchObject({ connectionCount: 1, subscribedChannelCount: 0, presenceChannelCount: 0 })
})

it('reports a failing HTTP channel authorization endpoint and sends a generic subscription error', async () => {
  const reports: HoloErrorReportContext[] = []
  errorReportingInternals.configure({ report: (_error, context) => { reports.push(context) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const authorization = createHttpServer((_incoming, outgoing) => { outgoing.writeHead(503); outgoing.end('database unavailable') })
  authorization.listen(0, '127.0.0.1')
  await once(authorization, 'listening')
  onTestFinished(async () => {
    authorization.closeAllConnections()
    await new Promise<void>((resolve, reject) => authorization.close(error => error ? reject(error) : resolve()))
  })
  const address = authorization.address()
  if (!address || typeof address === 'string') throw new Error('Native authorization port unavailable')
  const worker = await startNativeWorker({ authEndpoint: `http://127.0.0.1:${address.port}` })
  const client = await worker.connect()
  client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
  await expect.poll(() => client.messages.find(message => message.event === 'pusher:subscription_error')?.data)
    .toBe(JSON.stringify({ type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 500 }))
  expect(reports).toEqual([{ capability: 'broadcast', operation: 'worker.subscription' }])
})

it('rejects a socket identifier that is already connected without disturbing the existing socket', async () => {
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const first: string[] = []
  const second: string[] = []
  runtime.connectWebSocket({ socketId: '1.1', app, headers: new Headers(), send: payload => first.push(payload), close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'news' } }))
  expect(() => runtime.connectWebSocket({ socketId: '1.1', app, headers: new Headers(), send: payload => second.push(payload), close: () => {}, bufferedAmount: () => 0 }))
    .toThrow('Socket id "1.1" is already connected.')
  const signed = new URL('http://worker.test/apps/main/events')
  const body = JSON.stringify({ name: 'news.posted', channels: ['news'], data: '{}' })
  signed.searchParams.set('auth_key', 'main-key')
  signed.searchParams.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
  signed.searchParams.set('auth_version', '1.0')
  signed.searchParams.set('body_md5', createHash('md5').update(body).digest('hex'))
  const query = [...signed.searchParams].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&')
  signed.searchParams.set('auth_signature', createHmac('sha256', 'main-secret').update(`POST\n${signed.pathname}\n${query}`).digest('hex'))
  await expect(runtime.fetch(new Request(signed, { method: 'POST', body })).then(response => response.json())).resolves.toMatchObject({ deliveredSockets: 1 })
  expect(first.map(payload => JSON.parse(payload).event)).toEqual(['pusher:connection_established', 'pusher_internal:subscription_succeeded', 'news.posted'])
  expect(second).toEqual([])
  expect(runtime.getStats().connectionCount).toBe(1)
})

it('retries a presence member whose rollback delete failed when the socket disconnects', async () => {
  const reports: unknown[] = []
  errorReportingInternals.configure({ report: error => { reports.push(error) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const hashes = new Map<string, Map<string, string>>()
  const outage = { reads: false, deletes: false }
  const redisDown = (): never => { throw new Error('Redis connection lost') }
  const presenceMembers = () => [...hashes.values()].flatMap(members => [...members.keys()])
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: { resolveUser: () => ({ id: 'native-user' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: () => ({ id: 'native-user' }) })] },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-1', eventChannel: 'events',
      adapter: {
        publish: async () => {},
        subscribe: async () => () => {},
        hashSet: async (key, field, value) => { hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]])) },
        hashGetAll: async key => { if (outage.reads) redisDown(); return Object.fromEntries(hashes.get(key) ?? []) },
        hashDelete: async (key, field) => { if (outage.deletes) redisDown(); hashes.get(key)?.delete(field) },
        setWithExpiry: async () => {},
        exists: async () => true,
        close: async () => {},
      },
    },
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const sent: Array<{ event: string, channel?: string, data: string }> = []
  runtime.connectWebSocket({ socketId: '3.3', app, headers: new Headers(), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
  outage.reads = true
  outage.deletes = true
  await runtime.receiveWebSocketMessage('3.3', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
  expect(sent.find(message => message.event === 'pusher:subscription_error')?.channel).toBe('presence-room.1')
  expect(reports.length).toBeGreaterThan(0)
  expect(presenceMembers()).toHaveLength(1)
  outage.reads = false
  outage.deletes = false
  runtime.disconnectWebSocket('3.3')
  await expect.poll(presenceMembers).toEqual([])
})

it('keeps a presence member whose Redis delete failed on unsubscribe until the socket disconnects', async () => {
  const hashes = new Map<string, Map<string, string>>()
  const outage = { deletes: false }
  const presenceMembers = () => [...hashes.values()].flatMap(members => [...members.keys()])
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: { resolveUser: () => ({ id: 'native-user' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: () => ({ id: 'native-user' }) })] },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-1', eventChannel: 'events',
      adapter: {
        publish: async () => {},
        subscribe: async () => () => {},
        hashSet: async (key, field, value) => { hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]])) },
        hashGetAll: async key => Object.fromEntries(hashes.get(key) ?? []),
        hashDelete: async (key, field) => { if (outage.deletes) throw new Error('Redis connection lost'); hashes.get(key)?.delete(field) },
        setWithExpiry: async () => {},
        exists: async () => true,
        close: async () => {},
      },
    },
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const sent: Array<{ event: string, channel?: string, data: string }> = []
  runtime.connectWebSocket({ socketId: '4.4', app, headers: new Headers(), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('4.4', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
  expect(sent.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(true)
  expect(presenceMembers()).toHaveLength(1)

  outage.deletes = true
  await expect(runtime.receiveWebSocketMessage('4.4', JSON.stringify({ event: 'pusher:unsubscribe', data: { channel: 'presence-room.1' } }))).rejects.toThrow('Redis connection lost')
  expect(runtime.getStats()).toMatchObject({ presenceChannelCount: 1, subscribedChannelCount: 1 })
  expect(presenceMembers()).toHaveLength(1)

  outage.deletes = false
  runtime.disconnectWebSocket('4.4')
  await expect.poll(presenceMembers).toEqual([])
  expect(runtime.getStats()).toMatchObject({ presenceChannelCount: 0, connectionCount: 0 })
})

it('reports a remote presence member that disappeared from Redis when a local subscriber joins', async () => {
  const hashes = new Map<string, Map<string, string>>()
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: { resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })] },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-a', eventChannel: 'events',
      adapter: {
        publish: async () => {},
        subscribe: async () => () => {},
        hashSet: async (key, field, value) => { hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]])) },
        hashGetAll: async key => Object.fromEntries(hashes.get(key) ?? []),
        hashDelete: async (key, field) => { hashes.get(key)?.delete(field) },
        setWithExpiry: async () => {},
        exists: async () => true,
        close: async () => {},
      },
    },
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const observerSent: Array<{ event: string, channel?: string, data: string }> = []
  runtime.connectWebSocket({ socketId: '5.5', app, headers: new Headers({ 'x-test-user': 'observer' }), send: payload => observerSent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('5.5', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))
  await runtime.receiveScalingMessage(JSON.stringify({ type: 'presence-member-added', originNodeId: 'node-b', appId: 'main', channel: 'presence-room.1', socketId: '7.7', member: { id: 'remote-user' } }))
  expect(observerSent.some(message => message.event === 'pusher_internal:member_added' && JSON.parse(message.data).id === 'remote-user')).toBe(true)

  const newcomerSent: Array<{ event: string, channel?: string, data: string }> = []
  runtime.connectWebSocket({ socketId: '5.6', app, headers: new Headers({ 'x-test-user': 'newcomer' }), send: payload => newcomerSent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('5.6', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))

  expect(observerSent.filter(message => message.event === 'pusher_internal:member_removed').map(message => JSON.parse(message.data))).toEqual([{ user_id: 'remote-user' }])
  const roster = JSON.parse(newcomerSent.find(message => message.event === 'pusher_internal:subscription_succeeded')!.data) as { presence: { ids: string[] } }
  expect(roster.presence.ids).toEqual(['observer', 'newcomer'])
})

it('removes a presence member whose disconnect delete failed on the next lease refresh and never a member with a live socket', async () => {
  const reports: unknown[] = []
  errorReportingInternals.configure({ report: error => { reports.push(error) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const hashes = new Map<string, Map<string, string>>()
  const subscribers = new Set<(payload: string) => void>()
  const bus = {
    publish: async (_channel: string, payload: string) => { for (const deliver of [...subscribers]) deliver(payload) },
    subscribe: async (_channel: string, onMessage: (payload: string) => void) => {
      subscribers.add(onMessage)
      return () => { subscribers.delete(onMessage) }
    },
  }
  const createNode = (nodeId: string) => {
    const failure = { nextDelete: false }
    const runtime = createBroadcastWorkerRuntime({
      config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
      channelAuth: { resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })] },
      scaling: {
        driver: 'redis', connection: 'shared', nodeId, eventChannel: 'events',
        liveness: { leaseTtlMs: 60_000, refreshIntervalMs: 400 },
        adapter: {
          publish: bus.publish,
          subscribe: bus.subscribe,
          hashSet: async (key, field, value) => { hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]])) },
          hashGetAll: async key => Object.fromEntries(hashes.get(key) ?? []),
          hashDelete: async (key, field) => {
            if (failure.nextDelete) {
              failure.nextDelete = false
              throw new Error('Redis connection lost')
            }
            hashes.get(key)?.delete(field)
          },
          setWithExpiry: async () => {},
          exists: async () => true,
          close: async () => {},
        },
      },
    })
    onTestFinished(() => runtime.close())
    return { runtime, failure }
  }
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const subscribe = JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } })
  const connect = (runtime: ReturnType<typeof createNode>['runtime'], socketId: string, user: string) => {
    const sent: Array<{ event: string, channel?: string, data: string }> = []
    runtime.connectWebSocket({ socketId, app, headers: new Headers({ 'x-test-user': user }), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
    return sent
  }
  const removedFor = (sent: Array<{ event: string, data: string }>) => sent.filter(message => message.event === 'pusher_internal:member_removed').map(message => JSON.parse(message.data))
  const presenceFields = () => [...hashes.values()].flatMap(members => [...members.keys()]).sort()

  const node = createNode('node-a')
  const observer = createNode('node-b')
  const ghostSent = connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', subscribe)
  const liveSent = connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', subscribe)
  const observerSent = connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', subscribe)
  const roster = JSON.parse(observerSent.find(message => message.event === 'pusher_internal:subscription_succeeded')!.data) as { presence: { ids: string[] } }
  expect(roster.presence.ids.slice().sort()).toEqual(['ghost-user', 'live-user', 'observer'])
  expect(ghostSent.length).toBeGreaterThan(0)

  node.failure.nextDelete = true
  node.runtime.disconnectWebSocket('8.1')
  await expect.poll(() => reports.length).toBeGreaterThan(0)
  expect(presenceFields()).toHaveLength(3)

  await expect.poll(() => presenceFields().length).toBe(2)
  await expect.poll(() => removedFor(observerSent)).toEqual([{ user_id: 'ghost-user' }])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(removedFor(observerSent)).toEqual([{ user_id: 'ghost-user' }])
  expect(removedFor(liveSent)).toEqual([{ user_id: 'ghost-user' }])
  expect(presenceFields()).toHaveLength(2)
  expect(observer.runtime.getStats()).toMatchObject({ presenceChannelCount: 1 })
  expect(liveSent.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(true)
})

function createPresenceLeaseHarness() {
  const leases = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const subscribers = new Set<(payload: string) => void>()
  const bus = {
    deliver: async (payload: string) => { for (const deliver of [...subscribers]) deliver(payload) },
    subscribe: async (_channel: string, onMessage: (payload: string) => void) => {
      subscribers.add(onMessage)
      return () => { subscribers.delete(onMessage) }
    },
  }
  const createNode = (nodeId: string) => {
    const control: { leaseGate?: Promise<void>, publishGate?: Promise<void>, hashGate?: Promise<void>, failNextPublish: boolean, failNextHashDelete: boolean, heldPublishes: number, heldHashWrites: number } = { failNextPublish: false, failNextHashDelete: false, heldPublishes: 0, heldHashWrites: 0 }
    const runtime = createBroadcastWorkerRuntime({
      config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
      channelAuth: { resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })] },
      scaling: {
        driver: 'redis', connection: 'shared', nodeId, eventChannel: 'events',
        liveness: { leaseTtlMs: 60_000, refreshIntervalMs: 400 },
        adapter: {
          publish: async (_channel: string, payload: string) => {
            if (control.publishGate) {
              control.heldPublishes += 1
              await control.publishGate
            }
            if (control.failNextPublish) {
              control.failNextPublish = false
              throw new Error('Redis connection lost')
            }
            await bus.deliver(payload)
          },
          subscribe: bus.subscribe,
          hashSet: async (key, field, value) => {
            if (control.hashGate) {
              control.heldHashWrites += 1
              await control.hashGate
            }
            hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]]))
          },
          hashGetAll: async key => Object.fromEntries(hashes.get(key) ?? []),
          hashDelete: async (key, field) => {
            if (control.failNextHashDelete) {
              control.failNextHashDelete = false
              throw new Error('Redis connection lost')
            }
            hashes.get(key)?.delete(field)
          },
          setWithExpiry: async (key, value) => {
            await control.leaseGate
            leases.set(key, value)
          },
          exists: async key => leases.has(key),
          close: async () => {},
        },
      },
    })
    onTestFinished(() => runtime.close())
    return { runtime, control }
  }
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const subscribe = JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } })
  const connect = (runtime: ReturnType<typeof createNode>['runtime'], socketId: string, user: string) => {
    const sent: Array<{ event: string, channel?: string, data: string }> = []
    runtime.connectWebSocket({ socketId, app, headers: new Headers({ 'x-test-user': user }), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
    return sent
  }
  const removedIds = (sent: Array<{ event: string, data: string }>) => sent.filter(message => message.event === 'pusher_internal:member_removed').map(message => (JSON.parse(message.data) as { user_id: string }).user_id)
  const addedIds = (sent: Array<{ event: string, data: string }>) => sent.filter(message => message.event === 'pusher_internal:member_added').map(message => (JSON.parse(message.data) as { id: string }).id)
  const presenceFields = () => [...hashes.values()].flatMap(members => [...members.keys()]).sort()
  const expireLease = (nodeId: string) => {
    for (const [key, value] of leases) {
      if (value === nodeId) leases.delete(key)
    }
  }
  const rosterOf = (sent: Array<{ event: string, data: string }>) => {
    const succeeded = sent.find(message => message.event === 'pusher_internal:subscription_succeeded')
    return (JSON.parse(succeeded!.data) as { presence: { ids: string[] } }).presence.ids.slice().sort()
  }
  const replayedRoster = (sent: Array<{ event: string, data: string }>) => {
    let members = new Set<string>()
    for (const message of sent) {
      if (message.event === 'pusher_internal:subscription_succeeded') members = new Set((JSON.parse(message.data) as { presence: { ids: string[] } }).presence.ids)
      if (message.event === 'pusher_internal:member_added') members.add((JSON.parse(message.data) as { id: string }).id)
      if (message.event === 'pusher_internal:member_removed') members.delete((JSON.parse(message.data) as { user_id: string }).user_id)
    }
    return [...members].sort()
  }
  return { createNode, connect, subscribe, removedIds, addedIds, presenceFields, expireLease, rosterOf, replayedRoster }
}

it('re-publishes live presence members after a stalled node recovers its lapsed lease without ghosts or duplicate joins', async () => {
  const harness = createPresenceLeaseHarness()
  const node = harness.createNode('node-a')
  const observer = harness.createNode('node-b')
  harness.connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', harness.subscribe)
  const liveSent = harness.connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', harness.subscribe)
  const observerSent = harness.connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', harness.subscribe)
  expect(harness.rosterOf(observerSent)).toEqual(['ghost-user', 'live-user', 'observer'])

  let resume = (): void => {}
  node.control.leaseGate = new Promise<void>(resolve => { resume = resolve })
  harness.expireLease('node-a')
  await expect.poll(() => harness.removedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
  expect(harness.presenceFields()).toEqual(['node-b:9.1'])

  resume()
  await expect.poll(() => harness.presenceFields()).toEqual(['node-a:8.1', 'node-a:8.2', 'node-b:9.1'])
  await expect.poll(() => harness.addedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(harness.addedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
  expect(harness.addedIds(liveSent)).toEqual(['observer'])

  node.runtime.disconnectWebSocket('8.1')
  await expect.poll(() => harness.presenceFields()).toEqual(['node-a:8.2', 'node-b:9.1'])
  const lateSent = harness.connect(observer.runtime, '9.2', 'late-user')
  await observer.runtime.receiveWebSocketMessage('9.2', harness.subscribe)
  expect(harness.rosterOf(lateSent)).toEqual(['late-user', 'live-user', 'observer'])
})

it('retries a presence re-publish that failed during lease recovery', async () => {
  const reports: unknown[] = []
  errorReportingInternals.configure({ report: error => { reports.push(error) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const harness = createPresenceLeaseHarness()
  const node = harness.createNode('node-a')
  const observer = harness.createNode('node-b')
  harness.connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', harness.subscribe)
  harness.connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', harness.subscribe)
  const observerSent = harness.connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', harness.subscribe)

  let resume = (): void => {}
  node.control.leaseGate = new Promise<void>(resolve => { resume = resolve })
  harness.expireLease('node-a')
  await expect.poll(() => harness.removedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])

  node.control.failNextPublish = true
  resume()
  await expect.poll(() => reports.length).toBeGreaterThan(0)
  await expect.poll(() => harness.presenceFields()).toEqual(['node-a:8.1', 'node-a:8.2', 'node-b:9.1'])
  await expect.poll(() => harness.addedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(harness.addedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
})

it('announces a recovering member exactly once when its publish and the compensating hash delete both fail', async () => {
  const harness = createPresenceLeaseHarness()
  const node = harness.createNode('node-a')
  const observer = harness.createNode('node-b')
  harness.connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', harness.subscribe)
  harness.connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', harness.subscribe)
  const observerSent = harness.connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', harness.subscribe)

  let resume = (): void => {}
  node.control.leaseGate = new Promise<void>(resolve => { resume = resolve })
  harness.expireLease('node-a')
  await expect.poll(() => harness.removedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])

  node.control.failNextPublish = true
  node.control.failNextHashDelete = true
  resume()
  await expect.poll(() => harness.addedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(harness.addedIds(observerSent).filter(id => id === 'ghost-user')).toHaveLength(1)
  expect(harness.presenceFields()).toEqual(['node-a:8.1', 'node-a:8.2', 'node-b:9.1'])
})

it('does not re-publish a member whose socket disconnects while lease recovery is publishing an earlier member', async () => {
  const harness = createPresenceLeaseHarness()
  const node = harness.createNode('node-a')
  const observer = harness.createNode('node-b')
  harness.connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', harness.subscribe)
  harness.connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', harness.subscribe)
  const observerSent = harness.connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', harness.subscribe)

  let resume = (): void => {}
  node.control.leaseGate = new Promise<void>(resolve => { resume = resolve })
  harness.expireLease('node-a')
  await expect.poll(() => harness.removedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])

  let releasePublish = (): void => {}
  node.control.publishGate = new Promise<void>(resolve => { releasePublish = resolve })
  resume()
  await expect.poll(() => node.control.heldPublishes).toBeGreaterThan(0)
  node.runtime.disconnectWebSocket('8.2')
  releasePublish()
  node.control.publishGate = undefined

  await expect.poll(() => harness.presenceFields()).toEqual(['node-a:8.1', 'node-b:9.1'])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(harness.addedIds(observerSent).sort()).toEqual(['ghost-user'])
  const lateSent = harness.connect(observer.runtime, '9.2', 'late-user')
  await observer.runtime.receiveWebSocketMessage('9.2', harness.subscribe)
  expect(harness.rosterOf(lateSent)).toEqual(['ghost-user', 'late-user', 'observer'])
})


it('keeps a recovering member in peer rosters when a peer rebuilds its roster while the recovery hash write is pending', async () => {
  const harness = createPresenceLeaseHarness()
  const node = harness.createNode('node-a')
  const observer = harness.createNode('node-b')
  harness.connect(node.runtime, '8.1', 'ghost-user')
  await node.runtime.receiveWebSocketMessage('8.1', harness.subscribe)
  harness.connect(node.runtime, '8.2', 'live-user')
  await node.runtime.receiveWebSocketMessage('8.2', harness.subscribe)
  const observerSent = harness.connect(observer.runtime, '9.1', 'observer')
  await observer.runtime.receiveWebSocketMessage('9.1', harness.subscribe)

  let resume = (): void => {}
  node.control.leaseGate = new Promise<void>(resolve => { resume = resolve })
  harness.expireLease('node-a')
  await expect.poll(() => harness.removedIds(observerSent).sort()).toEqual(['ghost-user', 'live-user'])

  let releaseHashWrite = (): void => {}
  node.control.hashGate = new Promise<void>(resolve => { releaseHashWrite = resolve })
  resume()
  await expect.poll(() => node.control.heldHashWrites).toBeGreaterThan(0)
  const peerSent = harness.connect(observer.runtime, '9.2', 'peer-user')
  await observer.runtime.receiveWebSocketMessage('9.2', harness.subscribe)
  expect(harness.rosterOf(peerSent)).toEqual(['observer', 'peer-user'])

  releaseHashWrite()
  node.control.hashGate = undefined
  await expect.poll(() => harness.presenceFields()).toEqual(['node-a:8.1', 'node-a:8.2', 'node-b:9.1', 'node-b:9.2'])
  await new Promise(resolve => setTimeout(resolve, 1_000))
  expect(harness.replayedRoster(observerSent)).toEqual(['ghost-user', 'live-user', 'observer', 'peer-user'])
})

it('publishes an accepted whisper that is still in flight before shutdown closes the scaling adapter', async () => {
  const events: string[] = []
  let releaseWhisper = (): void => {}
  const holdWhisper = new Promise<void>(resolve => { releaseWhisper = resolve })
  let whisperStarted = (): void => {}
  const whisperPublishing = new Promise<void>(resolve => { whisperStarted = resolve })
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: {
      resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }),
      definitions: [defineChannel('room.1', {
        type: 'presence',
        authorize: user => ({ id: (user as { id: string }).id }),
        whispers: { typing: defineSchema({ editing: field.boolean().required() }) },
      })],
    },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-a', eventChannel: 'events',
      adapter: {
        publish: async (_channel, payload) => {
          if ((JSON.parse(payload) as { name?: string }).name !== 'client-typing') return
          whisperStarted()
          await holdWhisper
          events.push('whisper-published')
        },
        subscribe: async () => () => {},
        hashSet: async () => {},
        hashGetAll: async () => ({}),
        hashDelete: async () => {},
        setWithExpiry: async () => {},
        exists: async () => true,
        close: async () => { events.push('adapter-closed') },
      },
    },
  })
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  runtime.connectWebSocket({ socketId: '6.1', app, headers: new Headers({ 'x-test-user': 'typist' }), send: () => {}, close: () => {}, bufferedAmount: () => 0 })
  await runtime.receiveWebSocketMessage('6.1', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } }))

  const whisper = runtime.receiveWebSocketMessage('6.1', JSON.stringify({ event: 'client-typing', channel: 'presence-room.1', data: { editing: true } }))
  await whisperPublishing
  let closed = false
  const closing = runtime.close().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(closed).toBe(false)

  releaseWhisper()
  await whisper
  await closing
  expect(events).toEqual(['whisper-published', 'adapter-closed'])
})

it('reports a dead node presence member to existing subscribers only, never to a socket that is still joining', async () => {
  const hashes = new Map<string, Map<string, string>>()
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
    channelAuth: { resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }), definitions: [defineChannel('room.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })] },
    scaling: {
      driver: 'redis', connection: 'shared', nodeId: 'node-a', eventChannel: 'events',
      liveness: { leaseTtlMs: 60_000, refreshIntervalMs: 60_000 },
      adapter: {
        publish: async () => {},
        subscribe: async () => () => {},
        hashSet: async (key, field, value) => { hashes.set(key, new Map([...(hashes.get(key) ?? []), [field, value]])) },
        hashGetAll: async key => Object.fromEntries(hashes.get(key) ?? []),
        hashDelete: async (key, field) => { hashes.get(key)?.delete(field) },
        setWithExpiry: async () => {},
        exists: async key => !key.endsWith(':nodes:node-dead'),
        close: async () => {},
      },
    },
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const subscribe = JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'presence-room.1' } })
  const connect = (socketId: string, user: string) => {
    const sent: Array<{ event: string, channel?: string, data: string }> = []
    runtime.connectWebSocket({ socketId, app, headers: new Headers({ 'x-test-user': user }), send: payload => sent.push(JSON.parse(payload)), close: () => {}, bufferedAmount: () => 0 })
    return sent
  }
  const observerSent = connect('5.1', 'observer')
  await runtime.receiveWebSocketMessage('5.1', subscribe)
  await runtime.receiveScalingMessage(JSON.stringify({ type: 'presence-member-added', originNodeId: 'node-dead', appId: 'main', channel: 'presence-room.1', socketId: '7.7', member: { id: 'ghost-user' } }))

  const joinerSent = connect('5.2', 'joiner')
  await runtime.receiveWebSocketMessage('5.2', subscribe)

  expect(joinerSent.some(message => message.event === 'pusher_internal:member_removed')).toBe(false)
  const roster = JSON.parse(joinerSent.find(message => message.event === 'pusher_internal:subscription_succeeded')!.data) as { presence: { ids: string[] } }
  expect(roster.presence.ids.slice().sort()).toEqual(['joiner', 'observer'])
  expect(observerSent.filter(message => message.event === 'pusher_internal:member_removed').map(message => JSON.parse(message.data))).toEqual([{ user_id: 'ghost-user' }])
})

it('removes a socket whose connection_established send fails so its identifier can be reused', async () => {
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({ default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } } }),
  })
  onTestFinished(() => runtime.close())
  const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }
  const failure = new Error('socket closed during handshake')
  expect(() => runtime.connectWebSocket({ socketId: '2.2', app, headers: new Headers(), send: () => { throw failure }, close: () => {}, bufferedAmount: () => 0 })).toThrow(failure)
  expect(runtime.getStats().connectionCount).toBe(0)
  const sent: string[] = []
  runtime.connectWebSocket({ socketId: '2.2', app, headers: new Headers(), send: payload => sent.push(payload), close: () => {}, bufferedAmount: () => 0 })
  expect(sent.map(payload => JSON.parse(payload).event)).toEqual(['pusher:connection_established'])
  expect(runtime.getStats().connectionCount).toBe(1)
})

it('assigns every native socket a distinct Pusher socket identifier', async () => {
  const worker = await startNativeWorker()
  const clients = await Promise.all(Array.from({ length: 20 }, async () => await worker.connect()))
  const socketIds = clients.map(client => JSON.parse(client.messages.find(message => message.event === 'pusher:connection_established')!.data).socket_id as string)
  expect(socketIds.every(socketId => /^\d+\.\d+$/.test(socketId))).toBe(true)
  expect(new Set(socketIds).size).toBe(socketIds.length)
})

it('authorizes named and dynamic channel guards with the selected native identity', async () => {
  const worker = await startNativeWorker()
  const client = await worker.connect()
  for (const channel of ['private-admins.1', 'private-dynamic.admin', 'private-dynamic.public']) {
    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }))
    await expect.poll(() => client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === channel)).toBe(true)
  }
  expect((await worker.stats()).subscribedChannelCount).toBe(3)
})

it('does not register a subscription when authorization completes after the actual socket disconnects', async () => {
  let release: ((allowed: boolean) => void) | undefined
  let started = false
  const authorized = new Promise<boolean>(resolve => { release = resolve })
  const worker = await startNativeWorker({ authorize: () => { started = true; return authorized } })
  onTestFinished(() => release?.(true))
  const client = await worker.connect()
  client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
  await expect.poll(() => started).toBe(true)
  const closed = once(client.socket, 'close')
  client.socket.close()
  await closed
  await expect.poll(async () => (await worker.stats()).connectionCount).toBe(0)
  release?.(true)
  expect((await fetch(worker.request())).status).toBe(200)
  expect((await worker.stats()).subscribedChannelCount).toBe(0)
})

it('forwards real socket credentials to HTTP authorization and isolates whisper permissions on the same channel', async () => {
  const authorization = createHttpServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const second = incoming.headers.authorization === 'Bearer second'
    const response = await renderBroadcastAuthResponse(new Request('https://app.test/broadcasting/auth', {
      method: 'POST', headers: { 'content-type': incoming.headers['content-type'] ?? '' }, body: Buffer.concat(chunks),
    }), {
      user: { id: second ? 'second' : 'first' },
      appKey: 'main-key',
      appSecret: 'main-secret',
      channelAuth: { definitions: [defineChannel('orders.1', {
        type: 'private', authorize: () => true,
        whispers: { [second ? 'typing.stop' : 'typing.start']: defineSchema({ editing: field.boolean().required() }) },
      })] },
    })
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(await response.text())
  })
  authorization.listen(0, '127.0.0.1')
  await once(authorization, 'listening')
  onTestFinished(async () => {
    authorization.closeAllConnections()
    await new Promise<void>((resolve, reject) => authorization.close(error => error ? reject(error) : resolve()))
  })
  const address = authorization.address()
  if (!address || typeof address === 'string') throw new Error('Native authorization port unavailable')
  const worker = await startNativeWorker({ authEndpoint: `http://127.0.0.1:${address.port}` })
  const first = await worker.connect('main', { authorization: 'Bearer first' })
  const second = await worker.connect('main', { authorization: 'Bearer second' })
  for (const client of [first, second]) {
    client.socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-orders.1' } }))
    await expect.poll(() => client.messages.some(message => message.event === 'pusher_internal:subscription_succeeded')).toBe(true)
  }
  first.socket.send(JSON.stringify({ event: 'client-typing.start', channel: 'private-orders.1', data: { editing: true } }))
  await expect.poll(() => second.messages.filter(message => message.event === 'client-typing.start').map(message => JSON.parse(message.data))).toEqual([{ editing: true }])
  expect(first.messages.some(message => message.event === 'client-typing.start')).toBe(false)
  second.socket.send(JSON.stringify({ event: 'client-typing.stop', channel: 'private-orders.1', data: { editing: false } }))
  await expect.poll(() => first.messages.filter(message => message.event === 'client-typing.stop').map(message => JSON.parse(message.data))).toEqual([{ editing: false }])
  for (const [client, forbidden] of [[first, 'typing.stop'], [second, 'typing.start']] as const) {
    const closed = once(client.socket, 'close')
    client.socket.send(JSON.stringify({ event: `client-${forbidden}`, channel: 'private-orders.1', data: { editing: true } }))
    const [code, reason] = await closed
    expect(code).toBe(4001)
    expect(String(reason)).toBe('Protocol error')
  }
  await expect.poll(async () => (await worker.stats()).subscribedChannelCount).toBe(0)
})
