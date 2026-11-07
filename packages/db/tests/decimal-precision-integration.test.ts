import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, column, defineGeneratedTable, defineModel, diffSchema, holoRuntimeInternals, renderGeneratedSchemaModule, renderGeneratedSchemaRuntimeModule, resetDB, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

describe.each(drivers)('decimal precision on %s', (driver) => {
  it('round-trips declared scales through typed queries and models', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const name = `holo_rates_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id().decimal('rate', 10, 4)
      table.decimal('whole', 10, 0)
      table.decimal('optional', 10, 4).nullable()
    })
    onTestFinished(() => schema.dropTable(name))
    const rates = defineGeneratedTable(name, {
      id: column.id(),
      rate: column.decimal(undefined, 10, 4),
      whole: column.decimal('whole', 10, 0),
      optional: column.decimal(undefined, 10, 4).nullable(),
    })
    const Rate = defineModel(rates, { fillable: ['rate', 'whole', 'optional'], timestamps: false })
    const created = await Rate.create({ rate: '12.3000', whole: '12', optional: null })
    const read = await Rate.findOrFail(created.get('id'))
    expectTypeOf(read.get('rate')).toEqualTypeOf<string>()
    expectTypeOf(read.get('optional')).toEqualTypeOf<string | null>()
    expect(read.get('rate')).toBe('12.3000')
    expect(read.get('whole')).toBe('12')
    expect(read.get('optional')).toBeNull()
    const row = await DB.table(rates).select('rate as value').first()
    expectTypeOf(row!.value).toEqualTypeOf<string>()
    expect(row).toEqual({ value: '12.3000' })
  })

  it('keeps decimal precision in introspection, generated schema, diffs and column changes', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const name = `holo_scale_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.decimal('rate', 10, 4)
      table.decimal('legacy')
    })
    onTestFinished(() => schema.dropTable(name))
    const reader = holoRuntimeInternals.createSchemaReader(db)
    const definition = (await reader.readTable(name))!
    const generated = renderGeneratedSchemaModule([definition])
    expect(definition.columns.rate).toMatchObject({ decimalTotal: 10, decimalPlaces: 4 })
    expect(generated).toContain('column.decimal(undefined, 10, 4)')
    expect(generated).toContain(driver === 'mysql' ? 'column.decimal(undefined, 10, 2)' : 'column.decimal()')
    const directory = await mkdtemp(join(tmpdir(), 'holo-decimal-'))
    onTestFinished(async () => {
      clearGeneratedTables()
      await rm(directory, { recursive: true, force: true })
    })
    const modulePath = join(directory, 'schema.mjs')
    await writeFile(modulePath, renderGeneratedSchemaRuntimeModule([definition]))
    const runtime: { tables: Record<string, TableDefinition> } = await import(pathToFileURL(modulePath).href)
    expect(runtime.tables[name]?.columns.rate).toMatchObject({ decimalTotal: 10, decimalPlaces: 4 })
    expect((await diffSchema(schema, [runtime.tables[name]!])).tables[0]?.hasChanges).toBe(false)
    const expected = defineGeneratedTable(name, { rate: column.decimal(undefined, 10, 4), legacy: column.decimal() })
    expect((await diffSchema(schema, [expected])).tables[0]?.hasChanges).toBe(false)
    for (const [total, places] of [[12, 4], [10, 3]] as const) {
      const changed = defineGeneratedTable(name, { rate: column.decimal(undefined, total, places), legacy: column.decimal() })
      expect((await diffSchema(schema, [changed])).tables[0]?.mismatchedColumns.map(column => column.column)).toEqual(['rate'])
    }
    await schema.table(name, table => {
      table.decimal('rate', 12, 3).change()
    })
    await schema.table(name, table => {
      table.string('label').nullable()
    })
    const changedDefinition = (await reader.readTable(name))!
    expect(changedDefinition.columns.rate).toMatchObject({ decimalTotal: 12, decimalPlaces: 3 })
    expect((await diffSchema(schema, [changedDefinition])).tables[0]?.hasChanges).toBe(false)
  })
})

it('pads SQLite unions only when every branch has the same effective decimal scale', async () => {
  const { schema } = await openDatabase('sqlite')
  onTestFinished(() => resetDB())
  await schema.createTable('decimal_unions', table => {
    table.decimal('rate', 10, 4)
    table.decimal('other', 12, 4)
    table.decimal('legacy')
    table.decimal('money', 10, 2)
  })
  const rates = defineGeneratedTable('decimal_unions', {
    rate: column.decimal(undefined, 10, 4),
    other: column.decimal(undefined, 12, 4),
    legacy: column.decimal(),
    money: column.decimal(undefined, 10, 2),
  })
  await DB.table(rates).insert({ rate: '12.3000', other: '12.3000', legacy: '12.30', money: '12.30' })

  expect(await DB.table(rates).select('rate as amount').unionAll(DB.table(rates).select('other as amount')).get())
    .toEqual([{ amount: '12.3000' }, { amount: '12.3000' }])
  expect(await DB.table(rates).select('legacy as amount').union(DB.table(rates).select('money as amount')).get())
    .toEqual([{ amount: '12.30' }])
  expect(await DB.table(rates).select('rate as amount').union(DB.table(rates).select('legacy as amount')).get())
    .toEqual([{ amount: 12.3 }])
})
