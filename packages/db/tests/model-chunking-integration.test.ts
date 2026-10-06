import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
import type { QuerySuccessLog } from '../src/core/types'

describe('model chunking', () => {
  const table = defineGeneratedTable('chunk_items', { id: column.id(), name: column.string(), active: column.boolean() })
  const Item = defineModel(table, { timestamps: false })
  let adapter: ReturnType<typeof createSQLiteAdapter>
  let logs: QuerySuccessLog[]

  beforeEach(async () => {
    adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    await adapter.execute('CREATE TABLE chunk_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO chunk_items VALUES (1, 'First', 1), (2, 'Second', 1), (3, 'Third', 1), (4, 'Fourth', 1), (5, 'Excluded', 0)")
    logs = []
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('sqlite'), logger: { onQuerySuccess: entry => { logs.push(entry) } } } },
    }))
  })

  afterEach(async () => {
    resetCacheRuntime()
    await adapter.disconnect()
    resetDB()
  })

  it('processes each cached record once and finishes with an explicit cache key', async () => {
    configureCacheRuntime({
      config: { default: 'memory', drivers: { memory: { driver: 'memory' } } },
    })
    const batches: number[][] = []
    await Item.query().cache({ key: 'chunk-items', ttl: 60 }).chunkById(2, (records, page) => {
      batches.push(records.map(record => record.get('id')))
      return page < 4
    })
    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })

  it('reads bounded batches and observes updates to later records', async () => {
    const batches: string[][] = []
    await Item.query().where('active', true).orderBy('id', 'desc').limit(1).offset(1).chunkById(2, async (records, page) => {
      batches.push(records.map(record => record.get('name')))
      if (page === 1) {
        await Item.where('id', 3).update({ name: 'Updated' })
        await records[0]?.delete()
      }
    })
    expect(batches).toEqual([['First', 'Second'], ['Updated', 'Fourth']])
    for (const log of logs.filter(log => log.sql.startsWith('SELECT'))) {
      expect(log.rowCount).toBeLessThanOrEqual(3)
    }
  })

  it('chunks projected records without exposing cursor columns', async () => {
    const batches: Array<Array<Record<string, unknown>>> = []
    await Item.query().select('name', 'active').chunkById(2, records => {
      batches.push(records.map(record => record.toAttributes()))
    }, 'active')
    expect(batches).toEqual([
      [{ name: 'Excluded', active: false }, { name: 'First', active: true }],
      [{ name: 'Second', active: true }, { name: 'Third', active: true }],
      [{ name: 'Fourth', active: true }],
    ])
  })

  it('processes OR-filtered records once and finishes', async () => {
    const batches: number[][] = []
    await Item.where('active', true).orWhere('id', 5).chunkById(2, (records, page) => {
      batches.push(records.map(record => record.get('id')))
      return page <= 3
    })
    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })

  it('chunks projected custom primary keys without exposing cursor columns', async () => {
    await adapter.execute('CREATE TABLE custom_key_items (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)')
    await adapter.execute("INSERT INTO custom_key_items VALUES (1, 'z'), (2, 'a'), (3, 'm')")
    const CustomItem = defineModel(defineGeneratedTable('custom_key_items', {
      id: column.id(),
      code: column.string(),
    }), { primaryKey: 'code', timestamps: false })
    const batches: Array<Array<Record<string, unknown>>> = []

    await CustomItem.select('code').chunkById(1, records => {
      batches.push(records.map(record => record.toAttributes()))
    })

    expect(batches).toEqual([[{ code: 'a' }], [{ code: 'm' }], [{ code: 'z' }]])
  })

  it('preserves distinct projected values across batches', async () => {
    const batches: Array<Array<Record<string, unknown>>> = []
    await Item.query().select('active').distinct().chunkById(1, records => {
      batches.push(records.map(record => record.toAttributes()))
    }, 'active')
    expect(batches).toEqual([[{ active: false }], [{ active: true }]])
  })

  it('processes every distinct record when callbacks remove processed records from the query', async () => {
    const batches: number[][] = []
    await Item.where('active', true).distinct().chunkById(2, async records => {
      const ids = records.map(record => record.get('id'))
      batches.push(ids)
      await Item.whereIn('id', ids).update({ active: false })
    })
    expect(batches).toEqual([[1, 2], [3, 4]])
  })

  it('returns each grouped value once across batches', async () => {
    await Item.where('id', 2).update({ active: false })
    const batches: boolean[][] = []
    await Item.query().select('active').groupBy('active').chunkById(1, records => {
      batches.push(records.map(record => record.get('active')))
    }, 'active')
    expect(batches).toEqual([[false], [true]])
  })

  it.each(['union', 'unionAll'] as const)('chunks projected %s results across batches', async operation => {
    const batches: number[][] = []
    const query = Item.query().select('id').where('id', '<', 3)
    await query[operation](Item.query().select('id').where('id', '>=', 3))
      .chunkById(2, records => {
        batches.push(records.map(record => record.get('id')))
      })
    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })

  it('chunks union projections without the primary key and preserves deduplication', async () => {
    const names: string[] = []
    await Item.query().select('name').where('id', '<', 4)
      .union(Item.query().select('name').where('id', '>=', 3))
      .chunkById(2, records => {
        names.push(...records.map(record => record.get('name')))
      })
    expect(names.sort()).toEqual(['Excluded', 'First', 'Fourth', 'Second', 'Third'])
  })

  it.each(['chunk_items', 'chunk_items as items'])('chunks joined records from %s', async source => {
    await adapter.execute('CREATE TABLE other_items (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL)')
    await adapter.execute('INSERT INTO other_items VALUES (10, 1), (20, 2), (30, 3)')
    const prefix = source === 'chunk_items' ? 'chunk_items' : 'items'
    const batches: number[][] = []
    await Item.query().from(source)
      .join('other_items', `${prefix}.id`, '=', 'other_items.item_id')
      .select(`${prefix}.id`, `${prefix}.name`)
      .chunkById(2, records => { batches.push(records.map(record => record.get('id'))) })
    expect(batches).toEqual([[1, 2], [3]])
  })

  it('preserves joined rows sharing a model ID across batches', async () => {
    await adapter.execute('CREATE TABLE other_items (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL)')
    await adapter.execute('INSERT INTO other_items VALUES (10, 1), (20, 1), (30, 1), (40, 2)')
    const batches: Array<Array<Record<string, unknown>>> = []
    await Item.query()
      .join('other_items', 'chunk_items.id', '=', 'other_items.item_id')
      .select('chunk_items.id', 'other_items.id as child_id')
      .chunkById(2, records => { batches.push(records.map(record => record.toAttributes())) })
    expect(batches).toEqual([
      [{ id: 1, child_id: 10 }, { id: 1, child_id: 20 }],
      [{ id: 1, child_id: 30 }, { id: 2, child_id: 40 }],
    ])
  })
})
