import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'
import type { InternalRealtimeSubscribeOptions } from '../src/runtime/state'
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

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'])) {
  it(`keeps native ${driver} undefined array results consistent with JSON browser snapshots`, async () => {
    const { db, table } = await openDatabase(driver)
    onTestFinished(resetRealtimeRuntime)
    await db.table(table.tableName).insert([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = async () => (await db.table(table.tableName).orderBy('id').get()).map(row => row.name === 'Missing' ? undefined : row.name)
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    const deliveries: unknown[] = []
    const nativeResults: Awaited<ReturnType<typeof handler>>[] = []
    const errors: unknown[] = []
    const leave = transport.subscribe('records.transformed', {}, snapshot => deliveries.push(snapshot.data), error => errors.push(error))
    onTestFinished(leave)
    await expect.poll(() => sockets.length).toBe(1)
    const socket = sockets[0]!
    socket.open()
    await expect.poll(() => socket.frames.length).toBe(1)
    const { id } = socket.frames[0]!.data as { id: string }
    const options: InternalRealtimeSubscribeOptions<Awaited<ReturnType<typeof handler>>> = {
      onData: snapshot => {
        nativeResults.push(snapshot.data)
        socket.receive('holo:realtime:snapshot', { id, snapshot })
      },
      onPatch: patch => socket.receive('holo:realtime:patch', { id, patch }),
      onError: error => { errors.push(error) },
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)
    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table(table.tableName).where('id', 1).update({ name: 'Missing' }),
    }))
    const fresh = await handler()
    expect(fresh).toEqual([undefined, 'Second'])
    expect(errors).toEqual([])
    expect(subscription.current.data).toEqual(fresh)
    expect(deliveries).toEqual([['First', 'Second'], [null, 'Second']])
    expect(nativeResults.at(-1)).toEqual(fresh)
  })

  it.each(['__proto__', 'constructor', 'prototype'])(`delivers native ${driver} transformed own %s properties through the browser transport`, async key => {
    const { db, table } = await openDatabase(driver)
    onTestFinished(resetRealtimeRuntime)
    await db.table(table.tableName).insert([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = async () => {
      const count = await db.table(table.tableName).count()
      return [
        { [key]: 'metadata', double: count * 2, triple: count * 3 },
        { [key]: { double: count * 2 } },
      ]
    }
    const sockets = installFakeRealtimeBroadcast()
    const transport = createBroadcastRealtimeTransport()
    const deliveries: unknown[] = []
    const errors: unknown[] = []
    const leave = transport.subscribe('records.transformed', {}, snapshot => deliveries.push(snapshot.data), error => errors.push(error))
    onTestFinished(leave)
    await expect.poll(() => sockets.length).toBe(1)
    const socket = sockets[0]!
    socket.open()
    await expect.poll(() => socket.frames.length).toBe(1)
    const { id } = socket.frames[0]!.data as { id: string }
    const options: InternalRealtimeSubscribeOptions<Awaited<ReturnType<typeof handler>>> = {
      onData: snapshot => socket.receive('holo:realtime:snapshot', { id, snapshot }),
      onPatch: patch => socket.receive('holo:realtime:patch', { id, patch }),
      onError: error => { errors.push(error) },
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)
    const initial = [
      { [key]: 'metadata', double: 4, triple: 6 },
      { [key]: { double: 4 } },
    ]
    expect(deliveries).toEqual([initial])
    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table(table.tableName).insert({ id: 3, name: 'Third' }),
    }))
    const fresh = await handler()
    expect(fresh).toEqual([
      { [key]: 'metadata', double: 6, triple: 9 },
      { [key]: { double: 6 } },
    ])
    expect(errors).toEqual([])
    expect(subscription.current.data).toEqual(fresh)
    expect(deliveries).toEqual([initial, fresh])
  })
}

