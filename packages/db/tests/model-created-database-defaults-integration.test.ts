import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

async function openUsagePeriods(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const name = `holo_usage_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('month').unique()
    table.integer('responses_used').default(0)
    table.boolean('active').default(true)
    table.string('status').default('draft')
  })
  onTestFinished(() => schema.dropTable(name))
  return defineGeneratedTable(name, {
    id: column.id(),
    month: column.string(),
    responses_used: column.integer().default(0),
    active: column.boolean().default(true),
    status: column.string().default('draft'),
  })
}

describe.each(drivers)('models created on %s', (driver) => {
  it('carry the values the database stored for columns the insert did not write', async () => {
    const UsagePeriod = defineModel(await openUsagePeriods(driver), { timestamps: false, fillable: ['month', 'status'] })

    const created = await UsagePeriod.create({ month: '2026-11', status: 'open' })

    expect(created.toAttributes()).toEqual({ id: 1, month: '2026-11', responses_used: 0, active: true, status: 'open' })
    expect(created.isClean()).toBe(true)
    expectTypeOf(created.get('responses_used')).toEqualTypeOf<number>()
  })

  it('carry stored defaults through firstOrCreate and save even when a global scope excludes the row', async () => {
    const UsagePeriod = defineModel(await openUsagePeriods(driver), {
      timestamps: false,
      fillable: ['month'],
      globalScopes: { active: query => query.where('status', 'active') },
    })

    const first = await UsagePeriod.firstOrCreate({ month: '2026-11' })
    const saved = await UsagePeriod.make({ month: '2026-12' }).save()

    expect(first.get('responses_used') + 1).toBe(1)
    expect(saved.get('status')).toBe('draft')
  })

  it('show stored defaults to created listeners without firing retrieved', async () => {
    const seen: unknown[] = []
    let retrievals = 0
    const UsagePeriod = defineModel(await openUsagePeriods(driver), {
      timestamps: false,
      fillable: ['month'],
      events: {
        created: [entity => { seen.push(entity.get('responses_used')) }],
        retrieved: [() => { retrievals += 1 }],
      },
    })

    await UsagePeriod.create({ month: '2026-11' })

    expect(seen).toEqual([0])
    expect(retrievals).toBe(0)
  })
})
