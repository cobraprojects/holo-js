import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createPortReservation } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'
import { normalizeBroadcastConfig, startBroadcastWorker } from '@holo-js/broadcast'
import { renderBroadcastClientConfigResponse } from '@holo-js/broadcast/client-config'
import { defineRealtimeQuery, type RealtimeSubscriptionSnapshot } from '../src'
import { configureRealtimeClientTransport, createBroadcastRealtimeTransport, getRealtimeQueryStore, hydrateRealtimeQuery, resetRealtimeClientRuntime } from '../src/client'
import { executeRealtimeQuery, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

async function startNativeQueryTransport() {
  const database = await openRealtimeDatabase()
  const definition = defineRealtimeQuery({
    name: 'records.list',
    access: 'public',
    handler: () => database.db.table('records').orderBy('id').get<{ id: number, score: number | null }>(),
  })
  const resolveDefinition = (name: string) => {
    if (name !== definition.name) throw new Error(`Unknown query: ${name}`)
    return definition
  }
  const reservation = createPortReservation()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No broadcast port available')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const config = normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret', options: { host: '127.0.0.1', port: address.port, scheme: 'http' } } },
    worker: { host: '127.0.0.1', port: address.port, statsEnabled: true },
  })
  const startWorker = () => startBroadcastWorker({
    config,
    realtime: {
      query: name => executeRealtimeQuery(resolveDefinition(name)),
      mutate: async () => { throw new Error('No mutation configured') },
      subscribe: (name, _args, options) => subscribeRealtimeQuery(resolveDefinition(name), {}, options),
    },
  })
  let worker = await startWorker()
  const http = createServer((_request, response) => {
    const configResponse = renderBroadcastClientConfigResponse(config)
    response.writeHead(configResponse.status, Object.fromEntries(configResponse.headers))
    void configResponse.text().then(body => response.end(body))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const httpAddress = http.address()
  if (!httpAddress || typeof httpAddress === 'string') throw new Error('No configuration port available')
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await worker.stop()
  }
  const restart = async (): Promise<void> => {
    await stop()
    worker = await startWorker()
    stopped = false
  }
  onTestFinished(async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    await stop()
  })
  return {
    database,
    definition,
    stop,
    restart,
    transport: createBroadcastRealtimeTransport({ configEndpoint: `http://127.0.0.1:${httpAddress.port}/broadcasting/config` }),
    async connections(): Promise<number> {
      const response = await fetch(`http://127.0.0.1:${worker.port}/stats`)
      expect(response.status).toBe(200)
      return (await response.json() as { connectionCount: number }).connectionCount
    },
  }
}

it('shares a real worker connection, delivers committed database changes, and reconnects with the latest rows', async () => {
  const native = await startNativeQueryTransport()
  const first: RealtimeSubscriptionSnapshot<readonly { id: number, score: number | null }[]>[] = []
  const second: typeof first = []
  const errors: unknown[] = []
  const leaveFirst = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => first.push(snapshot), error => errors.push(error))
  const leaveSecond = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => second.push(snapshot), error => errors.push(error))
  await expect.poll(() => first.length + errors.length).toBeGreaterThan(0)
  expect(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')).toEqual([])
  await expect.poll(() => first.length).toBe(1)
  await expect.poll(() => second.length).toBe(1)
  expect(await native.connections()).toBe(1)
  await native.database.db.table('records').where('id', 1).update({ score: 42 })
  await expect.poll(() => first.at(-1)?.data[0]?.score).toBe(42)
  await expect.poll(() => second.at(-1)?.data[0]?.score).toBe(42)
  leaveFirst()
  await native.database.db.table('records').where('id', 1).update({ score: 43 })
  await expect.poll(() => second.at(-1)?.data[0]?.score).toBe(43)
  expect(first.at(-1)?.data[0]?.score).toBe(42)
  expect(await native.connections()).toBe(1)
  leaveSecond()
  await expect.poll(() => native.connections()).toBe(0)
  const reconnected: typeof first = []
  const leaveReconnected = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => reconnected.push(snapshot), error => errors.push(error))
  await expect.poll(() => reconnected.at(-1)?.data[0]?.score).toBe(43)
  expect(await native.connections()).toBe(1)
  expect(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')).toEqual([])
  leaveReconnected()
  await expect.poll(() => native.connections()).toBe(0)
})