it.each([
  ['800 repeated primitive values', 800, 1, 'tail'],
  ['100 by 200 nested repeated values', 100, 200, 'tail'],
  ['1600 by 200 nested repeated values with two changes', 1600, 200, 'middle-and-tail'],
  ['4000 empty records with one 4000-key endpoint', 4000, 4000, 'head-record'],
  ['1200-level chain with equal siblings', 1, 1200, 'chain'],
] as const)('refreshes %s and yields after a change', async (_label, rowCount, columnCount, change) => {
  const { db, table } = await openDatabase('sqlite')
  onTestFinished(resetRealtimeRuntime)
  await db.table(table.tableName).insert(Array.from({ length: rowCount }, (_, index) => ({ id: index + 1, name: 'Open' })))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const recordValue = change === 'head-record' ? Object.fromEntries<number>(Array.from({ length: columnCount }, (_, index) => [`field_${index}`, index] as const)) : {}
  type ChainValue = { value: unknown } | { same: string, next: ChainValue }
  const makeChain = (value: unknown): ChainValue => {
    let node: ChainValue = { value }
    for (let depth = 0; depth < columnCount; depth += 1) node = { same: 'Open', next: node }
    return node
  }
  const handler = async () => {
    const rows = await db.table(table.tableName).orderBy('id').get()
    if (change === 'chain') return makeChain(rows[0]?.name)
    return rows.map(row => change === 'head-record'
      ? row.name === 'Closed' ? recordValue : {}
      : columnCount === 1 ? row.name : Array.from({ length: columnCount }, (_, index) => index === columnCount - 1 ? row.name : 'Open'))
  }
  const sockets = installFakeRealtimeBroadcast()
  const transport = createBroadcastRealtimeTransport()
  const deliveries: unknown[] = []
  const errors: unknown[] = []
  const leave = transport.subscribe('records.repeated', {}, snapshot => deliveries.push(snapshot.data), error => errors.push(error))
  onTestFinished(leave)
  await expect.poll(() => sockets.length).toBe(1)
  const socket = sockets[0]!
  socket.open()
  await expect.poll(() => socket.frames.length).toBe(1)
  const { id } = socket.frames[0]!.data as { id: string }
  const options: InternalRealtimeSubscribeOptions<Awaited<ReturnType<typeof handler>>> = {
    onData: snapshot => socket.receive('holo:realtime:snapshot', { id, snapshot }),
    onPatch: patch => socket.receive('holo:realtime:patch', { id, patch }),
    onError: error => { errors.push(error) },
  }
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)
  const initial = Array.from({ length: rowCount }, () => change === 'head-record' || change === 'chain' ? {} : columnCount === 1 ? 'Open' : Array.from({ length: columnCount }, () => 'Open'))
  if (change === 'chain') expect(JSON.stringify(deliveries)).toBe(JSON.stringify([makeChain('Open')]))
  else expect(deliveries).toEqual([initial])
  const changedIds = change === 'middle-and-tail' ? [rowCount / 2, rowCount] : [change === 'head-record' ? 1 : rowCount]
  await executeRealtimeMutation(defineRealtimeMutation({
    access: 'public',
    handler: () => db.table(table.tableName).whereIn('id', changedIds).update({ name: 'Closed' }),
  }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const fresh = await handler()
  expect(errors).toEqual([])
  if (change === 'chain') {
    const expected = JSON.stringify(makeChain('Closed'))
    expect(JSON.stringify(fresh)).toBe(expected)
    expect(JSON.stringify(subscription.current.data)).toBe(expected)
    expect(JSON.stringify(deliveries.at(-1))).toBe(expected)
  } else {
    expect(fresh).toEqual(initial.map((value, index) => changedIds.includes(index + 1)
      ? change === 'head-record' ? recordValue : columnCount === 1 ? 'Closed' : [...Array.from({ length: columnCount - 1 }, () => 'Open'), 'Closed']
      : value))
    expect(subscription.current.data).toEqual(fresh)
    expect(deliveries.at(-1)).toEqual(fresh)
  }
})
