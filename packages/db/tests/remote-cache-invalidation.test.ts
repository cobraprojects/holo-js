import { afterEach, beforeEach, expect, it } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { cacheQueryBridgeInternals, configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
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
  return queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ connectionName: 'main', dependencies: [`db:main:${table}`] })
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