it('hydrates a public query store, shares unchanged rows across real patches, and releases its worker on reset', async () => {
  const native = await startNativeQueryTransport()
  onTestFinished(resetRealtimeClientRuntime)
  configureRealtimeClientTransport(native.transport)
  const initial = await subscribeRealtimeQuery(native.definition)
  hydrateRealtimeQuery(native.definition, {}, initial.current)
  initial.unsubscribe()
  const store = getRealtimeQueryStore(native.definition, {})
  const firstLoad = store.load()
  expect(store.load()).toBe(firstLoad)
  await firstLoad
  const unchangedRow = store.snapshot?.data[1]
  const notifications: number[] = []
  const leaveFirst = store.subscribe(() => notifications.push(1))
  const leaveSecond = store.subscribe(() => notifications.push(2))
  store.connect()
  const ready: unknown[] = []
  const leaveBarrier = native.transport.subscribe('records.list', {}, snapshot => ready.push(snapshot), error => { throw error })
  await expect.poll(() => ready.length).toBe(1)
  await expect.poll(() => native.connections()).toBe(1)
  await native.database.db.table('records').where('id', 1).update({ score: 42 })
  await expect.poll(() => store.snapshot?.data[0]?.score).toBe(42)
  expect(store.snapshot?.data[1]).toBe(unchangedRow)
  expect(notifications).toEqual([1, 2])
  leaveFirst()
  expect(await native.connections()).toBe(1)
  leaveBarrier()
  resetRealtimeClientRuntime()
  await expect.poll(() => native.connections()).toBe(0)
  await native.database.db.table('records').where('id', 1).update({ score: 43 })
  expect(store.snapshot?.data[0]?.score).toBe(42)
  expect(notifications).toEqual([1, 2])
  leaveSecond()
})

it('reports native query rejection once with a generic message and continues delivering an independent valid subscription', async () => {
  const native = await startNativeQueryTransport()
  const errors: string[] = []
  const rejected: unknown[] = []
  const leaveRejected = native.transport.subscribe('missing.query', {}, snapshot => rejected.push(snapshot), error => errors.push(error instanceof Error ? error.message : String(error)))
  const snapshots: RealtimeSubscriptionSnapshot<readonly { id: number, score: number | null }[]>[] = []
  const leaveValid = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => snapshots.push(snapshot), error => { throw error })
  await expect.poll(() => errors).toEqual(['Realtime request failed.'])
  await expect.poll(() => snapshots.length).toBe(1)
  await native.database.db.table('records').where('id', 1).update({ score: 42 })
  await expect.poll(() => snapshots.at(-1)?.data[0]?.score).toBe(42)
  expect(rejected).toEqual([])
  expect(errors).toEqual(['Realtime request failed.'])
  leaveRejected()
  leaveValid()
  await expect.poll(() => native.connections()).toBe(0)
})

it('reports an unavailable real worker once without fabricating a snapshot', async () => {
  const native = await startNativeQueryTransport()
  await native.stop()
  const snapshots: unknown[] = []
  const errors: string[] = []
  const leave = native.transport.subscribe('records.list', {}, snapshot => snapshots.push(snapshot), error => errors.push(error instanceof Error ? error.message : String(error)))
  await expect.poll(() => errors).toEqual(['Realtime live updates are unavailable because the broadcast worker is not reachable. Start the worker with "holo broadcast:work" to enable live updates.'])
  expect(snapshots).toEqual([])
  leave()
  expect(errors).toHaveLength(1)
})

it('keeps each active subscription through a real worker shutdown without reporting an error and delivers rows changed while it was down', async () => {
  const native = await startNativeQueryTransport()
  const first: RealtimeSubscriptionSnapshot<readonly { id: number, score: number | null }[]>[] = []
  const second: typeof first = []
  const errors: unknown[] = []
  const onError = (error: unknown) => errors.push(error)
  const leaveFirst = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => first.push(snapshot), onError)
  const leaveSecond = native.transport.subscribe<readonly { id: number, score: number | null }[]>('records.list', {}, snapshot => second.push(snapshot), onError)
  await expect.poll(() => first.length).toBe(1)
  await expect.poll(() => second.length).toBe(1)
  await native.stop()
  await native.database.db.table('records').where('id', 1).update({ score: 42 })
  await native.restart()
  await expect.poll(() => first.at(-1)?.data[0]?.score, { timeout: 10_000 }).toBe(42)
  await expect.poll(() => second.at(-1)?.data[0]?.score, { timeout: 10_000 }).toBe(42)
  expect(errors).toEqual([])
  leaveFirst()
  leaveSecond()
  await expect.poll(() => native.connections()).toBe(0)
}, 20_000)

it('recovers a live query after the worker restarts at the same address and delivers rows changed while it was down', async () => {
  const native = await startNativeQueryTransport()
  onTestFinished(resetRealtimeClientRuntime)
  configureRealtimeClientTransport(native.transport)
  const initial = await subscribeRealtimeQuery(native.definition)
  hydrateRealtimeQuery(native.definition, {}, initial.current)
  initial.unsubscribe()
  const store = getRealtimeQueryStore(native.definition, {})
  await store.load()
  const leaveStore = store.subscribe(() => {})
  store.connect()
  await expect.poll(() => native.connections()).toBe(1)
  await native.database.db.table('records').where('id', 1).update({ score: 42 })
  await expect.poll(() => store.snapshot?.data[0]?.score).toBe(42)

  await native.stop()
  await native.database.db.table('records').where('id', 1).update({ score: 43 })
  await native.restart()

  await expect.poll(() => native.connections(), { timeout: 10_000 }).toBe(1)
  await expect.poll(() => store.snapshot?.data[0]?.score, { timeout: 10_000 }).toBe(43)
  leaveStore()
}, 20_000)
