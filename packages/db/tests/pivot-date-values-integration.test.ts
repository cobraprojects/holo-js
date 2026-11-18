import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, clearGeneratedTables, column, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB, unsafeSql } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

const quote = (driver: Driver, identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`

async function openPivots(driver: Driver, logger?: NonNullable<Parameters<typeof openDatabase>[1]>['logger']) {
  const { db, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true }, ...(logger ? { logger } : {}) })
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { owners: `holo_owners_${suffix}`, slots: `holo_slots_${suffix}`, ownerSlots: `holo_owner_slots_${suffix}`, tags: `holo_tags_${suffix}`, ownerTags: `holo_owner_tags_${suffix}`, ownerBadges: `holo_owner_badges_${suffix}`, days: `holo_days_${suffix}`, ownerDays: `holo_owner_days_${suffix}` }
  await schema.createTable(names.owners, (table) => { table.integer('id').primaryKey() })
  await schema.createTable(names.slots, (table) => { table.datetime('starts_at').primaryKey() })
  await schema.createTable(names.ownerSlots, (table) => {
    table.integer('owner_id')
    table.datetime('starts_at')
    table.string('note').nullable()
    table.string('holo_matching_values').nullable()
  })
  await schema.createTable(names.tags, (table) => { table.integer('id').primaryKey() })
  await schema.createTable(names.ownerTags, (table) => {
    table.integer('owner_id')
    table.integer('tag_id')
    table.string('note').nullable()
    table.timestamp('expires_at').nullable()
    table.date('due_on').nullable()
  })
  await schema.createTable(names.days, (table) => { table.date('day').primaryKey() })
  await schema.createTable(names.ownerDays, (table) => {
    table.integer('owner_id')
    table.date('day')
    table.string('note').nullable()
  })
  await schema.createTable(names.ownerBadges, (table) => {
    table.integer('owner_id')
    table.integer('tag_id')
    table.timestamp('expires_at').nullable()
    table.timestamp('created_at').nullable()
    table.timestamp('updated_at').nullable()
  })
  onTestFinished(async () => {
    for (const name of Object.values(names)) await schema.dropTable(name)
  })
  const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey() })
  const slots = defineGeneratedTable(names.slots, { starts_at: column.datetime().primaryKey() })
  const ownerSlots = defineGeneratedTable(names.ownerSlots, { owner_id: column.integer(), starts_at: column.datetime(), note: column.string().nullable() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey() })
  const ownerTags = defineGeneratedTable(names.ownerTags, { owner_id: column.integer(), tag_id: column.integer(), note: column.string().nullable(), expires_at: column.timestamp().nullable(), due_on: column.date().nullable() })
  const ownerBadges = defineGeneratedTable(names.ownerBadges, { owner_id: column.integer(), tag_id: column.integer(), expires_at: column.timestamp().nullable(), created_at: column.timestamp().nullable(), updated_at: column.timestamp().nullable() })
  const days = defineGeneratedTable(names.days, { day: column.date().primaryKey() })
  const ownerDays = defineGeneratedTable(names.ownerDays, { owner_id: column.integer(), day: column.date(), note: column.string().nullable() })
  registerGeneratedTables({ owners, slots, ownerSlots, tags, ownerTags, ownerBadges, days, ownerDays })
  const Day = defineModel(days, { timestamps: false })
  onTestFinished(() => clearGeneratedTables())
  const Slot = defineModel(slots, { timestamps: false })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(owners, {
    timestamps: false,
    relations: {
      slots: belongsToMany(() => Slot, ownerSlots, 'owner_id', 'starts_at', 'id', 'starts_at').withPivot('note'),
      tags: belongsToMany(() => Tag, ownerTags, 'owner_id', 'tag_id').withPivot('note', 'expires_at', 'due_on'),
      badges: belongsToMany(() => Tag, ownerBadges, 'owner_id', 'tag_id').withPivot('expires_at').withTimestamps(),
      days: belongsToMany(() => Day, ownerDays, 'owner_id', 'day', 'id', 'day').withPivot('note'),
    },
  })
  await DB.table(owners).insert({ id: 1 })
  await DB.table(tags).insert([{ id: 1 }, { id: 2 }])
  return { db, names, ownerSlots, ownerTags, ownerBadges, ownerDays, owner: await Owner.findOrFail(1) }
}

describe.each(integrationDrivers(['sqlite']))('pivot rows keyed by SQLite date text on %s', (driver) => {
  async function openStoredSlots() {
    const fixture = await openPivots(driver)
    await fixture.db.unsafeExecute(unsafeSql(`INSERT INTO "${fixture.names.ownerSlots}" ("owner_id", "starts_at", "note") VALUES (1, '2026-01-01T10:00:00Z', 'first'), (1, '2026-01-02T10:00:00+02:00', 'second')`))
    const stored = async () => (await DB.table(fixture.ownerSlots).orderBy('note').unsafeSelect('"starts_at" AS "stored", "note"', []).get())
    return { ...fixture, stored }
  }

  it('syncs away and keeps rows whose keys are stored as zoned text', async () => {
    const { owner, stored } = await openStoredSlots()

    expect(await owner.sync('slots', [new Date('2026-01-02T08:00:00Z')])).toEqual({ attached: [], detached: ['2026-01-01T10:00:00Z'], updated: [] })
    expect(await stored()).toEqual([{ stored: '2026-01-02T10:00:00+02:00', note: 'second' }])
    expect(await owner.sync('slots', [])).toEqual({ attached: [], detached: ['2026-01-02T10:00:00+02:00'], updated: [] })
    expect(await stored()).toEqual([])
  })

  it('toggles, detaches and updates rows whose keys are stored as zoned text', async () => {
    const { owner, stored } = await openStoredSlots()

    expect(await owner.updateExistingPivot('slots', new Date('2026-01-02T08:00:00Z'), { note: 'changed' })).toBe(1)
    expect(await owner.syncWithoutDetaching('slots', { '2026-01-01 10:00:00': { note: 'synced' } } as never)).toEqual({ attached: [], detached: [], updated: ['2026-01-01 10:00:00'] })
    expect(await stored()).toEqual([
      { stored: '2026-01-02T10:00:00+02:00', note: 'changed' },
      { stored: '2026-01-01T10:00:00Z', note: 'synced' },
    ])
    expect(await owner.toggle('slots', [new Date('2026-01-01T10:00:00Z')])).toEqual({ attached: [], detached: [new Date('2026-01-01T10:00:00Z')] })
    expect(await owner.detach('slots', new Date('2026-01-02T08:00:00Z'))).toBe(1)
    expect(await stored()).toEqual([])
  })
})

describe.each(integrationDrivers(['sqlite']))('pivot rows that store one instant as different SQLite text on %s', (driver) => {
  it('updates and removes every row stored for the same instant together', async () => {
    const fixture = await openPivots(driver)
    await fixture.db.unsafeExecute(unsafeSql(`INSERT INTO "${fixture.names.ownerSlots}" ("owner_id", "starts_at", "note") VALUES (1, '2026-01-01T10:00:00Z', 'zoned'), (1, '2026-01-01 10:00:00', 'plain')`))
    const notes = async () => (await DB.table(fixture.ownerSlots).orderBy('starts_at').pluck('note'))

    expect(await fixture.owner.updateExistingPivot('slots', new Date('2026-01-01T10:00:00Z'), { note: 'both' })).toBe(1)
    expect(await notes()).toEqual(['both', 'both'])
    expect(await fixture.owner.toggle('slots', [new Date('2026-01-01T10:00:00Z')])).toEqual({ attached: [], detached: [new Date('2026-01-01T10:00:00Z')] })
    expect(await notes()).toEqual([])
  })
})

describe.each(integrationDrivers(['postgres']))('pivot keys a microsecond apart on %s', (driver) => {
  it('updates and toggles only the requested row', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO ${quote(driver, names.ownerSlots)} (${quote(driver, 'owner_id')}, ${quote(driver, 'starts_at')}, ${quote(driver, 'note')}) VALUES (1, '2026-01-01 10:00:00', 'whole'), (1, '2026-01-01 10:00:00.000002', 'micro')`))
    const notes = async () => (await DB.table(ownerSlots).orderBy('note').pluck('note'))

    expect(await owner.updateExistingPivot('slots', '2026-01-01 10:00:00.000002' as never, { note: 'micro changed' })).toBe(1)
    expect(await notes()).toEqual(['micro changed', 'whole'])
    await owner.toggle('slots', ['2026-01-01 10:00:00.000002' as never])
    expect(await notes()).toEqual(['whole'])
  })

  it('keeps one of two keys in the same millisecond and detaches the other', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO ${quote(driver, names.ownerSlots)} (${quote(driver, 'owner_id')}, ${quote(driver, 'starts_at')}, ${quote(driver, 'note')}) VALUES (1, '2026-01-01 10:00:05.000001', 'first'), (1, '2026-01-01 10:00:05.000002', 'second')`))

    expect(await owner.sync('slots', ['2026-01-01 10:00:05.000001' as never])).toEqual({ attached: [], detached: [new Date('2026-01-01T10:00:05Z')], updated: [] })
    expect(await DB.table(ownerSlots).pluck('note')).toEqual(['first'])
  })

  it('matches a key given with more fractional digits than PostgreSQL stores', async () => {
    const { owner, ownerSlots } = await openPivots(driver)
    const key = '2026-01-01 10:00:00.0000021' as never

    await owner.attach('slots', key)
    await owner.attach('slots', key)
    expect(await DB.table(ownerSlots).count()).toBe(1)
    expect(await owner.detach('slots', key)).toBe(1)
    expect(await DB.table(ownerSlots).count()).toBe(0)
  })

  it.each([
    ['rounded past six digits', '2026-01-01 10:00:00.0001265'],
    ['rounded into the next second', '2026-01-01 00:59:59.9999995'],
    ['with an offset the column ignores', '2026-01-01 10:00:00.000002+02:00'],
  ])('attaches once and detaches a key %s', async (_case, key) => {
    const { owner, ownerSlots } = await openPivots(driver)

    await owner.attach('slots', key as never)
    await owner.attach('slots', key as never)
    expect(await DB.table(ownerSlots).count()).toBe(1)
    expect(await owner.detach('slots', key as never)).toBe(1)
    expect(await DB.table(ownerSlots).count()).toBe(0)
  })

  it('detaches a key that rounds into a repeated hour of app.timezone', async () => {
    configureConfigRuntime({ app: { timezone: 'America/New_York' } } as never)
    onTestFinished(() => resetConfigRuntime())
    const { owner, ownerSlots } = await openPivots(driver)
    const key = '2026-11-01 00:59:59.9999995' as never

    await owner.attach('slots', key)
    expect(await owner.detach('slots', key)).toBe(1)
    expect(await DB.table(ownerSlots).count()).toBe(0)
  })

  it('detaches a row whose key holds more precision than a Date', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO ${quote(driver, names.ownerSlots)} (${quote(driver, 'owner_id')}, ${quote(driver, 'starts_at')}, ${quote(driver, 'note')}) VALUES (1, '2026-01-01 10:00:00.000002', 'micro'), (1, '2026-01-02 10:00:00', 'kept')`))

    expect(await owner.sync('slots', [new Date('2026-01-02T10:00:00Z')])).toEqual({ attached: [], detached: [new Date('2026-01-01T10:00:00Z')], updated: [] })
    expect(await DB.table(ownerSlots).pluck('note')).toEqual(['kept'])
    expect(await owner.sync('slots', [])).toEqual({ attached: [], detached: [new Date('2026-01-02T10:00:00Z')], updated: [] })
    expect(await DB.table(ownerSlots).count()).toBe(0)
  })
})

