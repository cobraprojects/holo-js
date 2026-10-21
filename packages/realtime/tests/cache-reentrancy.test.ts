import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { onDatabaseDependencyInvalidated, registerDatabaseDriverFactory } from '@holo-js/db'
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { cacheDbInternals, createDatabaseCacheDriver } from '../../cache-db/src'
import cache, { configureCacheRuntime, defineCacheKey, resetCacheRuntime } from '../../cache/src'
import { query } from '../src'
import { realtimeServerInternals, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

const temporaryDirectories: string[] = []

registerDatabaseDriverFactory(sqliteDatabaseDriverFactory)

afterEach(async () => {
  resetCacheRuntime()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function openCacheDatabaseStore() {
  const directory = await mkdtemp(join(tmpdir(), 'holo-realtime-cache-db-'))
  temporaryDirectories.push(directory)
  const connection = { driver: 'sqlite' as const, filename: join(directory, 'cache.sqlite') }
  await cacheDbInternals.prepareCacheDatabaseTables(cacheDbInternals.createDatabaseConnection('cache', connection))
  const driver = createDatabaseCacheDriver({
    name: 'database',
    connectionName: 'cache',
    table: 'cache',
    lockTable: 'cache_locks',
    connection,
  })
  configureCacheRuntime({
    config: { default: 'database', drivers: { database: { driver: 'database', connection: 'cache', table: 'cache', lockTable: 'cache_locks' } } },
    drivers: new Map([['database', driver]]),
  })
  onTestFinished(() => resetCacheRuntime())
}

function remoteInvalidation(dependencies: readonly string[]) {
  return { id: randomUUID(), connectionName: 'main', dependencies }
}

function settleWithin<TValue>(operation: PromiseLike<TValue>, milliseconds: number): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Operation did not settle within ${milliseconds} ms.`)), milliseconds)
    Promise.resolve(operation).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

it('refreshes a cached realtime query once when a local write refreshes it and the refresh writes its cache row', async () => {
  const { db } = await openRealtimeDatabase()
  await openCacheDatabaseStore()
  let runs = 0
  const cachedScore = query({
    name: 'records.cachedScore',
    access: 'public',
    handler: async () => {
      runs += 1
      const [row] = await db.table('records').where('id', 1).cache({ ttl: 60 }).get<{ score: number | null }>()
      return { score: row?.score ?? null }
    },
  })
  const subscription = await subscribeRealtimeQuery(cachedScore)
  const before = runs

  await settleWithin(db.table('records').where('id', 1).update({ score: 99 }), 2_000)

  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ score: 99 })
  expect(runs - before).toBe(1)
})

it('refreshes a cached realtime query once for a remote invalidation whose refresh writes its cache row', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  await openCacheDatabaseStore()
  let runs = 0
  const cachedScore = query({
    name: 'records.cachedRemoteScore',
    access: 'public',
    handler: async () => {
      runs += 1
      const [row] = await db.table('records').where('id', 1).cache({ ttl: 60 }).get<{ score: number | null }>()
      return { score: row?.score ?? null }
    },
  })
  const subscription = await subscribeRealtimeQuery(cachedScore)
  const before = runs
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await adapter.execute('UPDATE records SET score = 77 WHERE id = 1')
  await settleWithin(bridge.receive(remoteInvalidation(['db:main:records'])), 2_000)

  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ score: 77 })
  expect(runs - before).toBe(1)
})

it('refreshes a live query that reads the cache store directly when a later cache write changes the value', async () => {
  await openRealtimeDatabase()
  await openCacheDatabaseStore()
  const themeKey = defineCacheKey<string>('theme')
  await cache.put(themeKey, 'light', 60)
  const theme = query({
    name: 'theme.current',
    access: 'public',
    handler: async () => ({ theme: await cache.get(themeKey) }),
  })
  const subscription = await subscribeRealtimeQuery(theme)
  expect(subscription.current.data).toEqual({ theme: 'light' })

  await settleWithin(cache.put(themeKey, 'dark', 60), 2_000)

  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ theme: 'dark' })
})

it('refreshes a memory-cached realtime query for a remote write', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  configureCacheRuntime({
    config: { default: 'memory', drivers: { memory: { driver: 'memory' } } },
  })
  onTestFinished(() => resetCacheRuntime())
  const cachedScore = query({
    name: 'records.memoryCachedScore',
    access: 'public',
    handler: async () => {
      const [row] = await db.table('records').where('id', 1).cache({ ttl: 60 }).get<{ score: number | null }>()
      return { score: row?.score ?? null }
    },
  })
  const subscription = await subscribeRealtimeQuery(cachedScore)
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await adapter.execute('UPDATE records SET score = 66 WHERE id = 1')
  await settleWithin(bridge.receive(remoteInvalidation(['db:main:records'])), 2_000)

  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ score: 66 })
})

it('settles a refresh whose own handler writes a table the refresh reads, and runs the handler once more for that write', async () => {
  const { db } = await openRealtimeDatabase()
  let runs = 0
  let writeNext = false
  const selfWriting = query({
    name: 'records.selfWriting',
    access: 'public',
    handler: async () => {
      runs += 1
      const before = await db.table('records').where('id', 1).value('score')
      if (writeNext) {
        writeNext = false
        await db.table('records').where('id', 1).update({ score: 88 })
      }
      return { before, score: await db.table('records').where('id', 1).value('score') }
    },
  })
  const subscription = await subscribeRealtimeQuery(selfWriting)
  const before = runs
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  writeNext = true
  await settleWithin(bridge.receive(remoteInvalidation(['db:main:records'])), 2_000)

  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ before: 88, score: 88 })
  expect(runs - before).toBe(2)
})

function createDeferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((next) => { resolve = next })
  return { promise, resolve }
}

async function advanceFakeTimersUntil(done: () => boolean, description: string): Promise<void> {
  for (let turn = 0; !done(); turn += 1) {
    if (turn === 1000) throw new Error(`Timed out waiting for ${description}.`)
    await new Promise(resolve => setImmediate(resolve))
    if (done()) return
    vi.advanceTimersByTime(10)
  }
}

it('settles when a refresh writes its cache row into a write batch that is still pending', async () => {
  const { db } = await openRealtimeDatabase()
  await openCacheDatabaseStore()
  let holding = false
  let reachedHold = false
  let released = false
  const held = createDeferred()
  const cacheWriteJoined = createDeferred()
  const cachedScore = query({
    name: 'records.heldCachedScore',
    access: 'public',
    handler: async () => {
      if (holding) {
        reachedHold = true
        await held.promise
      }
      const [row] = await db.table('records').where('id', 1).get<{ score: number | null }>()
      await cache.put('realtime:pending-batch', row?.score ?? null, 60)
      return { score: row?.score ?? null }
    },
  })
  const subscription = await subscribeRealtimeQuery(cachedScore)
  holding = true
  onTestFinished(onDatabaseDependencyInvalidated((event) => {
    if (reachedHold && !released && event.dependencies.includes('db:main:records')) {
      released = true
      held.resolve()
    } else if (released && event.dependencies.includes('db:cache:cache')) {
      cacheWriteJoined.resolve()
    }
  }))
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })

  const firstWrite = db.table('records').where('id', 1).update({ score: 55 })
  let firstSettled = false
  void Promise.resolve(firstWrite).then(() => { firstSettled = true })
  await advanceFakeTimersUntil(() => reachedHold, 'the first refresh to reach its hold')

  const secondWrite = db.table('records').where('id', 1).update({ score: 56 })
  let secondSettled = false
  void Promise.resolve(secondWrite).then(() => { secondSettled = true })
  await advanceFakeTimersUntil(() => released, 'the second write to reach the realtime listener')
  await cacheWriteJoined.promise

  await advanceFakeTimersUntil(
    () => firstSettled && secondSettled && JSON.stringify(subscription.current.data) === JSON.stringify({ score: 56 }),
    'the second write to settle and the subscriber to receive its result',
  )
  expect(subscription.current.data).toEqual({ score: 56 })
})
