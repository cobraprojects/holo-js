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
