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
    table.timestamp('deleted_at').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  return defineGeneratedTable(name, {
    id: column.id(),
    month: column.string(),
    responses_used: column.integer().default(0),
    active: column.boolean().default(true),
    status: column.string().default('draft'),
    deleted_at: column.timestamp().nullable(),
  })
}

describe.each(drivers)('models created on %s', (driver) => {
  it('carry the values the database stored for columns the insert did not write', async () => {
    const UsagePeriod = defineModel(await openUsagePeriods(driver), { timestamps: false, fillable: ['month', 'status'] })

    const created = await UsagePeriod.create({ month: '2026-11', status: 'open' })

    expect(created.toAttributes()).toEqual({ id: 1, month: '2026-11', responses_used: 0, active: true, status: 'open', deleted_at: null })
    expect(created.isClean()).toBe(true)
    expectTypeOf(created.get('responses_used')).toEqualTypeOf<number>()
  })

  it('carry stored defaults through firstOrCreate, updateOrCreate and save even when scopes exclude the row', async () => {
    const UsagePeriod = defineModel(await openUsagePeriods(driver), {
      timestamps: false,
      softDeletes: true,
      fillable: ['month', 'deleted_at'],
      globalScopes: { active: query => query.where('status', 'active') },
    })

    const first = await UsagePeriod.firstOrCreate({ month: '2026-11' })
    const updated = await UsagePeriod.updateOrCreate({ month: '2026-12' }, { deleted_at: new Date('2026-12-01T00:00:00Z') })
    const saved = await UsagePeriod.make({ month: '2027-01' }).save()

    expect(first.get('responses_used')).toBe(0)
    expect(updated.get('active')).toBe(true)
    expect(saved.get('status')).toBe('draft')
  })

  it('show stored defaults to created and saved listeners without firing retrieved', async () => {
    const seen: unknown[] = []
    let retrievals = 0
    const UsagePeriod = defineModel(await openUsagePeriods(driver), {
      timestamps: false,
      fillable: ['month'],
      events: {
        created: [entity => { seen.push(entity.get('responses_used')) }],
        saved: [entity => { seen.push(entity.get('status')) }],
        retrieved: [() => { retrievals += 1 }],
      },
    })

    await UsagePeriod.create({ month: '2026-11' })

    expect(seen).toEqual([0, 'draft'])
    expect(retrievals).toBe(0)
  })
})

describe.each(integrationDrivers(['mysql']))('models created on %s with a key the database generates without AUTO_INCREMENT', (driver) => {
  it('stay keyless instead of taking another row as theirs', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const name = `holo_tokens_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE \`${name}\` (\`code\` VARCHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY, \`label\` VARCHAR(20) NOT NULL, \`note\` VARCHAR(20) NOT NULL DEFAULT 'fresh')`, source: 'schema' })
    onTestFinished(() => schema.dropTable(name))
    await db.executeCompiled({ sql: `INSERT INTO \`${name}\` (\`label\`, \`note\`) VALUES ('existing', 'taken')`, source: 'schema' })
    const Token = defineModel(defineGeneratedTable(name, {
      code: column.string().primaryKey().default(''),
      label: column.string(),
      note: column.string().default('fresh'),
    }), { timestamps: false, fillable: ['label'] })

    const created = await Token.create({ label: 'new' })

    expect(created.toAttributes()).toEqual({ label: 'new' })
  })
})
