import { beforeEach, describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  holoRuntimeInternals,
  type ModelQueryBuilder,
  resetDB,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

const { getQueryBounds } = holoRuntimeInternals

describe('integration query bounds', () => {
  beforeEach(() => resetDB())

  async function setup() {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const items = defineTable('bounded_items', { id: column.id(), name: column.string() })
    await createTestTable(db, items)
    await db.table(items).insert([
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
      { id: 3, name: 'Three' },
      { id: 4, name: 'Four' },
      { id: 5, name: 'Five' },
      { id: 6, name: 'Six' },
    ])
    const Item = defineModelFromTable(items, {
      globalScopes: { bounded: query => query.limit(3).offset(1) },
      scopes: { lastTwo: (query: ModelQueryBuilder<typeof items>) => query.limit(2).offset(4) },
    })
    return { table: db.table(items), Item }
  }

  it('inspects immutable table and model queries without changing their results or inferred types', async () => {
    const { table, Item } = await setup()
    const originalTable = table.select('id', 'name').orderBy('id')
    const originalModel = Item.withoutGlobalScopes().orderBy('id')

    for (const original of [originalTable, originalModel]) {
      expect(getQueryBounds(original)).toEqual({ limit: undefined, offset: undefined })
      const bounded = original.limit(2).offset(1)
      const snapshot = getQueryBounds(bounded)
      expect(snapshot).toEqual({ limit: 2, offset: 1 })
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(getQueryBounds(bounded.limit(1).offset(3))).toEqual({ limit: 1, offset: 3 })
      expect(getQueryBounds(bounded)).toEqual(snapshot)
      expect(getQueryBounds(original)).toEqual({ limit: undefined, offset: undefined })
    }

    const tableRows = await originalTable.limit(2).offset(1).get()
    expectTypeOf(tableRows).toEqualTypeOf<{ id: number, name: string }[]>()
    expectTypeOf(getQueryBounds(originalModel)).toEqualTypeOf<Readonly<{ limit: number | undefined, offset: number | undefined }>>()
    expect(tableRows.map(row => row.id)).toEqual([2, 3])
    expect((await originalModel.limit(2).offset(1).get()).map(row => row.get('id'))).toEqual([2, 3])
    expect((await originalTable.get()).map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await originalModel.get()).map(row => row.get('id'))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('distinguishes zero from unset and supports clearing either bound', async () => {
    const { table, Item } = await setup()
    const model = Item.withoutGlobalScopes()
    for (const query of [table, model]) {
      const zero = query.limit(0).offset(0)
      expect(getQueryBounds(zero)).toEqual({ limit: 0, offset: 0 })
      expect(await zero.get()).toEqual([])
      expect(getQueryBounds(zero.limit())).toEqual({ limit: undefined, offset: 0 })
      expect(getQueryBounds(zero.offset())).toEqual({ limit: 0, offset: undefined })
      expect(getQueryBounds(zero.limit(undefined).offset(undefined))).toEqual({ limit: undefined, offset: undefined })
      expect(await zero.limit().offset().get()).toHaveLength(6)
    }
  })

  it('includes applied scopes and reflects explicit overrides and excluded global scopes', async () => {
    const { Item } = await setup()
    const scoped = Item.query().orderBy('id')
    expect(getQueryBounds(scoped)).toEqual({ limit: 3, offset: 1 })
    expect((await scoped.get()).map(row => row.get('id'))).toEqual([2, 3, 4])
    const named = scoped.lastTwo()
    expect(getQueryBounds(named)).toEqual({ limit: 2, offset: 4 })
    expect((await named.get()).map(row => row.get('id'))).toEqual([5, 6])
    expect(getQueryBounds(scoped)).toEqual({ limit: 3, offset: 1 })
    expect(getQueryBounds(named.limit(1).offset(0))).toEqual({ limit: 1, offset: 0 })
    expect(getQueryBounds(Item.withoutGlobalScope('bounded'))).toEqual({ limit: undefined, offset: undefined })
  })

  it('lets integrations compose page bounds within the authored window', async () => {
    const { table, Item } = await setup()
    const tableQuery = table.orderBy('id').limit(3).offset(1)
    const modelQuery = Item.query().orderBy('id')
    for (const query of [tableQuery, modelQuery]) {
      const { limit, offset } = getQueryBounds(query)
      const optionsLimit = 5
      const pageSize = 2
      const total = Math.min(limit ?? optionsLimit, optionsLimit)
      const lengths: number[] = []
      for (const pageOffset of [0, 2, 4]) {
        const page = query.offset((offset ?? 0) + pageOffset).limit(Math.max(0, Math.min(pageSize, total - pageOffset)))
        lengths.push((await page.get()).length)
        expect(getQueryBounds(page).offset).toBe(1 + pageOffset)
      }
      expect(lengths).toEqual([2, 1, 0])
      expect(getQueryBounds(query)).toEqual({ limit: 3, offset: 1 })
    }
    const { limit, offset } = getQueryBounds(tableQuery)
    expect(await tableQuery.offset((offset ?? 0) + 2).limit((limit ?? 5) - 2).get()).toEqual([{ id: 4, name: 'Four' }])
    expect((await modelQuery.offset((offset ?? 0) + 2).limit((limit ?? 5) - 2).get()).map(row => row.get('id'))).toEqual([4])
  })
})
