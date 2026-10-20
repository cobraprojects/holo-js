import { afterEach, expect, it, vi } from 'vitest'
import { createFluxClient, fluxInternals } from '../src'

type Deferred<T> = { readonly promise: Promise<T>, resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

class FakeFluxSocket {
  static sockets: FakeFluxSocket[] = []
  readyState = 0
  readonly frames: Array<Record<string, unknown>> = []
  readonly listeners = new Map<string, Array<(event: { readonly data?: unknown }) => void>>()

  constructor(readonly url: string) {
    FakeFluxSocket.sockets.push(this)
  }

  send(value: string) {
    this.frames.push(JSON.parse(value) as Record<string, unknown>)
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(event: string, listener: (event: { readonly data?: unknown }) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  receive(event: string, data: Record<string, unknown> = {}, channel?: string) {
    this.emit('message', JSON.stringify({ event, ...(channel ? { channel } : {}), data: JSON.stringify(data) }))
  }

  emit(event: string, data?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener({ data })
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  FakeFluxSocket.sockets = []
})

it('ignores a private authorization that completes after the socket it was requested on has closed', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeFluxSocket)
  const authorizations: Array<Deferred<{ auth: string }>> = []
  vi.stubGlobal('fetch', async () => {
    const authorization = deferred<{ auth: string }>()
    authorizations.push(authorization)
    return {
      ok: true,
      status: 200,
      json: () => authorization.promise,
    }
  })
  const connector = fluxInternals.createHoloWebSocketConnector({
    key: 'key',
    host: '127.0.0.1',
    port: 8080,
    scheme: 'http',
    authEndpoint: '/broadcasting/auth',
  })
  const client = createFluxClient({ connector })
  client.private('orders.1').listen('order.shipped', () => {})
  await vi.advanceTimersByTimeAsync(0)

  const first = FakeFluxSocket.sockets[0]!
  first.open()
  await vi.advanceTimersByTimeAsync(0)
  first.receive('pusher:connection_established', { socket_id: 'a.1' })
  first.close()
  await vi.advanceTimersByTimeAsync(500)

  const second = FakeFluxSocket.sockets[1]!
  second.open()
  await vi.advanceTimersByTimeAsync(0)
  second.receive('pusher:connection_established', { socket_id: 'b.2' })
  await vi.advanceTimersByTimeAsync(0)

  authorizations[0]!.resolve({ auth: 'stale' })
  await vi.advanceTimersByTimeAsync(0)
  expect(second.frames.filter(frame => frame.event === 'pusher:subscribe')).toEqual([])

  authorizations[1]!.resolve({ auth: 'fresh' })
  await vi.advanceTimersByTimeAsync(0)
  expect(second.frames.filter(frame => frame.event === 'pusher:subscribe')).toEqual([
    { event: 'pusher:subscribe', data: { channel: 'private-orders.1', auth: 'fresh' } },
  ])
  await client.disconnect()
})

it('does not subscribe a private channel that was left while its authorization was pending', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeFluxSocket)
  const authorizations: Array<Deferred<{ auth: string }>> = []
  vi.stubGlobal('fetch', async () => {
    const authorization = deferred<{ auth: string }>()
    authorizations.push(authorization)
    return {
      ok: true,
      status: 200,
      json: () => authorization.promise,
    }
  })
  const connector = fluxInternals.createHoloWebSocketConnector({
    key: 'key',
    host: '127.0.0.1',
    port: 8080,
    scheme: 'http',
    authEndpoint: '/broadcasting/auth',
  })
  const client = createFluxClient({ connector })
  const subscription = client.private('orders.1').listen('order.shipped', () => {})
  await vi.advanceTimersByTimeAsync(0)

  const socket = FakeFluxSocket.sockets[0]!
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  socket.receive('pusher:connection_established', { socket_id: 'a.1' })
  await vi.advanceTimersByTimeAsync(0)

  subscription.leaveChannel()
  authorizations[0]!.resolve({ auth: 'late' })
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames.filter(frame => frame.event === 'pusher:subscribe')).toEqual([])
  await client.disconnect()
})

async function openSocket(connector: ReturnType<typeof fluxInternals.createHoloWebSocketConnector>) {
  vi.stubGlobal('WebSocket', FakeFluxSocket)
  const client = createFluxClient({ connector })
  const connecting = client.connect()
  await vi.advanceTimersByTimeAsync(0)
  const socket = FakeFluxSocket.sockets[0]!
  socket.open()
  await connecting
  return { client, socket }
}

