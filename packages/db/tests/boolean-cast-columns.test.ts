import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, defineModel, holoRuntimeInternals, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

const columns = ['as_text', 'as_string', 'as_integer', 'as_boolean', 'as_json'] as const

afterEach(() => {
  resetDB()
  clearGeneratedTables()
})

function everyColumn<TValue>(value: TValue): Record<string, TValue> {
  return Object.fromEntries(columns.map(column => [column, value]))
}

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
    table.json('as_json').nullable()
  })
  const generated = await createSchemaReader(db).readTable(name)
  registerGeneratedTables({ [name]: generated! })
  return defineModel(name, {
    timestamps: false,
    fillable: [...columns],
    casts: everyColumn('boolean' as const),
  })
}

describe.each(['sqlite', 'postgres', 'mysql'] as const)('%s boolean casts', dialect => {
  const enabled = dialect === 'sqlite' || process.env[`HOLO_${dialect.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled)('round-trips true and false on every column type', async () => {
    const Flags = await openFlagsModel(dialect)
    const allFalse = await Flags.create(everyColumn(false))
    const allTrue = await Flags.create(everyColumn(true))

    const readFalse = await Flags.findOrFail(allFalse.id)
    const readTrue = await Flags.findOrFail(allTrue.id)
    for (const column of columns) {
      expect(readFalse.get(column), column).toBe(false)
      expect(readTrue.get(column), column).toBe(true)
    }

    await Flags.update(allTrue.id, everyColumn(false))
    const updated = await Flags.findOrFail(allTrue.id)
    for (const column of columns) {
      expect(updated.get(column), column).toBe(false)
    }
  })

  it.runIf(enabled)('stores the form inputs "0" and "1" as false and true on every column type', async () => {
    const Flags = await openFlagsModel(dialect)
    const fromZero = await Flags.create(everyColumn('0'))
    const fromOne = await Flags.create(everyColumn('1'))

    const readZero = await Flags.findOrFail(fromZero.id)
    const readOne = await Flags.findOrFail(fromOne.id)
    for (const column of columns) {
      expect(readZero.get(column), column).toBe(false)
      expect(readOne.get(column), column).toBe(true)
    }
  })

  it.runIf(dialect === 'sqlite')('reads false from a text column holding the 0.0 that earlier releases wrote', async () => {
    const Flags = await openFlagsModel(dialect)
    await DB.table(Flags.getTableName()).insert([{ id: 1, as_text: '0.0', as_string: '0.00' }, { id: 2, as_text: '1.0', as_string: '1.00' }])

    expect((await Flags.findOrFail(1)).get('as_text')).toBe(false)
    expect((await Flags.findOrFail(1)).get('as_string')).toBe(false)
    expect((await Flags.findOrFail(2)).get('as_text')).toBe(true)
    expect((await Flags.findOrFail(2)).get('as_string')).toBe(true)
  })
})
