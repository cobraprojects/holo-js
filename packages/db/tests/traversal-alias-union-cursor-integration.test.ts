import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CompilerError, DB, column, defineGeneratedTable, resetDB } from '../src'
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

  it.each(['first', 'second'] as const)('rejects a union cursor when the %s branch hides column positions behind an undefined joined wildcard', async wildcardBranch => {
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
    await expect(first.unionAll(second).orderBy('sort_key').cursorPaginate(1)).rejects.toThrow(
      new CompilerError('Cannot cursor paginate a union by "sort_key": its column position cannot be determined. Select the order column explicitly in each query without preceding wildcards.'),
    )
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
