import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, defineGeneratedTable, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

async function openKeyedTables(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { counted: `counted_${suffix}`, coded: `coded_${suffix}` }
  await schema.createTable(names.counted, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(names.coded, (table) => {
    table.uuid('id').primaryKey()
    table.string('name')
  })
  return { schema, names }
}

describe.each(drivers)('insertGetId() on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('returns an auto-increment key as a number for a table name and a declared table', async () => {
    const { schema, names } = await openKeyedTables(driver)
    try {
      const counted = defineGeneratedTable(names.counted, { id: column.id(), name: column.string() })

      const byName = await DB.table(names.counted).insertGetId({ name: 'a' })
      const byDefinition = await DB.table(counted).insertGetId({ name: 'b' })

      expect([byName, byDefinition]).toEqual([1, 2])
    } finally {
      for (const name of Object.values(names)) await schema.dropTable(name)
    }
  })

  it.skipIf(driver !== 'postgres')('returns a UUID key as the string the database returns', async () => {
    const { schema, names } = await openKeyedTables(driver)
    try {
      const code = randomUUID()

      expect(await DB.table(names.coded).insertGetId({ id: code, name: 'a' })).toBe(code)
    } finally {
      for (const name of Object.values(names)) await schema.dropTable(name)
    }
  })
})
