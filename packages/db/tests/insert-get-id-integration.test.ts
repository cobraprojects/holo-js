import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

async function openKeyedTables(driver: typeof drivers[number]) {
  const { schema, db, adapter } = await openDatabase(driver)
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
  return { schema, names, db, adapter }
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
  it.skipIf(driver !== 'postgres')('returns a key beyond the safe integer range as its exact text instead of throwing after the insert', async () => {
    const { schema, names, db, adapter } = await openKeyedTables(driver)
    try {
      const counted = defineGeneratedTable(names.counted, { id: column.id(), name: column.string() })
      await adapter.query(`SELECT setval(pg_get_serial_sequence('${names.counted}', 'id'), 9007199254740993)`)

      const byName = await DB.table(names.counted).insertGetId({ name: 'a' })
      const byDefinition = await DB.table(counted).insertGetId({ name: 'b' })

      expect([byName, byDefinition]).toEqual(['9007199254740994', '9007199254740995'])
      expect(await DB.table(names.counted).count()).toBe(2)

      configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, analytics: db } }))
      const Counted = defineModel(names.counted, { connectionName: 'analytics', fillable: ['name'], timestamps: false })
      const created = await Counted.create({ name: 'c' })
      expect(created.get('id')).toBe('9007199254740996')
      expect((await Counted.findOrFail(created.get('id'))).get('id')).toBe('9007199254740996')
    } finally {
      for (const name of Object.values(names)) await schema.dropTable(name)
    }
  })

  it.skipIf(driver !== 'postgres')('returns a text key as a number only when it is a safe integer', async () => {
    const { schema, names } = await openKeyedTables(driver)
    const snowflakes = `${names.coded}_snowflakes`
    await schema.createTable(snowflakes, (table) => {
      table.string('id').primaryKey()
    })
    try {
      expect(await DB.table(snowflakes).insertGetId({ id: '0042' })).toBe(42)
      expect(await DB.table(snowflakes).insertGetId({ id: '1790000000000000001' })).toBe('1790000000000000001')
      expect(await DB.table(snowflakes).count()).toBe(2)
    } finally {
      await schema.dropTable(snowflakes)
      for (const name of Object.values(names)) await schema.dropTable(name)
    }
  })
})