it('drops a frame that is not JSON without throwing and still delivers the next valid frame', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))
  const delivered: unknown[] = []
  client.channel('feed').listen('feed.updated', payload => delivered.push(payload))
  await vi.advanceTimersByTimeAsync(0)

  expect(() => socket.emit('message', 'not json {')).not.toThrow()
  expect(() => socket.emit('message', JSON.stringify({ event: 'feed.updated', channel: 'feed', data: '{"broken' }))).not.toThrow()
  socket.receive('feed.updated', { title: 'Next' }, 'feed')

  expect(delivered).toEqual([{ title: 'Next' }])
  expect(client.getStatus()).toBe('connected')
  await client.disconnect()
})

it('logs a dropped frame in development builds', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))

  socket.emit('message', 'not json {')

  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('[@holo-js/flux] Dropped a WebSocket frame that is not valid JSON.')
  await client.disconnect()
})

it('does not log a dropped frame in production builds', async () => {
  vi.useFakeTimers()
  vi.stubEnv('NODE_ENV', 'production')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))

  expect(() => socket.emit('message', 'not json {')).not.toThrow()

  expect(warn).not.toHaveBeenCalled()
  await client.disconnect()
})

it('calls the channel error callback with the failure when the authorization endpoint refuses a private channel', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
  }))
  const connector = fluxInternals.createHoloWebSocketConnector({
    key: 'key',
    host: '127.0.0.1',
    port: 8080,
    scheme: 'http',
    authEndpoint: '/broadcasting/auth',
  })
  vi.stubGlobal('WebSocket', FakeFluxSocket)
  const client = createFluxClient({ connector })
  const errors: Error[] = []
  client.private('orders.1').error(error => errors.push(error))
  await vi.advanceTimersByTimeAsync(0)

  const socket = FakeFluxSocket.sockets[0]!
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  socket.receive('pusher:connection_established', { socket_id: 'a.1' })
  await vi.advanceTimersByTimeAsync(0)

  expect(errors.map(error => error.message)).toEqual(['[@holo-js/flux] Channel authorization failed with HTTP 403.'])
  expect(socket.frames.filter(frame => frame.event === 'pusher:subscribe')).toEqual([])
  await client.disconnect()
})

it('calls the channel error callback with the server refusal and keeps the connection open', async () => {
  vi.useFakeTimers()
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))
  const errors: string[] = []
  const delivered: unknown[] = []
  client.private('orders.1').error(error => errors.push(error.message)).listen('order.shipped', () => {})
  client.channel('feed').listen('feed.updated', payload => delivered.push(payload))
  await vi.advanceTimersByTimeAsync(0)

  socket.receive('pusher:subscription_error', { type: 'AuthError', error: 'Unable to authorize the channel subscription.', status: 403 }, 'private-orders.1')
  socket.receive('feed.updated', { title: 'Still open' }, 'feed')

  expect(errors).toEqual(['[@holo-js/flux] Subscription to orders.1 was refused: Unable to authorize the channel subscription.'])
  expect(delivered).toEqual([{ title: 'Still open' }])
  expect(client.getStatus()).toBe('connected')
  await client.disconnect()
})

it('calls the error callback while the subscription is paused', async () => {
  vi.useFakeTimers()
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))
  const errors: string[] = []
  const subscription = client.private('orders.1').error(error => errors.push(error.message)).listen('order.shipped', () => {})
  await vi.advanceTimersByTimeAsync(0)

  subscription.stopListening()
  socket.receive('pusher:subscription_error', { error: 'Unable to authorize the channel subscription.' }, 'private-orders.1')

  expect(errors).toEqual(['[@holo-js/flux] Subscription to orders.1 was refused: Unable to authorize the channel subscription.'])
  await client.disconnect()
})

it('does not call the error callback after the subscription has left the channel', async () => {
  vi.useFakeTimers()
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))
  const errors: string[] = []
  const subscription = client.private('orders.1').error(error => errors.push(error.message))
  await vi.advanceTimersByTimeAsync(0)

  subscription.leaveChannel()
  socket.receive('pusher:subscription_error', { error: 'Unable to authorize the channel subscription.' }, 'private-orders.1')

  expect(errors).toEqual([])
  await client.disconnect()
})

it('does not deliver a refusal to a callback subscribed by an error callback for the same refusal', async () => {
  vi.useFakeTimers()
  const { client, socket } = await openSocket(fluxInternals.createHoloWebSocketConnector({ key: 'key', host: '127.0.0.1', port: 8080, scheme: 'http' }))
  const second: string[] = []
  client.private('orders.1').error(() => {
    client.private('orders.1').error(error => second.push(error.message))
  })
  await vi.advanceTimersByTimeAsync(0)

  socket.receive('pusher:subscription_error', { error: 'Unable to authorize the channel subscription.' }, 'private-orders.1')

  expect(second).toEqual([])
  await client.disconnect()
})
