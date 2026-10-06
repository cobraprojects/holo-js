import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
import { queryCacheInternals } from '../src/cache'
import type { QuerySuccessLog } from '../src/core/types'

describe('bounded standard pagination', () => {
  afterEach(() => resetDB())

  it.each(['table', 'model', 'json'] as const)('reads only the requested scoped %s page and observes its metadata', async family => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    try {
      await adapter.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL)')
      await adapter.execute("WITH RECURSIVE records(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM records WHERE id < 100) INSERT INTO items SELECT id, CASE WHEN id > 90 THEN 'foreign' ELSE 'owned' END, 'Item ' || id FROM records")
      const logs: QuerySuccessLog[] = []
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite'), logger: { onQuerySuccess: entry => { logs.push(entry) } } } } }))
      const table = defineGeneratedTable('items', { id: column.id(), tenant: column.string(), name: column.string() })
      const Model = defineModel(table, { timestamps: false })
      const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
        const query = Model.query().where('tenant', 'owned').orderBy('id').limit(1).offset(80)
        if (family === 'table') return DB.table(table).where('tenant', 'owned').orderBy('id').limit(1).offset(80).paginate(2, 3)
        if (family === 'json') return query.paginateJson(2, 3)
        return query.paginate(2, 3)
      })
      expect(result.value.data.map(row => row.id)).toEqual([5, 6])
      expect(result.value.meta).toMatchObject({ total: 90, currentPage: 3, from: 5, to: 6, hasMorePages: true })
      expect(logs.map(entry => entry.rowCount)).toEqual([1, 2])
      expect(result.queries).toHaveLength(2)
      expect(result.queries).toEqual(expect.arrayContaining([expect.objectContaining({ pagination: expect.objectContaining({ kind: 'standard', total: 90 }), result: result.value.meta }), expect.objectContaining({ limit: 2, offset: 4, result: result.value.data })]))
    } finally {
      await adapter.disconnect()
    }
  })

  it('counts selected distinct rows, groups and unions without loading their complete results', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    try {
      await adapter.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, category TEXT NOT NULL)')
      await adapter.execute("INSERT INTO items VALUES (1, 'A'), (2, 'A'), (3, 'B'), (4, 'C')")
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite') } } }))
      const query = DB.table('items')
      expect(await query.select('category').distinct().orderBy('category').paginate(1, 2)).toMatchObject({ data: [{ category: 'B' }], meta: { total: 3 } })
      expect(await query.select('category').addSelectCount('quantity').groupBy('category').having('quantity', '>', 1).paginate(1)).toMatchObject({ data: [{ category: 'A', quantity: 2 }], meta: { total: 1 } })
      expect(await query.where('id', '<', 3).union(query.where('id', '>', 2)).orderBy('id').paginate(1, 4)).toMatchObject({ data: [{ id: 4, category: 'C' }], meta: { total: 4 } })
    } finally {
      await adapter.disconnect()
    }
  })

  it.each(['table', 'model', 'json'] as const)('reads a bounded %s simple page and lookahead without a count query', async family => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    try {
      await adapter.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL)')
      await adapter.execute("WITH RECURSIVE records(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM records WHERE id < 100) INSERT INTO items SELECT id, CASE WHEN id > 90 THEN 'foreign' ELSE 'owned' END, 'Item ' || id FROM records")
      const logs: QuerySuccessLog[] = []
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite'), logger: { onQuerySuccess: entry => { logs.push(entry) } } } } }))
      const table = defineGeneratedTable('items', { id: column.id(), tenant: column.string(), name: column.string() })
      const Model = defineModel(table, { timestamps: false })
      const read = (page: number) => queryCacheInternals.collectDatabaseQueryDependencies(async () => {
        const query = Model.query().where('tenant', 'owned').orderBy('id').limit(1).offset(80)
        if (family === 'table') return DB.table(table).where('tenant', 'owned').orderBy('id').limit(1).offset(80).simplePaginate(2, page)
        if (family === 'json') return query.simplePaginateJson(2, page)
        return query.simplePaginate(2, page)
      })
      const first = await read(3)
      expect(first.value.data.map(row => row.id)).toEqual([5, 6])
      expect(first.value.meta).toMatchObject({ currentPage: 3, from: 5, to: 6, hasMorePages: true })
      expect(first.queries).toEqual(expect.arrayContaining([expect.objectContaining({ result: first.value.data, limit: 2, offset: 4 }), expect.objectContaining({ result: first.value.meta, pagination: expect.objectContaining({ kind: 'simple', rowCount: null }) })]))
      const last = await read(45)
      expect(last.value.data.map(row => row.id)).toEqual([89, 90])
      expect(last.value.meta).toMatchObject({ from: 89, to: 90, hasMorePages: false })
      const empty = await read(46)
      expect(empty.value.data).toEqual([])
      expect(empty.value.meta).toMatchObject({ from: null, to: null, hasMorePages: false })
      expect(logs.map(entry => entry.rowCount)).toEqual([3, 2, 0])
    } finally {
      await adapter.disconnect()
    }
  })
})
