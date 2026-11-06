import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, hasManyThrough, hasOneThrough, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

function ids(entities: readonly Entity<TableDefinition>[]): number[] {
  return entities.map(entity => Number(entity.get('id' as never))).sort((left, right) => left - right)
}

async function openThroughFixtures(driver: 'sqlite' | 'postgres' | 'mysql') {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { teams: `ts_teams_${suffix}`, members: `ts_members_${suffix}`, notes: `ts_notes_${suffix}` }
  await schema.createTable(names.teams, (table) => {
    table.integer('id').primaryKey()
  })
  onTestFinished(() => schema.dropTable(names.teams))
  await schema.createTable(names.members, (table) => {
    table.integer('id').primaryKey()
    table.integer('team_id')
    table.timestamp('removed_at').nullable()
  })
  onTestFinished(() => schema.dropTable(names.members))
  await schema.createTable(names.notes, (table) => {
    table.integer('id').primaryKey()
    table.integer('member_id')
  })
  onTestFinished(() => schema.dropTable(names.notes))

  const teams = defineGeneratedTable(names.teams, { id: column.integer().primaryKey() })
  const members = defineGeneratedTable(names.members, { id: column.integer().primaryKey(), team_id: column.integer(), removed_at: column.timestamp().nullable() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), member_id: column.integer() })
  const removedAt = new Date('2026-01-01T00:00:00Z')
  await DB.table(teams).insert([{ id: 1 }, { id: 2 }, { id: 3 }])
  await DB.table(members).insert([
    { id: 10, team_id: 1, removed_at: null },
    { id: 20, team_id: 2, removed_at: removedAt },
    { id: 30, team_id: 3, removed_at: removedAt },
  ])
  await DB.table(notes).insert([{ id: 100, member_id: 10 }, { id: 200, member_id: 20 }])

  const Note = defineModel(notes, { timestamps: false })
  const Member = defineModel(members, { timestamps: false, softDeletes: true, deletedAtColumn: 'removed_at' })
  const Team = defineModel(teams, {
    timestamps: false,
    relations: {
      notes: hasManyThrough(() => Note, () => Member, 'team_id', 'member_id'),
      firstNote: hasOneThrough(() => Note, () => Member, 'team_id', 'member_id'),
    },
  })
  return { Team, Member, membersTable: names.members }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('through relation filters and soft deletes on %s', (driver) => {
  it.each(['notes', 'firstNote'] as const)('skips through rows the through model soft deletes in %s filters, as eager loading does', async (name) => {
    const { Team } = await openThroughFixtures(driver)
    const loaded = await Team.with(name).orderBy('id').get() as unknown as Entity<TableDefinition>[]
    const expected = loaded.filter((entity) => {
      const value = entity.getRelation<unknown>(name)
      return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined
    })

    const has = await Team.has(name).get() as unknown as Entity<TableDefinition>[]
    const doesntHave = await Team.doesntHave(name).get() as unknown as Entity<TableDefinition>[]

    expect(ids(expected)).toEqual([1])
    expect(ids(has)).toEqual([1])
    expect(ids(doesntHave)).toEqual([2, 3])
  })

  it('reads the soft delete column from an aliased model source', async () => {
    const { Member, membersTable } = await openThroughFixtures(driver)

    const kept = await Member.query().from(`${membersTable} as m`).where('m.team_id', '>', 0).get() as unknown as Entity<TableDefinition>[]
    const removed = await Member.query().from(`${membersTable} as m`).onlyTrashed().get() as unknown as Entity<TableDefinition>[]

    expect(ids(kept)).toEqual([10])
    expect(ids(removed)).toEqual([20, 30])
  })
})
