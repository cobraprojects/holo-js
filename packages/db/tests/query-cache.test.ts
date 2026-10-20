import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import cache, { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import {
  DB, collectDatabaseQueryDependencies, column, configureDB, createConnectionManager,
  createDatabase, createDialect, createSchemaService, queryCacheInternals, resetDB,
  type DatabaseContext, type DatabaseLogger, type DatabaseDependencyInvalidationEvent,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import type { DatabaseMutationEvent, RemoteDatabaseDependencyInvalidation } from '../src/cache'

const users = defineTable('users', {
  id: column.id(), name: column.string(), status: column.string(), score: column.integer(),
  settings: column.json<{ region: string }>().nullable(), created_at: column.timestamp().nullable(),
})

describe('native database and cache integration', () => {
  let adapter: ReturnType<typeof createSQLiteAdapter>
  let db: DatabaseContext
  let directory: string
  const queries: Parameters<NonNullable<DatabaseLogger['onQuerySuccess']>>[0][] = []

  beforeEach(async () => {
    resetDB()
    resetCacheRuntime()
    queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
    queries.length = 0
    directory = await mkdtemp(join(tmpdir(), 'holo-native-query-cache-'))
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' }, file: { driver: 'file', path: directory } } } })
    adapter = createSQLiteAdapter({ filename: ':memory:' })
    db = createDatabase({
      connectionName: 'main', adapter, dialect: createDialect('sqlite'),
      logger: { onQuerySuccess: entry => { queries.push(entry) } },
      security: { allowUnsafeRawSql: true, debugSqlInLogs: true },
    })
    configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
    await createSchemaService(db).createTable('users', table => {
      table.id(); table.string('name').unique(); table.string('status').default('active')
      table.integer('score').default(0); table.json('settings').nullable(); table.timestamp('created_at').nullable()
    })
    await DB.table(users).insert([
      { name: 'Ava', status: 'active', score: 10, settings: { region: 'eu' }, created_at: new Date('2026-01-01') },
      { name: 'Ben', status: 'inactive', score: 20, settings: { region: 'us' }, created_at: null },
    ])
    queries.length = 0
  })

  afterEach(async () => {
    queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
    resetCacheRuntime()
    resetDB()
    await adapter?.disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const names = () => DB.table(users).orderBy('id').cache(60).pluck('name')

  it('isolates cached rows, counts and existence with an explicit key and invalidates them after writes', async () => {
    const query = DB.table(users).cache({ key: 'users.shared', ttl: 60 })
    expect(await query.count()).toBe(2)
    expect(await query.exists()).toBe(true)
    expect(await query.get()).toHaveLength(2)
    expect(await query.count()).toBe(2)
    expect(await query.exists()).toBe(true)
    expect(queries.filter(entry => entry.sql.startsWith('SELECT')).map(entry => entry.rowCount)).toEqual([1, 1, 2])
    await DB.table(users).delete()
    expect(await query.count()).toBe(0)
    expect(await query.exists()).toBe(false)
    expect(await query.get()).toEqual([])
  })

  it('caches real query results with distinct bound-value keys and explicit file keys', async () => {
    const first = await DB.table(users).where('id', 1).cache(60).first()
    await adapter.execute("UPDATE users SET name = 'Outside' WHERE id = 1")
    expect(await DB.table(users).where('id', 1).cache(60).first()).toEqual(first)
    expect((await DB.table(users).where('id', 2).cache(60).first())?.name).toBe('Ben')
    const fileQuery = DB.table(users).where('id', 1).cache({ key: 'user.file', ttl: 60, driver: 'file' })
    expect((await fileQuery.first())?.name).toBe('Outside')
    await adapter.execute("UPDATE users SET name = 'Changed again' WHERE id = 1")
    expect((await fileQuery.first())?.name).toBe('Outside')
    expect(await cache.driver('file').has('user.file')).toBe(true)
    expect(queries.filter(entry => entry.sql.startsWith('SELECT')).length).toBe(3)
  })

  it('expires cached rows using a real deadline and serializes model Date attributes', async () => {
    const User = defineModelFromTable(users, { timestamps: false })
    const query = User.where('id', 1).cache({ key: 'date-record', ttl: new Date(Date.now() + 1100) })
    expect((await query.first())?.get('created_at')).toEqual(new Date('2026-01-01'))
    await adapter.execute("UPDATE users SET name = 'After expiry' WHERE id = 1")
    expect((await query.first())?.get('name')).toBe('Ava')
    await delay(1200)
    expect((await query.first())?.get('name')).toBe('After expiry')
  })

  it('shares concurrent cache misses without issuing duplicate database reads', async () => {
    const query = DB.table(users).orderBy('id').cache(60)
    const rows = await Promise.all(Array.from({ length: 16 }, () => query.get()))
    expect(rows.every(result => result.length === 2 && result[0]?.name === 'Ava')).toBe(true)
    expect(queries.filter(entry => entry.sql.startsWith('SELECT')).length).toBe(1)
  })

  it('refreshes stale flexible results in the background while preserving the stale response', async () => {
    const query = DB.table(users).where('id', 1).cache({ key: 'flexible-user', flexible: [1, 4] })
    expect((await query.first())?.name).toBe('Ava')
    await adapter.execute("UPDATE users SET name = 'Refreshed' WHERE id = 1")
    await delay(1100)
    expect((await query.first())?.name).toBe('Ava')
    const deadline = Date.now() + 2000
    let name
    do {
      await delay(20)
      name = (await query.first())?.name
    } while (name !== 'Refreshed' && Date.now() < deadline)
    expect(name).toBe('Refreshed')
  })

  it('invalidates cached lists after inserts, updates, upserts, conflicting inserts, and deletes', async () => {
    expect(await names()).toEqual(['Ava', 'Ben'])
    const id = await DB.table(users).insertGetId({ name: 'Cara', status: 'active', score: 30 })
    expect(await names()).toEqual(['Ava', 'Ben', 'Cara'])
    await DB.table(users).where('id', id).update({ name: 'Cora' })
    expect(await names()).toEqual(['Ava', 'Ben', 'Cora'])
    await DB.table(users).upsert({ name: 'Cora', status: 'inactive', score: 40 }, ['name'], ['status', 'score'])
    expect(await DB.table(users).where('id', id).cache(60).value('score')).toBe(40)
    await DB.table(users).insertOrIgnore({ name: 'Cora', status: 'active', score: 99 })
    expect(await DB.table(users).where('id', id).cache(60).value('score')).toBe(40)
    await DB.table(users).where('id', id).delete()
    expect(await names()).toEqual(['Ava', 'Ben'])
  })

  it('invalidates cached JSON filters and numeric values after native mutations', async () => {
    const region = () => DB.table(users).whereJson('settings->region', 'eu').cache(60).pluck('name')
    const score = () => DB.table(users).where('id', 1).cache(60).value('score')
    expect(await region()).toEqual(['Ava'])
    expect(await score()).toBe(10)
    await DB.table(users).where('id', 1).increment('score', 5)
    expect(await score()).toBe(15)
    await DB.table(users).where('id', 1).decrement('score', 2)
    expect(await score()).toBe(13)
    await DB.table(users).where('id', 1).updateJson('settings->region', 'mena')
    expect(await region()).toEqual([])
  })

  it('publishes concrete counter values for each changed row after commit', async () => {
    const mutations: DatabaseMutationEvent[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { mutations?: readonly DatabaseMutationEvent[] }) => {
      mutations.push(...event.mutations ?? [])
    })
    expect(await DB.table(users).orderBy('id').cache(60).pluck('score')).toEqual([10, 20])
    await DB.transaction(async tx => {
      await tx.table(users).increment('score', 5)
      expect(mutations).toEqual([])
    })

    expect(mutations.map(mutation => mutation.values?.score)).toEqual([15, 25])
    expect(mutations.flatMap(mutation => mutation.rows ?? []).map(row => row.score)).toEqual([15, 25])
    expect(await DB.table(users).orderBy('id').cache(60).pluck('score')).toEqual([15, 25])
  })

  it('refreshes conjunctive, disjunctive, set, and projected caches when predicate values change', async () => {
    const queries = [
      DB.table(users).where(q => q.where('id', 1).where('status', 'active')),
      DB.table(users).where('id', 1).orWhere('status', 'active'),
      DB.table(users).whereIn('id', [1, 2]).where('status', 'active'),
      DB.table(users).select('name').where('status', 'active'),
    ]
    for (const query of queries) expect(await query.orderBy('id').cache(60).pluck('name')).toEqual(['Ava'])
    await DB.table(users).where('id', 1).update({ status: 'inactive' })
    for (const [index, query] of queries.entries()) expect(await query.orderBy('id').cache(60).pluck('name')).toEqual(index === 1 ? ['Ava'] : [])
  })

  it('invalidates cached aggregate, pagination, and cursor results after writes', async () => {
    const total = () => DB.table(users).selectSum('total', 'score').cache(60).value('total')
    const page = () => DB.table(users).orderBy('id').cache(60).paginate(1)
    const cursor = () => DB.table(users).orderBy('id').cache(60).cursorPaginate(1)
    expect(await total()).toBe(30)
    expect((await page()).meta.total).toBe(2)
    expect((await cursor()).data[0]?.name).toBe('Ava')
    await DB.table(users).where('id', 1).update({ name: 'Changed', score: 50 })
    await DB.table(users).insert({ name: 'Cara', status: 'active', score: 30 })
    expect(await total()).toBe(100)
    expect((await page()).meta.total).toBe(3)
    expect((await cursor()).data[0]?.name).toBe('Changed')
  })

  it('preserves cache configuration across from and model queries', async () => {
    const User = defineModelFromTable(users, { guarded: [], timestamps: false })
    expect((await User.where('id', 1).cache(60).first())?.get('name')).toBe('Ava')
    await User.where('id', 1).update({ name: 'Model update' })
    expect((await User.where('id', 1).cache(60).first())?.get('name')).toBe('Model update')
    const query = DB.table(users).cache({ key: 'alias-query', ttl: 60 }).from('users as u').select('u.name as name').where('u.id', 1)
    expect(await query.value('name')).toBe('Model update')
    await adapter.execute("UPDATE users SET name = 'Outside' WHERE id = 1")
    expect(await query.value('name')).toBe('Model update')
  })

  it('bypasses the cache for locked reads and reads current values for numeric mutations', async () => {
    const query = DB.table(users).where('id', 1).cache({ key: 'locked-user', ttl: 60 })
    expect(await query.value('score')).toBe(10)
    await adapter.execute('UPDATE users SET score = 30 WHERE id = 1')
    expect(await query.value('score')).toBe(10)
    expect(await query.lockForUpdate().value('score')).toBe(30)
    await query.increment('score', 5)
    expect(await query.value('score')).toBe(35)
  })

  it('defers invalidation until commit and preserves cached values after rollback', async () => {
    const events: string[][] = []
    queryCacheInternals.onDatabaseDependencyInvalidated(event => { events.push([...event.dependencies]) })
    expect(await names()).toEqual(['Ava', 'Ben'])
    await expect(DB.transaction(async tx => {
      await tx.table(users).where('id', 1).update({ name: 'Rolled back' })
      expect(events).toEqual([])
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await names()).toEqual(['Ava', 'Ben'])
    expect(events).toEqual([])
    await DB.transaction(async tx => {
      await tx.table(users).where('id', 1).update({ name: 'Committed' })
      expect(events).toEqual([])
    })
    expect(events).toHaveLength(1)
    expect(await names()).toEqual(['Committed', 'Ben'])
  })

  it('rolls back model writes and preserves cached rows when a lifecycle hook rejects', async () => {
    const User = defineModelFromTable(users, {
      guarded: [],
      timestamps: false,
      events: { updated() { throw new Error('observer rejected') } },
    })
    expect(await names()).toEqual(['Ava', 'Ben'])
    const user = await User.findOrFail(1)
    user.set('name', 'Rejected')
    await expect(user.save()).rejects.toThrow('observer rejected')
    expect(await names()).toEqual(['Ava', 'Ben'])
    expect(await DB.table(users).where('id', 1).value('name')).toBe('Ava')
  })

  it('reports a failing invalidation subscriber and keeps subsequent subscribers working', async () => {
    const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const subscriberError = new Error('subscriber failed')
    const received: string[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidated(() => { received.push('failing'); throw subscriberError })
    queryCacheInternals.onDatabaseDependencyInvalidated(() => { received.push('healthy') })
    await DB.table(users).where('id', 1).update({ score: 11 })
    expect(received).toEqual(['failing', 'healthy'])
    expect(reports).toEqual([{ error: subscriberError, context: { capability: 'db', operation: 'cache.invalidationListener' } }])
    unsubscribe()
    await DB.table(users).where('id', 1).update({ score: 12 })
    expect(received).toEqual(['failing', 'healthy', 'healthy'])
    expect(await DB.table(users).where('id', 1).value('score')).toBe(12)
  })

  it('publishes each committed invalidation as JSON without the local context id', async () => {
    const published: RemoteDatabaseDependencyInvalidation[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidationPublished(invalidation => { published.push(invalidation) })
    onTestFinished(unsubscribe)
    await DB.transaction(async tx => {
      await tx.table(users).where('id', 1).update({ score: 11 })
      expect(published).toEqual([])
    })

    await expect.poll(() => published.length).toBe(1)
    expect(published[0]).toEqual({ connectionName: 'main', dependencies: ['db:main:users'] })
    expect(JSON.parse(JSON.stringify(published[0]))).toEqual(published[0])
    expect(JSON.stringify(published[0])).not.toContain('contextId')
  })

  it('dispatches received remote invalidations to local listeners without publishing them again', async () => {
    const published: RemoteDatabaseDependencyInvalidation[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidationPublished(invalidation => { published.push(invalidation) })
    onTestFinished(unsubscribe)
    const received: string[][] = []
    queryCacheInternals.onDatabaseDependencyInvalidated(event => { received.push([...event.dependencies]) })

    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ connectionName: 'main', dependencies: ['db:main:users'] })

    expect(received).toEqual([['db:main:users']])
    expect(published).toEqual([])
  })

  it('drops this process cached results for a received remote invalidation', async () => {
    expect(await DB.table(users).orderBy('id').cache(60).pluck('score')).toEqual([10, 20])
    await adapter.execute('UPDATE users SET score = 99 WHERE id = 1')

    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ connectionName: 'main', dependencies: ['db:main:users'] })

    expect(await DB.table(users).orderBy('id').cache(60).pluck('score')).toEqual([99, 20])
  })

  it('drops a received table-level invalidation for cached queries that filter on a column', async () => {
    expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(10)
    await adapter.execute('UPDATE users SET score = 99 WHERE id = 1')

    await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation({ connectionName: 'main', dependencies: ['db:main:users'] })

    expect(await DB.table(users).where('id', 1).cache(60).value('score')).toBe(99)
  })

  it('reports a failing publisher without failing the committed write', async () => {
    const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const publisherError = new Error('broker unavailable')
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidationPublished(() => { throw publisherError })
    onTestFinished(unsubscribe)

    await DB.table(users).where('id', 1).update({ score: 12 })

    await expect.poll(() => reports).toEqual([{ error: publisherError, context: { capability: 'db', operation: 'cache.invalidationPublisher' } }])
    expect(await DB.table(users).where('id', 1).value('score')).toBe(12)
  })

  it('collects query dependencies without changing scalar or row results', async () => {
    const result = await collectDatabaseQueryDependencies(async () => ({
      names: await DB.table(users).orderBy('id').pluck('name'),
      first: await DB.table(users).where('id', 1).first(),
      total: await DB.table(users).sum('score'),
    }))
    expect(result.value.names).toEqual(['Ava', 'Ben'])
    expect(result.value.first?.name).toBe('Ava')
    expect(result.value.total).toBe(30)
    expect(result.dependencies).toContain('db:main:users')
    expect(Object.keys(result)).toEqual(['value', 'dependencies'])
  })

  it('fails clearly for missing runtime configuration and invalid cache dependencies', async () => {
    expect(() => DB.table(users).cache({ ttl: 60, invalidate: [''] })).toThrow()
    resetCacheRuntime()
    await expect(DB.table(users).cache(60).get()).rejects.toThrow('Query caching requires @holo-js/cache')
  })
})
