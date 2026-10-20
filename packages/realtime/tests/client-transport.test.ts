import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBroadcastRealtimeTransport, realtimeClientInternals, resetRealtimeClientRuntime } from '../src/client'
import { createWireError, RealtimeAuthorizationError, RealtimeClientError } from '../src/client/errors'

class FakeRealtimeSocket {
  readyState = 0
  readonly frames: Array<Record<string, unknown>> = []
  readonly listeners = new Map<string, Array<(event: { readonly data?: unknown }) => void>>()
  constructor(readonly url: string) {
    fakeRealtimeSockets.push(this)
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
  emit(event: string, data?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener({ data })
  }
  receive(event: string, data: Record<string, unknown>) {
    this.emit('message', JSON.stringify({ event, data: JSON.stringify(data) }))
  }
}

const fakeRealtimeSockets: FakeRealtimeSocket[] = []

function installFakeRealtimeBroadcast() {
  fakeRealtimeSockets.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('WebSocket', FakeRealtimeSocket)
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ key: 'key', host: '127.0.0.1', port: 8080, path: 'app', scheme: 'http' }),
  }))
  return fakeRealtimeSockets
}

function subscribeNames(socket: FakeRealtimeSocket): string[] {
  return socket.frames
    .filter(frame => (frame.data as { action?: string }).action === 'subscribe')
    .map(frame => (frame.data as { name: string }).name)
}

afterEach(() => {
  resetRealtimeClientRuntime()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('@holo-js/realtime broadcast client transport', () => {
  it('reports transport availability without escalating non-errors', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handledErrors: unknown[] = []

    realtimeClientInternals.getRealtimeClientState().framework = {
      handleError: error => handledErrors.push(error),
    }

    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError('missing')).toBe(false)
    realtimeClientInternals.handleRealtimeConnectionError('missing')

    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
    expect(handledErrors).toEqual(['missing'])
  })

  it('recognizes availability errors and normalizes wire errors', () => {
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error(realtimeClientInternals.missingTransportMessage),
    )).toBe(true)
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error('Realtime broadcast config failed with HTTP 503.'),
    )).toBe(true)

    const authorizationError = createWireError({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })
    expect(authorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(authorizationError).toMatchObject({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })

    const defaultAuthorizationError = createWireError({
      kind: 'authorization',
      message: 'No access',
    })
    expect(defaultAuthorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(defaultAuthorizationError).toMatchObject({
      kind: 'authorization',
      message: 'No access',
      name: 'RealtimeAuthorizationError',
    })

    const fallbackError = createWireError({
      kind: 'invalid',
      message: 1,
      status: 200,
    })
    expect(fallbackError).toBeInstanceOf(RealtimeClientError)
    expect(fallbackError).toMatchObject({
      kind: 'runtime',
      message: realtimeClientInternals.unavailableTransportMessage,
      status: undefined,
    })
  })

  it('keeps live subscriptions across a dropped socket, resends each once on the new socket, and fails in-flight mutations without replaying them', async () => {
    vi.useFakeTimers()
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    const snapshots: unknown[] = []
    const errors: unknown[] = []
    transport.subscribe('records.list', {}, snapshot => snapshots.push(snapshot.data), error => errors.push(error))
    await vi.advanceTimersByTimeAsync(0)
    const first = sockets[0]!
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.frames).toEqual([{ event: 'holo:realtime', data: { id: 'realtime.1', action: 'subscribe', name: 'records.list', args: {} } }])
    first.receive('holo:realtime:snapshot', { id: 'realtime.1', snapshot: { data: ['before'], version: 3 } })

    const mutation = transport.mutate('records.save', { title: 'pending' })
    const mutationFailure = expect(mutation).rejects.toThrow(realtimeClientInternals.unavailableTransportMessage)
    first.close()
    await mutationFailure

    await vi.advanceTimersByTimeAsync(500)
    const second = sockets[1]!
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(second.frames).toEqual([{ event: 'holo:realtime', data: { id: 'realtime.1', action: 'subscribe', name: 'records.list', args: {} } }])

    second.receive('holo:realtime:snapshot', { id: 'realtime.1', snapshot: { data: ['after'], version: 1 } })
    expect(snapshots).toEqual([['before'], ['after']])
    expect(sockets).toHaveLength(2)
  })

  it('keeps a subscription made during recovery and sends it once the reconnect succeeds', async () => {
    vi.useFakeTimers()
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    transport.subscribe('records.list', {}, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.close()

    await vi.advanceTimersByTimeAsync(500)
    const errors: unknown[] = []
    transport.subscribe('orders.list', {}, () => {}, error => errors.push(error))
    sockets[1]!.emit('error')
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])

    await vi.advanceTimersByTimeAsync(30_000)
    const recovered = sockets[2]!
    recovered.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([])
    expect(recovered.frames.map(frame => (frame.data as { name: string }).name)).toEqual(['records.list', 'orders.list'])
  })

  it('reports a subscription that cannot be serialized and still replays the others after a reconnect', async () => {
    vi.useFakeTimers()
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    const rejected: unknown[] = []
    const snapshots: unknown[] = []
    transport.subscribe('records.broken', { id: 1n }, () => {}, error => rejected.push(error))
    transport.subscribe('records.list', {}, snapshot => snapshots.push(snapshot.data), () => {})
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).toHaveLength(1)

    sockets[0]!.receive('holo:realtime:snapshot', { id: 'realtime.2', snapshot: { data: ['before'], version: 1 } })
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(500)
    const recovered = sockets[1]!
    recovered.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(recovered.frames.map(frame => (frame.data as { name: string }).name)).toEqual(['records.list'])
    expect(rejected).toHaveLength(1)
  })

  it('does not replay a subscription that a failing sibling removed during the same reconnect', async () => {
    vi.useFakeTimers()
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    let leaveSecond = () => {}
    transport.subscribe('records.broken', { id: 1n }, () => {}, () => leaveSecond())
    const second = transport.subscribe('orders.list', {}, () => {}, () => {})
    leaveSecond = second
    transport.subscribe('records.list', {}, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribeNames(sockets[0]!)).toEqual(['records.list'])
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(500)

    const recovered = sockets[1]!
    recovered.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribeNames(recovered)).toEqual(['records.list'])
  })

  it('stops reconnecting when the last subscription is removed during a backoff wait', async () => {
    vi.useFakeTimers()
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    const leave = transport.subscribe('records.list', {}, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.close()

    leave()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
  })
})
