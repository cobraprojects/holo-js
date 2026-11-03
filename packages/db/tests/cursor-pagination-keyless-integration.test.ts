import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, SecurityError, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

async function openKeylessPivot(driver: 'sqlite' | 'postgres' | 'mysql') {
  const { schema } = await openDatabase(driver)
  const name = `keyless_pivot_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.integer('post_id')
    table.integer('tag_id')
    table.unique(['post_id', 'tag_id'])
  })
  registerGeneratedTables({ pivot: defineGeneratedTable(name, { post_id: column.integer(), tag_id: column.integer() }) })
  await DB.table(name).insert([{ post_id: 1, tag_id: 2 }, { post_id: 1, tag_id: 1 }, { post_id: 2, tag_id: 1 }])
  return { name, schema }
}

function registerKeylessCursorScenarios(driver: 'sqlite' | 'postgres' | 'mysql') {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('cursor-paginates a table without a primary key by an explicit unique order', async () => {
    const { name, schema } = await openKeylessPivot(driver)
    try {
      const first = await DB.table(name).orderBy('post_id').orderBy('tag_id').cursorPaginate(2)
      const second = await DB.table(name).orderBy('post_id').orderBy('tag_id').cursorPaginate(2, first.nextCursor)

      expect([...first.data, ...second.data].map(row => [row.post_id, row.tag_id])).toEqual([[1, 1], [1, 2], [2, 1]])
    } finally {
      await schema.dropTable(name)
    }
  })

  it('asks for an explicit order when a table without a primary key has none', async () => {
    const { name, schema } = await openKeylessPivot(driver)
    try {
      await expect(DB.table(name).cursorPaginate(1)).rejects.toThrow(new SecurityError('Cursor pagination requires an explicit stable orderBy clause.'))
    } finally {
      await schema.dropTable(name)
    }
  })
}

describe('cursor pagination on a keyless Generated-schema table on sqlite', () => {
  registerKeylessCursorScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('cursor pagination on a keyless Generated-schema table on postgres', () => {
  registerKeylessCursorScenarios('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('cursor pagination on a keyless Generated-schema table on mysql', () => {
  registerKeylessCursorScenarios('mysql')
})
