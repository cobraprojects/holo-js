import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, HydrationError, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

const UNSAFE_KEY = '9007199254740993'

async function openUnsafeKeyTable(driver: typeof drivers[number]) {
  const { schema, adapter } = await openDatabase(driver)
  const name = `unsafe_keys_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('name')
  })
  await DB.table(name).insert({ id: UNSAFE_KEY, name: 'seed' })
  if (driver === 'postgres') await adapter.query(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), ${UNSAFE_KEY})`)
  return { schema, name, counted: defineGeneratedTable(name, { id: column.id(), name: column.string() }) }
}

describe.each(drivers)('id() keys beyond the safe integer range on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('throws HydrationError when a model reads or creates one, and rolls the create back', async () => {
    const { schema, name, counted } = await openUnsafeKeyTable(driver)
    try {
      const Counted = defineModel(counted, { fillable: ['name'], timestamps: false })

      await expect(Counted.where('name', 'seed').first()).rejects.toThrow(HydrationError)
      await expect(Counted.all()).rejects.toThrow(HydrationError)
      await expect(Counted.create({ name: 'next' })).rejects.toThrow(HydrationError)
      expect(await DB.table(name).pluck('name')).toEqual(['seed'])
    } finally {
      await schema.dropTable(name)
    }
  })

  it('throws HydrationError when DB.table() reads one through a table definition', async () => {
    const { schema, name, counted } = await openUnsafeKeyTable(driver)
    try {
      await expect(DB.table(counted).where('name', 'seed').first()).rejects.toThrow(HydrationError)
      await expect(DB.table(counted).pluck('id')).rejects.toThrow(HydrationError)
      expect(await DB.table(counted).insertGetId({ name: 'next' })).toBe('9007199254740994')
    } finally {
      await schema.dropTable(name)
    }
  })
})
