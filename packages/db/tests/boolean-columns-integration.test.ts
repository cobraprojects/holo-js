import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, column, defineGeneratedTable, defineModel, hasMany, resetDB } from '../src'
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

  it('aggregates a boolean column as ones and zeros', async () => {
    const { flags } = await openFlags(driver)
    await DB.table(flags).insert([
      { label: 'on', enabled: true },
      { label: 'also on', enabled: true },
      { label: 'off', enabled: false },
    ])

    expect(await DB.table(flags).sum('enabled')).toBe(2)
    expect(await DB.table(flags).avg('enabled')).toBeCloseTo(2 / 3)
    expect(await DB.table(flags).min('enabled')).toBe(0)
    expect(await DB.table(flags).max('enabled')).toBe(1)
    const Flag = defineModel(flags, { timestamps: false })
    expect(await Flag.sum('enabled')).toBe(2)
    expect(await Flag.max('enabled')).toBe(1)
  })

  it('aggregates a related boolean column as ones and zeros', async () => {
    const { flags, schema } = await openFlags(driver)
    const ownersName = `holo_flag_owners_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ownersName, (table) => {
      table.id()
      table.integer('flag_id')
      table.boolean('approved')
    })
    onTestFinished(() => schema.dropTable(ownersName))
    const owners = defineGeneratedTable(ownersName, { id: column.id(), flag_id: column.integer(), approved: column.boolean() })
    const Owner = defineModel(owners, { timestamps: false })
    const Flag = defineModel(flags, { timestamps: false, relations: { owners: hasMany(() => Owner, 'flag_id') } })
    await DB.table(flags).insert({ id: 1, label: 'on', enabled: true })
    await DB.table(owners).insert([{ flag_id: 1, approved: true }, { flag_id: 1, approved: false }, { flag_id: 1, approved: true }])

    const flag = await Flag.withSum('owners', 'approved').withMax('owners', 'approved').firstOrFail()

    expect(flag.toJSON()).toMatchObject({ owners_sum_approved: 2, owners_max_approved: 1 })
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

  it.runIf(driver !== 'postgres')('reads a union column as a boolean only when every branch reads a boolean there', async () => {
    const { flags, schema } = await openFlags(driver)
    const countsName = `holo_flag_counts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(countsName, (table) => {
      table.id()
      table.integer('enabled')
    })
    onTestFinished(() => schema.dropTable(countsName))
    const counts = defineGeneratedTable(countsName, { id: column.id(), enabled: column.integer() })
    await DB.table(flags).insert([{ label: 'on', enabled: true }, { label: 'off', enabled: false }])
    await DB.table(counts).insert({ enabled: 42 })

    const mixed = await DB.table(flags).select('enabled').unionAll(DB.table(counts).select('enabled')).get()
    const flagsOnly = await DB.table(flags).select('enabled').where('label', 'on').unionAll(DB.table(flags).select('enabled').where('label', 'off')).get()

    expect(mixed.map(row => Number(row.enabled)).sort((left, right) => left - right)).toEqual([0, 1, 42])
    expect(flagsOnly.map(row => row.enabled).sort()).toEqual([false, true])
    const nested = await DB.table(flags).select('enabled').where('label', 'on')
      .unionAll(DB.table(flags).select('enabled').where('label', 'off').unionAll(DB.table(counts).select('enabled')))
      .get()
    expect(nested.map(row => Number(row.enabled)).sort((left, right) => left - right)).toEqual([0, 1, 42])
  })

  it.runIf(driver !== 'postgres')('reads union columns by position, whatever each branch names them', async () => {
    const { flags } = await openFlags(driver)
    await DB.table(flags).insert([{ id: 1, label: 'on', enabled: true }, { id: 2, label: 'off', enabled: false }])

    const swapped = await DB.table(flags).select('enabled as flag', 'id as number').where('label', 'on')
      .unionAll(DB.table(flags).select('id as number', 'enabled as flag').where('label', 'off'))
      .get()
    const renamed = await DB.table(flags).select('enabled as flag').where('label', 'on')
      .unionAll(DB.table(flags).select('enabled as other').where('label', 'off'))
      .get()

    expect(swapped.map(row => [Number(row.flag), Number(row.number)]).sort()).toEqual([[1, 1], [2, 0]])
    expect(swapped.some(row => typeof row.flag === 'boolean')).toBe(false)
    expect(renamed.map(row => row.flag).sort()).toEqual([false, true])
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
