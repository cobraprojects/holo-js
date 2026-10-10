import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Entity, belongsTo, belongsToMany, hasMany, morphToMany, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
import type { QuerySuccessLog } from '../src/core/types'

const users = defineGeneratedTable('pivot_users', { id: column.id() })
const roles = defineGeneratedTable('pivot_roles', { id: column.id() })
const pivots = defineGeneratedTable('pivot_memberships', { userId: column.integer(), roleId: column.integer(), note: column.string(), rank: column.integer() })
const Role = defineModel(roles, { timestamps: false })
const User = defineModel(users, { timestamps: false, relations: { roles: belongsToMany(() => Role, pivots, 'userId', 'roleId').withPivot('note', 'rank') } })

describe('pivot mutation integration', () => {
  let adapter: ReturnType<typeof createSQLiteAdapter>
  let logs: QuerySuccessLog[]

  beforeEach(async () => {
    adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    await adapter.execute('CREATE TABLE pivot_users (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE pivot_roles (id INTEGER PRIMARY KEY)')
    await adapter.execute("CREATE TABLE pivot_memberships (userId INTEGER NOT NULL, roleId INTEGER NOT NULL, note TEXT NOT NULL DEFAULT 'default', rank INTEGER NOT NULL DEFAULT 0, UNIQUE(userId, roleId))")
    await adapter.execute('INSERT INTO pivot_users VALUES (1), (2)')
    await adapter.execute('INSERT INTO pivot_roles VALUES (1), (2), (3), (4)')
    logs = []
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('sqlite'), security: { maxLoggedBindings: 2000 }, logger: { onQuerySuccess: log => { logs.push(log) } } } } }))
  })

  afterEach(async () => {
    await adapter.disconnect()
    resetDB()
  })

  it('batches compatible attachments and toggles without losing result order', async () => {
    const user = await User.findOrFail(1)
    expect(await user.sync('roles', [3, 1, 2])).toEqual({ attached: [3, 1, 2], detached: [], updated: [] })
    expect(logs.filter(log => log.source === 'query:insert:pivot_memberships')).toHaveLength(1)
    logs.length = 0
    expect(await user.toggle('roles', [3, 1, 4])).toEqual({ attached: [4], detached: [3, 1] })
    expect(logs.filter(log => log.source === 'query:delete:pivot_memberships')).toHaveLength(1)
    await user.load('roles')
    expect(user.getRelation<Entity<typeof roles>[]>('roles').map(role => role.get('id'))).toEqual([2, 4])
  })
  it('preserves omitted attribute defaults, no-op writes, parent scope and duplicate results', async () => {
    const user = await User.findOrFail(1)
    const other = await User.findOrFail(2)
    await other.attach('roles', [1, 2])
    expect(await user.sync('roles', { 1: { note: 'first' }, 2: { rank: 7 }, 3: {} })).toEqual({ attached: [1, 2, 3], detached: [], updated: [] })
    await user.load('roles')
    expect(user.getRelation<Entity<typeof roles>[]>('roles').map(role => role.getRelation('pivot'))).toEqual([
      { userId: 1, roleId: 1, note: 'first', rank: 0 },
      { userId: 1, roleId: 2, note: 'default', rank: 7 },
      { userId: 1, roleId: 3, note: 'default', rank: 0 },
    ])
    logs.length = 0
    expect(await user.sync('roles', { 1: { note: 'first' }, 2: { rank: 7 }, 3: {} })).toEqual({ attached: [], detached: [], updated: [] })
    expect(logs.filter(log => log.kind === 'execute')).toEqual([])
    expect(await user.toggle('roles', [1, 1])).toEqual({ attached: [], detached: [1, 1] })
    await other.load('roles')
    expect(other.getRelation<Entity<typeof roles>[]>('roles').map(role => role.get('id'))).toEqual([1, 2])
    await expect(user.attach('roles', 4, { userId: 2 })).rejects.toThrow('reserved')
    await expect(user.attach('roles', 4, { undeclared: true })).rejects.toThrow('withPivot')
  })

  it('rolls back earlier updates and inserts when a later duplicate insert fails', async () => {
    const user = await User.findOrFail(1)
    await user.attach('roles', 1, { note: 'original' })
    await expect(user.sync('roles', [2, 2])).rejects.toThrow()
    await user.load('roles')
    expect(user.getRelation<Entity<typeof roles>[]>('roles').map(role => role.get('id'))).toEqual([1])
    await expect(user.sync('roles', { 1: { note: 'changed' }, 2: { note: null } })).rejects.toThrow()
    await user.load('roles')
    expect(user.getRelation<Entity<typeof roles>[]>('roles')[0]?.getRelation('pivot')).toMatchObject({ note: 'original' })
  })

  it('bounds reads and writes across a large attachment and detachment', async () => {
    await adapter.execute('WITH RECURSIVE ids(id) AS (SELECT 5 UNION ALL SELECT id + 1 FROM ids WHERE id < 950) INSERT INTO pivot_roles SELECT id FROM ids')
    const user = await User.findOrFail(1)
    const ids = Array.from({ length: 950 }, (_, index) => index + 1)
    await user.attach('roles', ids)
    expect(logs.filter(log => log.source === 'query:insert:pivot_memberships')).toHaveLength(3)
    expect(logs.filter(log => log.source === 'query:select:pivot_memberships')).toHaveLength(2)
    expect(logs.every(log => log.bindings.length <= 900)).toBe(true)
    await user.load('roles')
    expect(user.getRelation<Entity<typeof roles>[]>('roles')).toHaveLength(950)
    logs.length = 0
    expect(await user.sync('roles', [])).toEqual({ attached: [], detached: ids, updated: [] })
    expect(logs.filter(log => log.source === 'query:delete:pivot_memberships')).toHaveLength(2)
    expect(logs.every(log => log.bindings.length <= 900)).toBe(true)
    await user.load('roles')
    expect(user.getRelation('roles')).toEqual([])
  })

  it('retrieves constrained relations in batches while retaining duplicate pivots and independent pivot attributes', async () => {
    await adapter.execute('DROP TABLE pivot_memberships')
    await adapter.execute("CREATE TABLE pivot_memberships (userId INTEGER, roleId INTEGER, note TEXT DEFAULT 'default', rank INTEGER DEFAULT 0)")
    const user = await User.findOrFail(1)
    await user.attach('roles', [2, 2, 1], { note: 'duplicate' })
    const other = await User.findOrFail(2)
    await other.attach('roles', 2, { note: 'other' })
    logs.length = 0
    const loaded = await User.with({ roles: query => query.where('id', 2) }).withCount('roles').orderBy('id').get()
    expect(loaded.map(entity => entity.getRelation<Entity<typeof roles>[]>('roles').map(role => role.get('id')))).toEqual([[2, 2], [2]])
    expect(loaded.map(entity => entity.toAttributes())).toMatchObject([{ roles_count: 3 }, { roles_count: 1 }])
    const first = loaded[0]?.getRelation<Entity<typeof roles>[]>('roles')[0]
    const second = loaded[0]?.getRelation<Entity<typeof roles>[]>('roles')[1]
    const third = loaded[1]?.getRelation<Entity<typeof roles>[]>('roles')[0]
    expect(first).not.toBe(second)
    expect(first).not.toBe(third)
    expect(first?.getRelation('pivot')).toMatchObject({ note: 'duplicate', userId: 1 })
    expect(third?.getRelation('pivot')).toMatchObject({ note: 'other', userId: 2 })
    expect(logs.filter(log => log.source === 'query:select:pivot_roles')).toHaveLength(2)
  })

  it('retrieves constrained has-many and belongs-to collections with missing matches', async () => {
    const Membership = defineModel(pivots, { primaryKey: 'roleId', timestamps: false, relations: { user: belongsTo(() => User, 'userId') } })
    const Parent = defineModel(users, { name: 'Parent', timestamps: false, relations: { memberships: hasMany(() => Membership, 'userId') } })
    const user = await User.findOrFail(1)
    await user.attach('roles', { 1: { rank: 1 }, 2: { rank: 2 } })
    logs.length = 0
    const parents = await Parent.with({ memberships: query => query.where('rank', 2) }).orderBy('id').get()
    expect(parents.map(parent => parent.getRelation<Entity<typeof pivots>[]>('memberships').map(membership => membership.get('roleId')))).toEqual([[2], []])
    expect(logs.filter(log => log.kind === 'query')).toHaveLength(2)
    logs.length = 0
    const memberships = await Membership.with({ user: query => query.where('id', 2) }).get()
    expect(memberships.map(membership => membership.getRelation('user'))).toEqual([null, null])
    expect(logs.filter(log => log.kind === 'query')).toHaveLength(2)
  })

  it('isolates polymorphic mutations with overlapping parent identifiers', async () => {
    const morphPivots = defineGeneratedTable('morph_memberships', { subjectType: column.string(), subjectId: column.integer(), roleId: column.integer() })
    await adapter.execute('CREATE TABLE morph_memberships (subjectType TEXT, subjectId INTEGER, roleId INTEGER)')
    const Person = defineModel(users, { name: 'Person', timestamps: false, morphClass: 'people', relations: { roles: morphToMany(() => Role, 'subject', morphPivots, 'roleId', 'id', 'id', 'subjectType', 'subjectId') } })
    const Team = defineModel(users, { name: 'Team', timestamps: false, morphClass: 'teams', relations: { roles: morphToMany(() => Role, 'subject', morphPivots, 'roleId', 'id', 'id', 'subjectType', 'subjectId') } })
    const person = await Person.findOrFail(1)
    const team = await Team.findOrFail(1)
    await person.attach('roles', [1, 2])
    await team.attach('roles', [1, 2])
    expect(await person.toggle('roles', [1, 2])).toEqual({ attached: [], detached: [1, 2] })
    await person.load('roles')
    await team.load('roles')
    expect(person.getRelation('roles')).toEqual([])
    expect(team.getRelation<Entity<typeof roles>[]>('roles').map(role => role.get('id'))).toEqual([1, 2])
    await expect(team.attach('roles', 3, { subjectType: 'people' })).rejects.toThrow('reserved')
  })

})