describe.each(integrationDrivers(['sqlite']))('pivot date attributes stored as SQLite text on %s', (driver) => {
  it('writes a new time into a date column even on the same calendar day', async () => {
    const { owner, ownerTags } = await openPivots(driver)
    await owner.attach('tags', 1, { due_on: '2026-05-06 10:00:00' as never })

    expect(await owner.updateExistingPivot('tags', 1, { due_on: '2026-05-06 10:00:00' as never })).toBe(0)
    expect(await owner.updateExistingPivot('tags', 1, { due_on: '2026-05-06 11:00:00' as never })).toBe(1)
    expect(await DB.table(ownerTags).unsafeSelect('"due_on" AS "stored"', []).first()).toEqual({ stored: '2026-05-06 11:00:00' })
  })

  it('syncs away more rows stored for one instant than a function call can take', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000) INSERT INTO "${names.ownerSlots}" ("owner_id", "starts_at", "note") SELECT 1, '2026-01-01 10:00:00', 'old' FROM n`))

    const result = await owner.sync('slots', [])
    expect(result.detached).toHaveLength(150000)
    expect(await DB.table(ownerSlots).count()).toBe(0)
  }, 60000)

  it('updates more rows stored for one instant than one statement can bind', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 33000) INSERT INTO "${names.ownerSlots}" ("owner_id", "starts_at", "note") SELECT 1, '2026-01-01T10:00:00.000' || printf('%05d', i) || 'Z', 'old' FROM n`))

    expect(await owner.updateExistingPivot('slots', new Date('2026-01-01T10:00:00Z'), { note: 'new' })).toBe(1)
    expect(await DB.table(ownerSlots).where('note', 'new').count()).toBe(33000)
  })

  it('compares Date attributes of a pivot referenced only by an unregistered table name', async () => {
    const { names, owner } = await openPivots(driver)
    clearGeneratedTables()
    const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey() })
    const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey() })
    registerGeneratedTables({ owners, tags })
    const Tag = defineModel(tags, { timestamps: false })
    const Untyped = defineModel(owners, { timestamps: false, relations: { tags: belongsToMany(() => Tag, names.ownerTags, 'owner_id', 'tag_id').withPivot('expires_at') } })
    const untyped = await Untyped.findOrFail(owner.get('id'))
    await untyped.attach('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })

    expect(await untyped.updateExistingPivot('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })).toBe(0)
    expect(await untyped.updateExistingPivot('tags', 1, { expires_at: new Date('2026-01-01T11:00:00Z') })).toBe(1)
  })
})

