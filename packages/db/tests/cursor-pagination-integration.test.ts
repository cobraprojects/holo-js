import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
import type { QuerySuccessLog } from '../src/core/types'

describe('bounded bidirectional cursor pagination', () => {
  afterEach(() => resetDB())

  it.each(['model', 'json'] as const)('uses a configured model primary key for implicit %s ordering', async family => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    try {
      await adapter.execute('CREATE TABLE cursor_keys (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)')
      await adapter.execute("INSERT INTO cursor_keys VALUES (1, 'z'), (2, 'a'), (3, 'm')")
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite') } } }))
      const table = defineGeneratedTable('cursor_keys', { id: column.id(), code: column.string() })
      const Model = defineModel(table, { primaryKey: 'code', timestamps: false })
      const load = async (cursor: string | null = null) => family === 'json'
        ? await Model.query().cursorPaginateJson(2, cursor)
        : await Model.query().cursorPaginate(2, cursor).then(page => ({ ...page, data: page.data.map(row => row.toJSON()) }))
      const first = await load()
      expect(first.data.map(row => row.code)).toEqual(['a', 'm'])
      const last = await load(first.nextCursor)
      expect(last.data.map(row => row.code)).toEqual(['z'])
      expect((await load(last.prevCursor)).data.map(row => row.code)).toEqual(['a', 'm'])
    } finally {
      await adapter.disconnect()
    }
  })

  it.each(['table', 'model', 'json'] as const)('traverses scoped %s records with nulls and sort ties in bounded queries', async family => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    try {
      await adapter.execute('CREATE TABLE cursor_items (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, rank INTEGER)')
      await adapter.execute("INSERT INTO cursor_items VALUES (1, 'owned', NULL), (2, 'owned', 1), (3, 'owned', 1), (4, 'owned', 2), (5, 'owned', 2), (6, 'foreign', 1)")
      const logs: QuerySuccessLog[] = []
      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite'), logger: { onQuerySuccess: entry => { logs.push(entry) } } } } }))
      const table = defineGeneratedTable('cursor_items', { id: column.id(), tenant: column.string(), rank: column.integer().nullable() })
      const Model = defineModel(table, { timestamps: false })
      for (const direction of ['asc', 'desc'] as const) {
        const load = async (cursor: string | null = null) => {
          const query = Model.query().where('tenant', 'owned').orderBy('rank', direction)
          const page = family === 'table'
            ? await DB.table(table).where('tenant', 'owned').orderBy('rank', direction).cursorPaginate(2, cursor)
            : family === 'json'
              ? await query.cursorPaginateJson(2, cursor)
              : await query.cursorPaginate(2, cursor).then(page => ({ ...page, data: page.data.map(entity => entity.toJSON()) }))
          return { ids: page.data.map(record => record.id), next: page.nextCursor, previous: page.prevCursor }
        }
        logs.length = 0
        const expected = direction === 'asc' ? [[1, 2], [3, 4], [5]] : [[4, 5], [2, 3], [1]]
        const first = await load()
        expect(first).toMatchObject({ ids: expected[0], previous: null, next: expect.any(String) })
        await adapter.execute("INSERT INTO cursor_items VALUES (0, 'owned', NULL)")
        const second = await load(first.next)
        expect(second).toMatchObject({ ids: expected[1], previous: expect.any(String), next: expect.any(String) })
        await adapter.execute('DELETE FROM cursor_items WHERE id = 0')
        const last = await load(second.next)
        expect(last).toMatchObject({ ids: expected[2], previous: expect.any(String), next: null })
        const back = await load(last.previous)
        expect(back.ids).toEqual(expected[1])
        const start = await load(back.previous)
        expect(start).toMatchObject({ ids: expected[0], previous: null })
        expect((await load(start.next)).ids).toEqual(expected[1])
        expect(logs).toHaveLength(6)
        for (const log of logs) {
          expect(log.rowCount).toBeLessThanOrEqual(3)
        }
        logs.length = 0
        for (const payload of [{ values: [1, {}] }, { values: [1, 2], previous: 'yes' }, { values: [1] }]) {
          const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url')
          await expect(load(cursor)).rejects.toThrow(/Cursor/iu)
        }
        expect(logs).toHaveLength(0)
      }
      if (family === 'table') {
        await adapter.execute('CREATE TABLE cursor_groups (id INTEGER PRIMARY KEY)')
        await adapter.execute('INSERT INTO cursor_groups VALUES (1), (2)')
        const groups = defineGeneratedTable('cursor_groups', { id: column.id() })
        const query = DB.table(table).leftJoin(groups, 'cursor_items.rank', '=', 'cursor_groups.id').where('cursor_items.tenant', 'owned').select('cursor_items.id as itemId', 'cursor_groups.id as groupId').orderBy('cursor_groups.id')
        const first = await query.cursorPaginate(2)
        const second = await query.cursorPaginate(2, first.nextCursor)
        expect(first.data.map(record => record.itemId)).toEqual([1, 2])
        expect(second.data.map(record => record.itemId)).toEqual([3, 4])
        const back = await query.cursorPaginate(2, second.prevCursor)
        expect(back.data.map(record => record.itemId)).toEqual([1, 2])
      }
    } finally {
      await adapter.disconnect()
    }
  })
})
