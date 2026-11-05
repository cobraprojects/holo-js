import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { clearGeneratedTables, defineModel, holoRuntimeInternals, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

afterEach(() => {
  resetDB()
  clearGeneratedTables()
})

async function openFlagsModel(dialect: 'sqlite' | 'postgres' | 'mysql') {
  const { db, schema } = await openDatabase(dialect)
  const name = `bool_cast_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  onTestFinished(() => schema.dropTable(name))
  await schema.createTable(name, table => {
    table.id()
    table.text('as_text').nullable()
    table.string('as_string').nullable()
    table.integer('as_integer').nullable()
    table.boolean('as_boolean').nullable()
  })
  const generated = await createSchemaReader(db).readTable(name)
  registerGeneratedTables({ [name]: generated! })
  const columns = ['as_text', 'as_string', 'as_integer', 'as_boolean'] as const
  const Flags = defineModel(name, {
    timestamps: false,
    fillable: [...columns],
    casts: Object.fromEntries(columns.map(column => [column, 'boolean'])),
  })
  return { Flags, columns }
}

describe.each(['sqlite', 'postgres', 'mysql'] as const)('%s boolean casts', dialect => {
  const enabled = dialect === 'sqlite' || process.env[`HOLO_${dialect.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled)('round-trips true and false on every column type', async () => {
    const { Flags, columns } = await openFlagsModel(dialect)
    const allFalse = await Flags.create(Object.fromEntries(columns.map(column => [column, false])))
    const allTrue = await Flags.create(Object.fromEntries(columns.map(column => [column, true])))

    const readFalse = await Flags.findOrFail(allFalse.id)
    const readTrue = await Flags.findOrFail(allTrue.id)
    for (const column of columns) {
      expect(readFalse.get(column), column).toBe(false)
      expect(readTrue.get(column), column).toBe(true)
    }

    await Flags.update(allTrue.id, Object.fromEntries(columns.map(column => [column, false])))
    const updated = await Flags.findOrFail(allTrue.id)
    for (const column of columns) {
      expect(updated.get(column), column).toBe(false)
    }
  })
})