describe.each(integrationDrivers(['sqlite']))('pivot rows keyed by a SQLite calendar date on %s', (driver) => {
  it('updates and detaches a day stored as calendar text through a midnight Date', async () => {
    const { db, names, owner, ownerDays } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO "${names.ownerDays}" ("owner_id", "day", "note") VALUES (1, '2026-01-01', 'old')`))

    expect(await owner.updateExistingPivot('days', new Date('2026-01-01T00:00:00Z'), { note: 'new' })).toBe(1)
    expect(await DB.table(ownerDays).pluck('note')).toEqual(['new'])
    expect(await owner.detach('days', new Date('2026-01-01T00:00:00Z'))).toBe(1)
    expect(await DB.table(ownerDays).count()).toBe(0)
  })
})

describe.each(drivers)('pivot rows that repeat a date key on %s', (driver) => {
  it('keeps every row of a key that sync keeps', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO ${quote(driver, names.ownerSlots)} (${quote(driver, 'owner_id')}, ${quote(driver, 'starts_at')}, ${quote(driver, 'note')}) VALUES (1, '2026-01-01 10:00:00', 'a'), (1, '2026-01-01 10:00:00', 'b'), (1, '2026-01-02 10:00:00', 'gone')`))

    expect(await owner.sync('slots', ['2026-01-01 10:00:00' as never])).toEqual({ attached: [], detached: [new Date('2026-01-02T10:00:00Z')].map(date => driver === 'sqlite' ? '2026-01-02 10:00:00' : date), updated: [] })
    expect((await DB.table(ownerSlots).orderBy('note').pluck('note'))).toEqual(['a', 'b'])
  })

  it('keeps matching keys when the pivot has a column named like an internal selection', async () => {
    const { db, names, owner, ownerSlots } = await openPivots(driver)
    await db.unsafeExecute(unsafeSql(`INSERT INTO ${quote(driver, names.ownerSlots)} (${quote(driver, 'owner_id')}, ${quote(driver, 'starts_at')}, ${quote(driver, 'holo_matching_values')}) VALUES (1, '2026-01-01 10:00:00', 'custom')`))

    expect(await owner.sync('slots', ['2026-01-01 10:00:00' as never])).toEqual({ attached: [], detached: [], updated: [] })
    expect(await DB.table(ownerSlots).count()).toBe(1)
  })

  it.runIf(driver !== 'sqlite')('matches many keys without a query per key', async () => {
    let queries = 0
    const { owner } = await openPivots(driver, { onQuerySuccess: () => { queries++ } })
    const keys = Array.from({ length: 100 }, (_, index) => new Date(Date.UTC(2026, 0, 1, 0, index)))
    await owner.attach('slots', keys)

    queries = 0
    expect(await owner.syncWithoutDetaching('slots', keys)).toEqual({ attached: [], detached: [], updated: [] })
    expect(queries).toBeLessThanOrEqual(4)
  })
})

