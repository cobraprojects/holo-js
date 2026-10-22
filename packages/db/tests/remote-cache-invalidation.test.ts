import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { cacheQueryBridgeInternals, configureCacheRuntime, resetCacheRuntime, type CacheDriverContract, type CacheDriverPutInput } from '../../cache/src'
import { createMemoryCacheDriver } from '../../cache/src/memory'
import { DB, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, queryCacheInternals, resetDB } from '../src'
import { defineTable } from './support/internal'

const users = defineTable('users', { id: column.id(), name: column.string(), score: column.integer() })
const posts = defineTable('posts', { id: column.id(), title: column.string() })
const cacheConfig = { default: 'memory', drivers: { memory: { driver: 'memory' } } } as const

let adapter: ReturnType<typeof createSQLiteAdapter>

beforeEach(async () => {
  resetDB()
  resetCacheRuntime()
  queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
  adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ connectionName: 'main', adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  await createSchemaService(db).createTable('users', table => {
    table.id()
    table.string('name')
    table.integer('score')
  })
  await createSchemaService(db).createTable('posts', table => {
    table.id()
    table.string('title')
  })
  await DB.table(users).insert([{ name: 'Ava', score: 10 }])
  await DB.table(posts).insert([{ title: 'old' }])
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetCacheRuntime()
  resetDB()
  await adapter.disconnect()
})

function createInstrumentedIndex(forgetDelayMs: number) {
  const base = cacheQueryBridgeInternals.createMemoryDependencyIndex()
  const counters = { removeKeyCalls: [] as string[], listDependencyPasses: 0 }
  const index = {
    ...base,
    async listDependencies() {
      counters.listDependencyPasses += 1
      return (await base.listDependencies?.()) ?? []
    },
    async removeKey(key: string) {
      counters.removeKeyCalls.push(key)
      await new Promise(resolve => setTimeout(resolve, forgetDelayMs))
      return base.removeKey(key)
    },
  }
  return { index, counters }
}

function remoteTableInvalidation(table: string) {
  return queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ id: randomUUID(), connectionName: 'main', dependencies: [`db:main:${table}`] })
}

function holdNextCacheWrite() {
  const driver = createMemoryCacheDriver({ name: 'memory' })
  const put = driver.put.bind(driver)
  const reached = deferred()
  const released = deferred()
  let armed = true
  const heldDriver: CacheDriverContract = {
    ...driver,
    async put(input: CacheDriverPutInput) {
      if (armed) {
        armed = false
        reached.resolve()
        await released.promise
      }
      return put(input)
    },
  }
  configureCacheRuntime({
    config: cacheConfig,
    dependencyIndex: cacheQueryBridgeInternals.createMemoryDependencyIndex(),
    drivers: new Map([['memory', heldDriver]]),
  })
  return { reached: reached.promise, release: () => released.resolve() }
}

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function countSelects(): { readonly count: () => number } {
  const original = adapter.query.bind(adapter)
  let selects = 0
  vi.spyOn(adapter, 'query').mockImplementation(async (sql: string, bindings?: readonly unknown[]) => {
    if (/^\s*select/i.test(sql)) {
      selects += 1
    }
    return original(sql, bindings)
  })
  return { count: () => selects }
}

function useFreshDependencyIndex() {
  configureCacheRuntime({ config: cacheConfig, dependencyIndex: cacheQueryBridgeInternals.createMemoryDependencyIndex() })
}

it('coalesces a burst of remote table invalidations into at most one eviction pass', async () => {
  const { index, counters } = createInstrumentedIndex(40)
  configureCacheRuntime({ config: cacheConfig, dependencyIndex: index })
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(10)
  counters.removeKeyCalls.length = 0
  counters.listDependencyPasses = 0

  await Promise.all(Array.from({ length: 8 }, () => remoteTableInvalidation('users')))

  expect(counters.listDependencyPasses).toBeLessThanOrEqual(2)
  expect(counters.removeKeyCalls.length).toBeLessThanOrEqual(2)
})

it('evicts a table token that arrives while an eviction pass is running', async () => {
  const { index } = createInstrumentedIndex(40)
  configureCacheRuntime({ config: cacheConfig, dependencyIndex: index })
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(10)
  expect(await DB.table(posts).where('id', 1).cache(60).value('title')).toBe('old')
  await adapter.execute('UPDATE users SET score = 99 WHERE id = 1')
  await adapter.execute("UPDATE posts SET title = 'new' WHERE id = 1")

  const first = remoteTableInvalidation('users')
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = remoteTableInvalidation('posts')
  await Promise.all([first, second])

  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(99)
  expect(await DB.table(posts).where('id', 1).cache(60).value('title')).toBe('new')
})

it('does not keep a query fill that a remote invalidation overtook while it was reading', async () => {
  const hold = holdNextCacheWrite()
  const fill = DB.table(users).where('id', 1).cache(60).value('score')
  await hold.reached
  await adapter.execute('UPDATE users SET score = 99 WHERE id = 1')
  await remoteTableInvalidation('users')
  hold.release()
  expect(await fill).toBe(10)

  const selects = countSelects()
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(99)
  expect(selects.count()).toBe(1)
})

it('does not keep a query fill that a local write overtook while it was reading', async () => {
  const hold = holdNextCacheWrite()
  const fill = DB.table(users).where('id', 1).cache(60).value('score')
  await hold.reached
  await DB.table(users).where('id', 1).update({ score: 99 })
  hold.release()
  expect(await fill).toBe(10)

  const selects = countSelects()
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(99)
  expect(selects.count()).toBe(1)
})

it('keeps a query fill cached when no invalidation for its table runs while it reads', async () => {
  useFreshDependencyIndex()
  const selects = countSelects()
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(10)
  expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(10)
  expect(selects.count()).toBe(1)
})
