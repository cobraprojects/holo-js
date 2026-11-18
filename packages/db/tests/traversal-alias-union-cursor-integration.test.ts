import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CompilerError, DB, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables, resetDB, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('traversal aliases and union cursors on %s', driver => {
  afterEach(() => resetDB())

  it.each(['chunk', 'lazy'] as const)('traverses a subquery projection with a BigInt binding during %s', async method => {
    const { table } = await openDatabase(driver)
    await DB.table(table).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    const subquery = DB.table(table.tableName).select('id').where('id', 1n)
    const query = DB.table(table).select('id').addSelectSub(subquery, 'selected_id').orderBy('id')
    const rows: Record<string, unknown>[] = []
    if (method === 'chunk') await query.chunk(1, batch => { rows.push(...batch) })
    else for await (const row of query.lazy(1)) rows.push(row)
    expect(rows).toEqual([{ id: 1, selected_id: 1 }, { id: 2, selected_id: 1 }])
  })

  it.each(['chunk', 'lazy'] as const)('preserves wildcard columns outside the generated definition during %s', async method => {
    const { schema } = await openDatabase(driver)
    const name = `traversal_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.string('__holo_chunk_0')
    })
    await DB.table(name).insert([{ id: 1, __holo_chunk_0: 'first' }, { id: 2, __holo_chunk_0: 'second' }])
    const table = defineGeneratedTable(name, { id: column.integer().primaryKey() })
    const query = DB.table(table).select(`${name}.*`).orderBy('id')
    const rows: Record<string, unknown>[] = []
    if (method === 'chunk') await query.chunk(1, batch => { rows.push(...batch) })
    else for await (const row of query.lazy(1)) rows.push(row)
    expect(rows).toEqual([{ id: 1, __holo_chunk_0: 'first' }, { id: 2, __holo_chunk_0: 'second' }])
  })

  async function pageThrough<TRow extends Record<string, unknown>>(query: { cursorPaginate(perPage: number, cursor?: string | null): Promise<{ data: readonly TRow[], nextCursor: string | null, prevCursor: string | null }> }) {
    const pages: TRow[][] = []
    let cursor: string | null = null
    do {
      const page = await query.cursorPaginate(1, cursor)
      pages.push([...page.data])
      cursor = page.nextCursor
    } while (cursor !== null && pages.length < 10)
    return pages.flat()
  }

  async function createTable(schema: Awaited<ReturnType<typeof openDatabase>>['schema'], prefix: string, integers: readonly string[], strings: readonly string[] = []) {
    const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      for (const columnName of integers) table.integer(columnName)
      for (const columnName of strings) table.string(columnName)
    })
    return name
  }

  function registered<TTable extends TableDefinition>(table: TTable): TTable {
    registerGeneratedTables({ [table.tableName]: table })
    onTestFinished(() => clearGeneratedTables())
    return table
  }

  it('pages unions whose branches name the order column differently by the first query\'s output names', async () => {
    const { schema } = await openDatabase(driver)
    const left = registered(defineGeneratedTable(await createTable(schema, 'union_left', ['n'], ['value']), { n: column.integer(), value: column.string() }))
    const right = registered(defineGeneratedTable(await createTable(schema, 'union_right', ['other_n'], ['value']), { other_n: column.integer(), value: column.string() }))
    await DB.table(left).insert([{ n: 1, value: 'a' }, { n: 3, value: 'c' }])
    await DB.table(right).insert([{ other_n: 2, value: 'b' }, { other_n: 4, value: 'd' }])
    const aliasedFirst = DB.table(left.tableName).select('n as sort_key', 'value').unionAll(DB.table(right.tableName)).orderBy('sort_key')
    expect((await pageThrough(aliasedFirst)).map(row => row.value)).toEqual(['a', 'b', 'c', 'd'])
    const wildcardFirst = DB.table(left.tableName).unionAll(DB.table(right.tableName).select('other_n', 'value')).orderBy('n', 'desc')
    expect((await pageThrough(wildcardFirst)).map(row => row.value)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('pages a union by the output column even when a branch puts another column under that name', async () => {
    const { schema } = await openDatabase(driver)
    const users = registered(defineGeneratedTable(await createTable(schema, 'union_users', ['id', 'n']), { id: column.integer(), n: column.integer() }))
    await DB.table(users).insert([{ id: 1, n: 100 }, { id: 2, n: 50 }, { id: 3, n: 25 }])
    const swapped = DB.table(users.tableName).where('id', 3).unionAll(DB.table(users.tableName).select('n', 'id').where('id', '<', 3)).orderBy('id')
    expect((await pageThrough(swapped)).map(row => row.id)).toEqual([3, 50, 100])
    const shadowed = DB.table(users.tableName).select('id as other', 'n as id').unionAll(DB.table(users.tableName).select('id', 'n').where('id', 0)).orderBy('id')
    expect((await shadowed.get()).map(row => row.id)).toEqual([25, 50, 100])
    expect((await pageThrough(shadowed)).map(row => row.id)).toEqual([25, 50, 100])
  })

  it('pages a union whose next branch selects the wildcard order column under another name', async () => {
    const { schema } = await openDatabase(driver)
    const left = registered(defineGeneratedTable(await createTable(schema, 'union_left', ['id'], ['label']), { id: column.integer(), label: column.string() }))
    await DB.table(left).insert([{ id: 1, label: 'a' }, { id: 3, label: 'c' }])
    const query = DB.table(left.tableName).where('id', 3).unionAll(DB.table(left.tableName).select('id as user_id', 'label').where('id', 1)).orderBy('id')
    expect((await pageThrough(query)).map(row => row.label)).toEqual(['a', 'c'])
  })

  it('pages a union of differently aliased joined wildcards ordered by a qualified column', async () => {
    const { schema } = await openDatabase(driver)
    const owners = registered(defineGeneratedTable(await createTable(schema, 'union_owners', ['id']), { id: column.integer() }))
    const items = registered(defineGeneratedTable(await createTable(schema, 'union_items', ['owner_id', 'rank']), { owner_id: column.integer(), rank: column.integer() }))
    await DB.table(owners).insert([{ id: 1 }, { id: 2 }])
    await DB.table(items).insert([{ owner_id: 1, rank: 1 }, { owner_id: 2, rank: 2 }, { owner_id: 1, rank: 3 }, { owner_id: 2, rank: 4 }])
    const branch = (alias: string, ownerId: number) => DB.table(owners.tableName)
      .join(`${items.tableName} as ${alias}`, `${alias}.owner_id`, '=', `${owners.tableName}.id`)
      .select(`${alias}.*`)
      .where(`${owners.tableName}.id`, ownerId)
    const query = branch('a', 1).unionAll(branch('b', 2)).orderBy('a.rank')
    expect((await query.get()).map(row => row.rank)).toEqual([1, 2, 3, 4])
    expect((await pageThrough(query)).map(row => row.rank)).toEqual([1, 2, 3, 4])
  })

  it.each(['first', 'second'] as const)('handles a union cursor when the %s branch hides columns behind an undefined joined wildcard', async wildcardBranch => {
    const { schema, table } = await openDatabase(driver)
    const name = `union_notes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, notes => { notes.integer('note_id') })
    await DB.table(name).insert([{ note_id: 1 }, { note_id: 2 }])
    await DB.table(table).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    const joined = () => DB.table(table.tableName).join(name, `${name}.note_id`, '=', `${table.tableName}.id`)
    const first = wildcardBranch === 'first'
      ? joined().select(`${name}.*`, `${table.tableName}.id as sort_key`).where(`${table.tableName}.id`, 1)
      : joined().select(`${name}.note_id`, `${table.tableName}.id as sort_key`).where(`${table.tableName}.id`, 1)
    const second = wildcardBranch === 'second'
      ? joined().select(`${name}.*`, `${table.tableName}.id as other_key`).where(`${table.tableName}.id`, 2)
      : joined().select(`${name}.note_id`, `${table.tableName}.id as other_key`).where(`${table.tableName}.id`, 2)
    if (wildcardBranch === 'first') {
      for (const cursor of [null, 'abc']) {
        await expect(first.unionAll(second).orderBy('sort_key').cursorPaginate(1, cursor)).rejects.toThrow(
          new CompilerError('Cannot cursor paginate a union by "sort_key": more than one of its selected columns may be named "sort_key". Select it under a name no other column has.'),
        )
      }
    } else {
      expect((await pageThrough(first.unionAll(second).orderBy('sort_key'))).map(row => row.sort_key)).toEqual([1, 2])
    }
    const explicit = joined().select(`${name}.note_id`, `${table.tableName}.id as sort_key`).where(`${table.tableName}.id`, 1)
      .unionAll(joined().select(`${name}.note_id`, `${table.tableName}.id as other_key`).where(`${table.tableName}.id`, 2)).orderBy('sort_key')
    const page = await explicit.cursorPaginate(1)
    const next = await explicit.cursorPaginate(1, page.nextCursor)
    expect([page.data, next.data]).toEqual([[{ note_id: 1, sort_key: 1 }], [{ note_id: 2, sort_key: 2 }]])
    expect(next.nextCursor).toBeNull()
    expect((await explicit.cursorPaginate(1, next.prevCursor)).data).toEqual(page.data)
    const trailingWildcard = joined().select(`${table.tableName}.id as sort_key`, `${name}.note_id`).where(`${table.tableName}.id`, 1)
      .unionAll(joined().select(`${table.tableName}.id as other_key`, `${name}.*`).where(`${table.tableName}.id`, 2)).orderBy('sort_key')
    const start = await trailingWildcard.cursorPaginate(1)
    const end = await trailingWildcard.cursorPaginate(1, start.nextCursor)
    expect([start.data, end.data]).toEqual([[{ sort_key: 1, note_id: 1 }], [{ sort_key: 2, note_id: 2 }]])
    expect(end.nextCursor).toBeNull()
  })
})