describe.each(drivers)('pivot rows keyed by a calendar date on %s', (driver) => {
  it('matches a day key given as a Date or as text for that day', async () => {
    const { owner, ownerDays } = await openPivots(driver)
    await owner.attach('days', new Date('2026-01-01T00:00:00Z'), { note: 'attached' })

    expect(await owner.updateExistingPivot('days', '2026-01-01 00:00:00' as never, { note: 'wall clock' })).toBe(1)
    expect(await owner.updateExistingPivot('days', '2026-01-01T00:00:00Z' as never, { note: 'iso' })).toBe(1)
    expect(await owner.sync('days', ['2026-01-01' as never])).toEqual({ attached: [], detached: [], updated: [] })
    expect(await DB.table(ownerDays).pluck('note')).toEqual(['iso'])
    expect(await owner.detach('days', '2026-01-01 00:00:00' as never)).toBe(1)
    expect(await DB.table(ownerDays).count()).toBe(0)
  })
})

describe.each(drivers)('pivot keys given with more precision than the database keeps on %s', (driver) => {
  it('attaches a key once and detaches it by the same value', async () => {
    const { owner, ownerSlots } = await openPivots(driver)
    const key = '2026-01-01T10:00:00.000002Z' as never

    await owner.attach('slots', key)
    await owner.attach('slots', key)
    expect(await DB.table(ownerSlots).count()).toBe(1)
    expect(await owner.detach('slots', key)).toBe(1)
    expect(await DB.table(ownerSlots).count()).toBe(0)
  })
})

