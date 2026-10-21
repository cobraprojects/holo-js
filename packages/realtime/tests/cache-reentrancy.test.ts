import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { onDatabaseDependencyInvalidated, registerDatabaseDriverFactory } from '@holo-js/db'
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { cacheDbInternals, createDatabaseCacheDriver } from '../../cache-db/src'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
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

it('settles when a refresh writes its cache row into a write batch that is still pending', async () => {
  const { db } = await openRealtimeDatabase()
  await openCacheDatabaseStore()
  let holding = false
  let reachedHold = false
  let releaseHeld: () => void = () => undefined
  const held = new Promise<void>(resolve => { releaseHeld = resolve })
  const cachedScore = query({
    name: 'records.heldCachedScore',
    access: 'public',
    handler: async () => {
      if (holding) {
        reachedHold = true
        await held
      }
      const [row] = await db.table('records').where('id', 1).cache({ ttl: 60 }).get<{ score: number | null }>()
      return { score: row?.score ?? null }
    },
  })
  const subscription = await subscribeRealtimeQuery(cachedScore)
  holding = true
  onTestFinished(onDatabaseDependencyInvalidated((event) => {
    if (reachedHold && event.dependencies.includes('db:main:records')) releaseHeld()
  }))

  const firstWrite = db.table('records').where('id', 1).update({ score: 55 })
  await expect.poll(() => reachedHold, { timeout: 2_000 }).toBe(true)
  const secondWrite = db.table('records').where('id', 1).update({ score: 56 })

  await settleWithin(secondWrite, 2_000)
  await settleWithin(firstWrite, 2_000)
  await expect.poll(() => subscription.current.data, { timeout: 2_000 }).toEqual({ score: 56 })
})
