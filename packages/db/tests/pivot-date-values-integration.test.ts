import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, clearGeneratedTables, column, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB, unsafeSql } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

const quote = (driver: Driver, identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`

async function openPivots(driver: Driver) {
  const { db, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { owners: `holo_owners_${suffix}`, slots: `holo_slots_${suffix}`, ownerSlots: `holo_owner_slots_${suffix}`, tags: `holo_tags_${suffix}`, ownerTags: `holo_owner_tags_${suffix}` }
  await schema.createTable(names.owners, (table) => { table.integer('id').primaryKey() })
  await schema.createTable(names.slots, (table) => { table.datetime('starts_at').primaryKey() })
  await schema.createTable(names.ownerSlots, (table) => {
    table.integer('owner_id')
    table.datetime('starts_at')
    table.string('note').nullable()
  })
  await schema.createTable(names.tags, (table) => { table.integer('id').primaryKey() })
  await schema.createTable(names.ownerTags, (table) => {
    table.integer('owner_id')
    table.integer('tag_id')
    table.string('note').nullable()
    table.timestamp('expires_at').nullable()
  })
  onTestFinished(async () => {
    for (const name of Object.values(names)) await schema.dropTable(name)
  })
  const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey() })
  const slots = defineGeneratedTable(names.slots, { starts_at: column.datetime().primaryKey() })
  const ownerSlots = defineGeneratedTable(names.ownerSlots, { owner_id: column.integer(), starts_at: column.datetime(), note: column.string().nullable() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey() })
  const ownerTags = defineGeneratedTable(names.ownerTags, { owner_id: column.integer(), tag_id: column.integer(), note: column.string().nullable(), expires_at: column.timestamp().nullable() })
  registerGeneratedTables({ owners, slots, ownerSlots, tags, ownerTags })
  onTestFinished(() => clearGeneratedTables())
  const Slot = defineModel(slots, { timestamps: false })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(owners, {
    timestamps: false,
    relations: {
      slots: belongsToMany(() => Slot, ownerSlots, 'owner_id', 'starts_at', 'id', 'starts_at').withPivot('note'),
      tags: belongsToMany(() => Tag, ownerTags, 'owner_id', 'tag_id').withPivot('note', 'expires_at'),
    },
  })
  await DB.table(owners).insert({ id: 1 })
  await DB.table(tags).insert([{ id: 1 }, { id: 2 }])
  return { db, names, ownerSlots, ownerTags, owner: await Owner.findOrFail(1) }
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

  it.runIf(driver === 'postgres')('detects a change below a millisecond that a Date cannot hold', async () => {
    const { db, names, owner } = await openPivots(driver)
    await owner.attach('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })
    await db.unsafeExecute(unsafeSql(`UPDATE ${quote(driver, names.ownerTags)} SET ${quote(driver, 'expires_at')} = '2026-01-01 10:00:00.000002+00'`))

    expect(await owner.updateExistingPivot('tags', 1, { expires_at: '2026-01-01T10:00:00.000002Z' as never })).toBe(0)
    expect(await owner.updateExistingPivot('tags', 1, { expires_at: new Date('2026-01-01T10:00:00Z') })).toBe(1)
  })
})