describe.each(drivers)('pivot date attributes written again on %s', (driver) => {
  it('leaves a row alone when a date attribute is given the instant it already holds', async () => {
    const { owner } = await openPivots(driver)
    const expiresAt = new Date('2026-01-01T10:00:00Z')
    await owner.attach('tags', [1, 2], { expires_at: expiresAt })

    expect(await owner.updateExistingPivot('tags', 1, { expires_at: new Date(expiresAt.getTime()) })).toBe(0)
    expect(await owner.updateExistingPivot('tags', 1, { expires_at: '2026-01-01 10:00:00' as never })).toBe(0)
    expect(await owner.syncWithoutDetaching('tags', { 1: { expires_at: new Date(expiresAt.getTime()) }, 2: { expires_at: new Date(expiresAt.getTime()) } })).toEqual({ attached: [], detached: [], updated: [] })
    expect(await owner.syncWithoutDetaching('tags', { 1: { expires_at: new Date(expiresAt.getTime()), note: 'noted' }, 2: { expires_at: new Date('2026-01-01T11:00:00Z') } })).toEqual({ attached: [], detached: [], updated: [1, 2] })
    expect(await owner.updateExistingPivot('tags', 1, { expires_at: null })).toBe(1)
    expect(await owner.updateExistingPivot('tags', 1, { expires_at: null })).toBe(0)
  })

  it('advances pivot timestamps only when a date attribute changed', async () => {
    const { owner, ownerBadges } = await openPivots(driver)
    await owner.attach('badges', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })
    await DB.table(ownerBadges).update({ updated_at: new Date('2000-01-01T00:00:00Z') })
    const updatedAt = async () => (await DB.table(ownerBadges).value('updated_at'))

    expect(await owner.updateExistingPivot('badges', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })).toBe(0)
    expect(await updatedAt()).toEqual(new Date('2000-01-01T00:00:00Z'))
    expect(await owner.updateExistingPivot('badges', 1, { expires_at: new Date('2026-01-02T10:00:00Z') })).toBe(1)
    expect(await updatedAt()).not.toEqual(new Date('2000-01-01T00:00:00Z'))
  })

  it('compares a date column by the value it stores and detaches missing rows while syncing date attributes', async () => {
    const { owner, ownerTags } = await openPivots(driver)
    await owner.attach('tags', [1, 2], { due_on: new Date('2026-05-06T00:00:00Z') })

    expect(await owner.updateExistingPivot('tags', 1, { due_on: new Date('2026-05-06T00:00:00Z') })).toBe(0)
    expect(await owner.updateExistingPivot('tags', 1, { due_on: new Date('2026-05-06T15:30:00Z') })).toBe(driver === 'sqlite' ? 1 : 0)
    expect(await owner.updateExistingPivot('tags', 1, { due_on: new Date('2026-05-06T00:00:00Z') })).toBe(driver === 'sqlite' ? 1 : 0)
    expect(await owner.updateExistingPivot('tags', 1, { due_on: new Date('2026-05-07T00:00:00Z') })).toBe(1)
    expect(await owner.sync('tags', { 1: { due_on: new Date('2026-05-07T00:00:00Z') } })).toEqual({ attached: [], detached: [2], updated: [] })
    expect(await DB.table(ownerTags).pluck('tag_id')).toEqual([1])
  })

  it.runIf(driver === 'postgres')('detects a change below a millisecond that a Date cannot hold', async () => {
    const { db, names, owner } = await openPivots(driver)
    await owner.attach('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })
    await db.unsafeExecute(unsafeSql(`UPDATE ${quote(driver, names.ownerTags)} SET ${quote(driver, 'expires_at')} = '2026-01-01 10:00:00.000002+00'`))

    expect(await owner.updateExistingPivot('tags', 1, { expires_at: '2026-01-01T10:00:00.000002Z' as never })).toBe(0)
    expect(await owner.updateExistingPivot('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })).toBe(1)
  })
})
