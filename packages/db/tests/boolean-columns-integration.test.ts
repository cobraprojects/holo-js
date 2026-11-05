import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Driver = typeof drivers[number]

async function openFlags(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const name = `holo_flags_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('label')
    table.boolean('enabled')
    table.boolean('archived').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  const flags = defineGeneratedTable(name, {
    id: column.id(),
    label: column.string(),
    enabled: column.boolean(),
    archived: column.boolean().nullable(),
  })
  return { flags, schema, name }
}

describe.each(drivers)('boolean columns on %s', (driver) => {
  it('reads boolean columns as booleans through the typed query builder', async () => {
    const { flags } = await openFlags(driver)
    await DB.table(flags).insert([
      { label: 'on', enabled: true, archived: false },
      { label: 'off', enabled: false, archived: null },
    ])

    const rows = await DB.table(flags).orderBy('id').get()
    expectTypeOf(rows[0]!.enabled).toEqualTypeOf<boolean>()
    expect(rows.map(row => [row.enabled, row.archived])).toEqual([[true, false], [false, null]])
    expect(await DB.table(flags).where('label', 'on').first()).toMatchObject({ enabled: true, archived: false })
    expect(await DB.table(flags).where('label', 'off').value('enabled')).toBe(false)
    expect(await DB.table(flags).where('label', 'on').value('enabled')).toBe(true)
    expect(await DB.table(flags).orderBy('id').pluck('enabled')).toEqual([true, false])
    expect(await DB.table(flags).orderBy('id').pluck('archived')).toEqual([false, null])
    expect(await DB.table(flags).select('enabled as active').where('label', 'on').first()).toEqual({ active: true })
  })

  it('matches model reads of the same boolean columns', async () => {
    const { flags } = await openFlags(driver)
    const Flag = defineModel(flags, { fillable: ['label', 'enabled', 'archived'], timestamps: false })
    const created = await Flag.create({ label: 'on', enabled: true, archived: false })

    const model = await Flag.findOrFail(created.get('id'))
    const row = await DB.table(flags).where('id', created.get('id')).first()

    expect(row?.enabled).toBe(model.get('enabled'))
    expect(row?.archived).toBe(model.get('archived'))
  })

  it('reads a joined boolean column as a boolean', async () => {
    const { flags, schema } = await openFlags(driver)
    const ownersName = `holo_owners_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ownersName, (table) => {
      table.id()
      table.integer('flag_id')
    })
    onTestFinished(() => schema.dropTable(ownersName))
    const owners = defineGeneratedTable(ownersName, { id: column.id(), flag_id: column.integer() })
    await DB.table(flags).insert({ id: 1, label: 'on', enabled: true })
    await DB.table(owners).insert({ flag_id: 1 })

    const row = await DB.table(owners)
      .join(flags, `${ownersName}.flag_id`, '=', `${flags.tableName}.id`)
      .select(`${flags.tableName}.enabled`)
      .first()

    expect(row).toEqual({ enabled: true })
  })

  it('reads cached boolean rows as booleans', async () => {
    const { flags } = await openFlags(driver)
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    await DB.table(flags).insert({ label: 'on', enabled: true })

    expect(await DB.table(flags).select('enabled').cache(60).first()).toEqual({ enabled: true })
    expect(await DB.table(flags).select('enabled').cache(60).first()).toEqual({ enabled: true })
  })
})
