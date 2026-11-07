import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, hasManyThrough, hasOneThrough, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

function ids(entities: readonly { get(column: never): unknown }[]): number[] {
  return entities.map(entity => Number(entity.get('id' as never))).sort((left, right) => left - right)
}

function hasRelated(entity: Pick<Entity<TableDefinition>, 'getRelation'>, name: string): boolean {
  const value = entity.getRelation<unknown>(name)
  return Array.isArray(value) ? value.length > 0 : value != null
}

async function openThroughFixtures(driver: 'sqlite' | 'postgres' | 'mysql', scope?: 'tenant' | 'joinedTenant' | 'bounded' | 'aliased' | 'withTrashed', relatedSoftDeletes = false) {
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
    table.integer('tenant_id')
  })
  onTestFinished(() => schema.dropTable(names.members))
  await schema.createTable(names.notes, (table) => {
    table.integer('id').primaryKey()
    table.integer('member_id')
    table.timestamp('removed_at').nullable()
  })
  onTestFinished(() => schema.dropTable(names.notes))

  const teams = defineGeneratedTable(names.teams, { id: column.integer().primaryKey() })
  const members = defineGeneratedTable(names.members, { id: column.integer().primaryKey(), team_id: column.integer(), removed_at: column.timestamp().nullable(), tenant_id: column.integer() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), member_id: column.integer(), removed_at: column.timestamp().nullable() })
  const removedAt = new Date('2026-01-01T00:00:00Z')
  await DB.table(teams).insert([{ id: 1 }, { id: 2 }, { id: 3 }])
  await DB.table(members).insert([
    { id: 10, team_id: 1, removed_at: null, tenant_id: scope === 'joinedTenant' ? 2 : 1 },
    { id: 20, team_id: 2, removed_at: scope === 'tenant' || scope === 'joinedTenant' || scope === 'bounded' ? null : removedAt, tenant_id: scope === 'joinedTenant' ? 1 : 2 },
    { id: 30, team_id: 3, removed_at: removedAt, tenant_id: 2 },
  ])
  await DB.table(notes).insert([{ id: 100, member_id: 10, removed_at: null }, { id: 200, member_id: 20, removed_at: null }])

  if (relatedSoftDeletes) {
    await DB.table(members).insert({ id: 31, team_id: 3, removed_at: null, tenant_id: 1 })
    await DB.table(notes).insert({ id: 300, member_id: 31, removed_at: removedAt })
  }

  const Note = defineModel(notes, { timestamps: false, softDeletes: relatedSoftDeletes, deletedAtColumn: 'removed_at', globalScopes: scope === 'aliased' ? { aliased: query => query.from(`${names.notes} as scoped`) } : {} })
  const Member = defineModel(members, { timestamps: false, softDeletes: true, deletedAtColumn: 'removed_at', globalScopes: scope === 'tenant'
    ? { tenant: query => query.withTrashed().where('tenant_id', 1) }
    : scope === 'joinedTenant' ? { tenant: query => query.join(names.teams, `${names.members}.tenant_id`, '=', `${names.teams}.id`).where(`${names.teams}.id` as never, 1) }
    : scope === 'bounded' ? { first: query => query.orderBy('id').limit(1) }
    : scope === 'aliased' ? { aliased: query => query.from(`${names.members} as scoped`) }
    : scope === 'withTrashed' ? { trashed: query => query.withTrashed() } : {} })
  const Team = defineModel(teams, {
    timestamps: false,
    relations: {
      notes: hasManyThrough(() => Note, () => Member, 'team_id', 'member_id'),
      firstNote: hasOneThrough(() => Note, () => Member, 'team_id', 'member_id'),
    },
  })
  return { Team, Member, membersTable: names.members, notesTable: names.notes }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('through relation filters and soft deletes on %s', (driver) => {
  it.each(['notes', 'firstNote'] as const)('skips through rows the through model soft deletes in %s filters, as eager loading does', async (name) => {
    const { Team } = await openThroughFixtures(driver)
    const loaded = await Team.with(name).orderBy('id').get() as unknown as Entity<TableDefinition>[]
    const expected = loaded.filter(entity => hasRelated(entity, name))

    const has = await Team.has(name).get() as unknown as Entity<TableDefinition>[]
    const doesntHave = await Team.doesntHave(name).get() as unknown as Entity<TableDefinition>[]

    expect(ids(expected)).toEqual([1])
    expect(ids(has)).toEqual([1])
    expect(ids(doesntHave)).toEqual([2, 3])
  })

  it.each(['notes', 'firstNote'] as const)('applies through global scopes to %s filters and counts, as eager loading does', async (name) => {
    const { Team, notesTable } = await openThroughFixtures(driver, 'tenant')
    const loaded = await Team.with(name).orderBy('id').get()
    const expected = loaded.filter(entity => hasRelated(entity, name))

    expect(ids(expected)).toEqual([1])
    expect(ids(await Team.has(name).get())).toEqual(ids(expected))
    expect(ids(await Team.whereHas(name, query => query.where(`${notesTable}.id` as never, '>', 0)).get())).toEqual(ids(expected))
    expect(ids(await Team.whereDoesntHave(name).get())).toEqual([2, 3])
    const counted = await Team.withCount(name).orderBy('id').get()
    expect(counted.map(entity => Number(entity.get(`${name}_count` as never)))).toEqual([1, 0, 0])
  })

  it('applies a through global scope that joins a table with overlapping columns', async () => {
    const { Team } = await openThroughFixtures(driver, 'joinedTenant')
    const loaded = await Team.with('notes').orderBy('id').get()

    expect(ids(loaded.filter(entity => hasRelated(entity, 'notes')))).toEqual([2])
    expect(ids(await Team.has('notes').get())).toEqual([2])
  })

  it('applies parent constraints before a bounded through global scope', async () => {
    const { Team } = await openThroughFixtures(driver, 'bounded')
    const loaded = await Team.where('id', 2).with('notes').get()

    expect(ids(loaded.filter(entity => hasRelated(entity, 'notes')))).toEqual([2])
    expect(ids(await Team.where('id', 2).has('notes').get())).toEqual([2])
  })

  it('keeps independently aliased related and through scopes separate', async () => {
    const { Team } = await openThroughFixtures(driver, 'aliased')
    const loaded = await Team.with('notes').get()

    expect(ids(loaded.filter(entity => hasRelated(entity, 'notes')))).toEqual([1])
    expect(ids(await Team.has('notes').get())).toEqual([1])
  })

  it.each(['notes', 'firstNote'] as const)('honors through global scopes that include trashed rows in %s filters', async (name) => {
    const { Team } = await openThroughFixtures(driver, 'withTrashed')
    const loaded = await Team.with(name).orderBy('id').get()
    const expected = loaded.filter(entity => hasRelated(entity, name))

    expect(ids(expected)).toEqual([1, 2])
    expect(ids(await Team.has(name).get())).toEqual(ids(expected))
  })

  it.each(['notes', 'firstNote'] as const)('qualifies soft deletes when both models soft-delete in %s filters', async (name) => {
    const { Team } = await openThroughFixtures(driver, undefined, true)
    const loaded = await Team.with(name).orderBy('id').get()
    const expected = loaded.filter(entity => hasRelated(entity, name))

    expect(ids(expected)).toEqual([1])
    expect(ids(await Team.has(name).get())).toEqual(ids(expected))
    expect(ids(await Team.whereHas(name, query => query.onlyTrashed()).get())).toEqual([3])
    expect(ids(await Team.whereHas(name, query => query.withTrashed()).get())).toEqual([1, 3])
    expect(ids(await Team.whereDoesntHave(name).get())).toEqual([2, 3])
    const counted = await Team.withCount(name).orderBy('id').get()
    expect(counted.map(entity => Number(entity.get(`${name}_count` as never)))).toEqual([1, 0, 0])
  })

  it('keeps an ungrouped orWhere constraint behind the through soft delete check', async () => {
    const { Team, notesTable } = await openThroughFixtures(driver)

    const matched = await Team.whereHas('notes', query => query.where(`${notesTable}.id` as never, 100).orWhere(`${notesTable}.id` as never, 200)).get() as unknown as Entity<TableDefinition>[]

    expect(ids(matched)).toEqual([1])
  })

  it('reads the soft delete column from an aliased model source', async () => {
    const { Member, membersTable } = await openThroughFixtures(driver)

    const kept = await Member.query().from(`${membersTable} as m`).where('m.team_id', '>', 0).get() as unknown as Entity<TableDefinition>[]
    const removed = await Member.query().from(`${membersTable} as m`).onlyTrashed().get() as unknown as Entity<TableDefinition>[]

    expect(ids(kept)).toEqual([10])
    expect(ids(removed)).toEqual([20, 30])
  })
})
