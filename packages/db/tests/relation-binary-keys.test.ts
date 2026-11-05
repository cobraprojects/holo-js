import { onTestFinished, describe, expect, it } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  type Entity,
  belongsTo,
  belongsToMany,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect as createDatabaseDialect,
  hasMany,
  hasManyThrough,
  hasOne,
  hasOneThrough,
  latestOfMany,
  morphMany,
  morphOne,
  morphTo,
  morphToMany,
  morphedByMany,
  type TableDefinition,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

function openSQLite() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({
    adapter,
    dialect: createDatabaseDialect('sqlite'),
    security: { redactBindingsInLogs: false, maxLoggedBindings: 100_000, allowUnsafeRawSql: true, debugSqlInLogs: true },
  })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

const keyA = Buffer.from('owner-a')
const keyB = Buffer.from('owner-b')

function loaded<TRelation>(entity: { getRelation<T>(name: string): T | undefined } | undefined, name: string): TRelation | undefined {
  if (!entity) throw new Error(`expected a loaded parent before reading ${name}`)
  return entity.getRelation<TRelation>(name)
}

function idsOf(entities: readonly Entity<TableDefinition>[] | Entity<TableDefinition> | null | undefined): unknown[] {
  if (!entities) return []
  const list = Array.isArray(entities) ? entities : [entities]
  return list.map(entity => entity.get('id'))
}

describe('relation loading over binary keys', () => {
  it('attaches hasMany rows across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const items = defineTable('items', { id: column.id(), ownerKey: column.blob(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, items)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(items).insert([
      { id: 1, ownerKey: keyA, label: 'one' },
      { id: 2, ownerKey: keyA, label: 'two' },
    ])

    const Item = defineModelFromTable(items)
    const Owner = defineModelFromTable(owners, { relations: { items: hasMany(() => Item, 'ownerKey', 'key') } })
    const [a, b] = await Owner.with('items').orderBy('name').get()

    expect(idsOf(loaded<Entity<TableDefinition>[]>(a, 'items'))).toEqual([1, 2])
    expect(idsOf(loaded<Entity<TableDefinition>[]>(b, 'items'))).toEqual([])
  })

  it('attaches hasOne rows across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const items = defineTable('items', { id: column.id(), ownerKey: column.blob(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, items)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(items).insert([{ id: 7, ownerKey: keyB, label: 'only' }])

    const Item = defineModelFromTable(items)
    const Owner = defineModelFromTable(owners, { relations: { item: hasOne(() => Item, 'ownerKey', 'key') } })
    const [a, b] = await Owner.with('item').orderBy('name').get()

    expect(idsOf(loaded<Entity<TableDefinition>>(a, 'item'))).toEqual([])
    expect(idsOf(loaded<Entity<TableDefinition>>(b, 'item'))).toEqual([7])
  })

  it('attaches belongsTo owners across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const items = defineTable('items', { id: column.id(), ownerKey: column.blob(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, items)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(items).insert([{ id: 1, ownerKey: keyB, label: 'one' }])

    const Owner = defineModelFromTable(owners)
    const Item = defineModelFromTable(items, { relations: { owner: belongsTo(() => Owner, 'ownerKey', 'key') } })
    const [item] = await Item.with('owner').get()

    expect(loaded<Entity<TableDefinition>>(item, 'owner')?.get('name')).toBe('B')
  })

  it('attaches the latest hasOneOfMany row across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const items = defineTable('items', { id: column.id(), ownerKey: column.blob(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, items)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(items).insert([
      { id: 1, ownerKey: keyA, label: 'old' },
      { id: 2, ownerKey: keyA, label: 'new' },
    ])

    const Item = defineModelFromTable(items)
    const Owner = defineModelFromTable(owners, { relations: { latestItem: latestOfMany(() => Item, 'ownerKey', 'key') } })
    const [a, b] = await Owner.with('latestItem').orderBy('name').get()

    expect(idsOf(loaded<Entity<TableDefinition>>(a, 'latestItem'))).toEqual([2])
    expect(idsOf(loaded<Entity<TableDefinition>>(b, 'latestItem'))).toEqual([])
  })

  it('attaches morphOne and morphMany rows across blob morph ids', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const comments = defineTable('comments', {
      id: column.id(),
      commentableType: column.string(),
      commentableId: column.blob(),
      body: column.string(),
    })
    await createTestTable(db, owners)
    await createTestTable(db, comments)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])

    const Comment = defineModelFromTable(comments, { relations: { commentable: morphTo('commentable', 'commentableType', 'commentableId') } })
    const Owner = defineModelFromTable(owners, {
      relations: {
        comments: morphMany(() => Comment, 'commentable', 'commentableType', 'commentableId', 'key'),
        latestComment: morphOne(() => Comment, 'commentable', 'commentableType', 'commentableId', 'key'),
      },
    })
    const morphType = Owner.definition.morphClass
    await db.table(comments).insert([
      { id: 1, commentableType: morphType, commentableId: keyA, body: 'first' },
      { id: 2, commentableType: morphType, commentableId: keyA, body: 'second' },
    ])

    const [a, b] = await Owner.with('comments', 'latestComment').orderBy('name').get()

    expect(idsOf(loaded<Entity<TableDefinition>[]>(a, 'comments'))).toEqual([1, 2])
    expect(idsOf(loaded<Entity<TableDefinition>[]>(b, 'comments'))).toEqual([])
    expect(idsOf(loaded<Entity<TableDefinition>>(a, 'latestComment'))).toEqual([1])
  })

  it('resolves morphTo parents across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const comments = defineTable('comments', {
      id: column.id(),
      commentableType: column.string(),
      commentableId: column.blob(),
      body: column.string(),
    })
    await createTestTable(db, owners)
    await createTestTable(db, comments)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])

    const Owner = defineModelFromTable(owners, {})
    const Comment = defineModelFromTable(comments, { relations: { commentable: morphTo('commentable', 'commentableType', 'commentableId') } })
    await db.table(comments).insert([{ id: 1, commentableType: Owner.definition.morphClass, commentableId: keyB, body: 'b' }])

    const [comment] = await Comment.with('commentable').get()

    expect(loaded<Entity<TableDefinition>>(comment, 'commentable')?.get('name')).toBe('B')
  })

  it('attaches hasManyThrough and hasOneThrough rows across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const teams = defineTable('teams', { id: column.id(), ownerKey: column.blob() })
    const members = defineTable('members', { id: column.id(), teamId: column.integer(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, teams)
    await createTestTable(db, members)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(teams).insert([{ id: 1, ownerKey: keyA }, { id: 2, ownerKey: keyB }])
    await db.table(members).insert([
      { id: 10, teamId: 1, label: 'x' },
      { id: 11, teamId: 1, label: 'y' },
      { id: 12, teamId: 2, label: 'z' },
    ])

    const Team = defineModelFromTable(teams)
    const Member = defineModelFromTable(members)
    const Owner = defineModelFromTable(owners, {
      relations: {
        members: hasManyThrough(() => Member, () => Team, 'ownerKey', 'teamId', 'key', 'id'),
        member: hasOneThrough(() => Member, () => Team, 'ownerKey', 'teamId', 'key', 'id'),
      },
    })
    const [a, b] = await Owner.with('members', 'member').orderBy('name').get()

    expect(idsOf(loaded<Entity<TableDefinition>[]>(a, 'members'))).toEqual([10, 11])
    expect(idsOf(loaded<Entity<TableDefinition>[]>(b, 'members'))).toEqual([12])
    expect(idsOf(loaded<Entity<TableDefinition>>(a, 'member'))).toEqual([10])
  })

  it('attaches belongsToMany rows across blob keys on both sides of the pivot', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const roles = defineTable('roles', { key: column.blob().primaryKey(), name: column.string() })
    const ownerRole = defineTable('owner_role', { id: column.id(), ownerKey: column.blob(), roleKey: column.blob() })
    await createTestTable(db, owners)
    await createTestTable(db, roles)
    await createTestTable(db, ownerRole)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(roles).insert([{ key: Buffer.from('admin'), name: 'Admin' }, { key: Buffer.from('editor'), name: 'Editor' }])
    await db.table(ownerRole).insert([
      { id: 1, ownerKey: keyA, roleKey: Buffer.from('admin') },
      { id: 2, ownerKey: keyA, roleKey: Buffer.from('editor') },
    ])

    const Role = defineModelFromTable(roles)
    const Owner = defineModelFromTable(owners, {
      relations: { roles: belongsToMany(() => Role, ownerRole, 'ownerKey', 'roleKey', 'key', 'key') },
    })
    const [a, b] = await Owner.with('roles').orderBy('name').get()

    expect((loaded<Entity<TableDefinition>[]>(a, 'roles') ?? []).map(role => role.get('name'))).toEqual(['Admin', 'Editor'])
    expect(loaded<Entity<TableDefinition>[]>(b, 'roles')).toEqual([])
  })

  it('treats a single binary or date pivot id as one id, not an id map', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const roles = defineTable('roles', { key: column.blob().primaryKey(), name: column.string() })
    const ownerRole = defineTable('owner_role', { ownerKey: column.blob(), roleKey: column.blob(), note: column.string().nullable() })
    const slots = defineTable('slots', { startsAt: column.timestamp().primaryKey() })
    const ownerSlot = defineTable('owner_slot', { ownerKey: column.blob(), startsAt: column.timestamp() })
    for (const table of [owners, roles, ownerRole, slots, ownerSlot]) await createTestTable(db, table)
    const admin = Buffer.from('admin')
    const startsAt = new Date('2026-01-02T03:04:05.000Z')
    await db.table(owners).insert([{ key: keyA, name: 'A' }])
    await db.table(roles).insert([{ key: admin, name: 'Admin' }])
    await db.table(slots).insert([{ startsAt }])

    const Role = defineModelFromTable(roles)
    const Slot = defineModelFromTable(slots)
    const Owner = defineModelFromTable(owners, {
      relations: {
        roles: belongsToMany(() => Role, ownerRole, 'ownerKey', 'roleKey', 'key', 'key').withPivot('note'),
        slots: belongsToMany(() => Slot, ownerSlot, 'ownerKey', 'startsAt', 'key', 'startsAt'),
      },
    })
    const owner = await Owner.findOrFail(keyA)
    const pivotRows = async () => (await db.table(ownerRole).get()).map(row => ({ roleKey: Buffer.from(row.roleKey as Uint8Array).toString(), note: row.note }))

    await owner.attach('roles', admin, { note: 'first' })
    expect(await pivotRows()).toEqual([{ roleKey: 'admin', note: 'first' }])
    expect(await owner.updateExistingPivot('roles', admin, { note: 'second' })).toBe(1)
    expect(await pivotRows()).toEqual([{ roleKey: 'admin', note: 'second' }])
    expect(await owner.toggle('roles', admin)).toEqual({ attached: [], detached: [admin] })
    expect(await pivotRows()).toEqual([])
    expect(await owner.sync('roles', admin)).toEqual({ attached: [admin], detached: [], updated: [] })
    expect(await owner.detach('roles', admin)).toBe(1)
    expect(await pivotRows()).toEqual([])

    await owner.attach('slots', startsAt)
    expect(await db.table(ownerSlot).count()).toBe(1)
    expect(await owner.detach('slots', startsAt)).toBe(1)
    expect(await db.table(ownerSlot).count()).toBe(0)

    const adminBytes = new Uint8Array(admin)
    await owner.attach('roles', admin)
    expect(await owner.syncWithoutDetaching('roles', new DataView(admin.buffer, admin.byteOffset, admin.byteLength))).toEqual({ attached: [], detached: [], updated: [] })
    await owner.detach('roles')
    await owner.attach('roles', adminBytes)
    expect(await owner.syncWithoutDetaching('roles', [adminBytes, admin])).toEqual({ attached: [], detached: [], updated: [] })
    expect(await owner.toggle('roles', adminBytes)).toEqual({ attached: [], detached: [adminBytes] })
    expect(await pivotRows()).toEqual([])

    await owner.attach('slots', startsAt)
    expect(await owner.sync('slots', new Date(startsAt.getTime()))).toEqual({ attached: [], detached: [], updated: [] })
    expect(await owner.toggle('slots', [new Date(startsAt.getTime())])).toEqual({ attached: [], detached: [startsAt] })
    expect(await db.table(ownerSlot).count()).toBe(0)

    await owner.attach('slots', '2026-01-02 03:04:05')
    expect(await owner.syncWithoutDetaching('slots', [startsAt, '2026-01-02 03:04:05'])).toEqual({ attached: [], detached: [], updated: [] })
    expect(await owner.sync('slots', '2026-01-02 03:04:05')).toEqual({ attached: [], detached: [], updated: [] })
    expect(await db.table(ownerSlot).count()).toBe(1)
  })

  it('matches id map keys against non-integer numeric pivot keys', async () => {
    const db = openSQLite()
    const owners = defineTable('real_key_owners', { id: column.id(), name: column.string() })
    const grades = defineTable('real_key_grades', { score: column.real().primaryKey() })
    const ownerGrade = defineTable('real_key_owner_grade', { ownerId: column.integer(), score: column.real(), note: column.string().nullable() })
    for (const table of [owners, grades, ownerGrade]) await createTestTable(db, table)
    await db.table(owners).insert([{ id: 1, name: 'A' }])
    await db.table(grades).insert([{ score: 1.5 }])
    const Grade = defineModelFromTable(grades)
    const Owner = defineModelFromTable(owners, {
      relations: { grades: belongsToMany(() => Grade, ownerGrade, 'ownerId', 'score', 'id', 'score').withPivot('note') },
    })
    const owner = await Owner.findOrFail(1)

    await owner.attach('grades', 1.5, { note: 'old' })
    expect(await owner.sync('grades', { '1.5': { note: 'new' } })).toEqual({ attached: [], detached: [], updated: ['1.5'] })
    expect(await db.table(ownerGrade).get()).toEqual([{ ownerId: 1, score: 1.5, note: 'new' }])
  })

  it('keeps timestamp pivot keys distinct below a millisecond', async () => {
    const db = openSQLite()
    const owners = defineTable('micro_key_owners', { id: column.id(), name: column.string() })
    const slots = defineTable('micro_key_slots', { startsAt: column.timestamp().primaryKey() })
    const ownerSlot = defineTable('micro_key_owner_slot', { ownerId: column.integer(), startsAt: column.string(), note: column.string().nullable() })
    for (const table of [owners, slots, ownerSlot]) await createTestTable(db, table)
    const first = '2026-01-02 03:04:05.000001'
    const second = '2026-01-02 03:04:05.000002'
    await db.table(owners).insert([{ id: 1, name: 'A' }])
    await db.table(ownerSlot).insert([{ ownerId: 1, startsAt: first }, { ownerId: 1, startsAt: second }])
    const Slot = defineModelFromTable(slots)
    const Owner = defineModelFromTable(owners, {
      relations: { slots: belongsToMany(() => Slot, 'micro_key_owner_slot', 'ownerId', 'startsAt', 'id', 'startsAt').withPivot('note') },
    })
    const owner = await Owner.findOrFail(1)

    expect(await owner.sync('slots', { [first]: { note: 'changed' } })).toEqual({ attached: [], detached: [second], updated: [first] })
    expect(await db.table(ownerSlot).get()).toEqual([{ ownerId: 1, startsAt: first, note: 'changed' }])

    await db.table(ownerSlot).insert([{ ownerId: 1, startsAt: 'never' }, { ownerId: 1, startsAt: 'someday' }])
    expect(await owner.sync('slots', [first, 'never'])).toEqual({ attached: [], detached: ['someday'], updated: [] })
  })

  it('matches unsafe big integer pivot ids on an untyped pivot table', async () => {
    const db = openSQLite()
    const owners = defineTable('big_key_owners', { id: column.id(), name: column.string() })
    const accounts = defineTable('big_key_accounts', { id: column.bigInteger().primaryKey() })
    const ownerAccount = defineTable('big_key_owner_account', { ownerId: column.integer(), accountId: column.bigInteger() })
    for (const table of [owners, accounts, ownerAccount]) await createTestTable(db, table)
    const big = 9007199254740993n
    await db.table(owners).insert([{ id: 1, name: 'A' }])
    await db.table(accounts).insert([{ id: big }])
    const Account = defineModelFromTable(accounts)
    const Owner = defineModelFromTable(owners, {
      relations: { accounts: belongsToMany(() => Account, 'big_key_owner_account', 'ownerId', 'accountId') },
    })
    const owner = await Owner.findOrFail(1)

    await owner.attach('accounts', big)
    expect(await owner.sync('accounts', [big])).toEqual({ attached: [], detached: [], updated: [] })
    expect(await owner.toggle('accounts', big)).toEqual({ attached: [], detached: [big] })
    expect(await db.table(ownerAccount).count()).toBe(0)
  })

  it('attaches morphToMany and morphedByMany rows across blob keys', async () => {
    const db = openSQLite()
    const posts = defineTable('posts', { key: column.blob().primaryKey(), title: column.string() })
    const tags = defineTable('tags', { key: column.blob().primaryKey(), name: column.string() })
    const taggables = defineTable('taggables', {
      id: column.id(),
      tagKey: column.blob(),
      taggableType: column.string(),
      taggableId: column.blob(),
    })
    await createTestTable(db, posts)
    await createTestTable(db, tags)
    await createTestTable(db, taggables)
    await db.table(posts).insert([{ key: keyA, title: 'post-a' }, { key: keyB, title: 'post-b' }])
    await db.table(tags).insert([{ key: Buffer.from('t1'), name: 'tag-1' }])

    const Tag = defineModelFromTable(tags, {})
    const Post = defineModelFromTable(posts, {
      relations: { tags: morphToMany(() => Tag, 'taggable', taggables, 'tagKey', 'key', 'key', 'taggableType', 'taggableId') },
    })
    const TagWithPosts = defineModelFromTable(tags, {
      relations: { posts: morphedByMany(() => Post, 'taggable', taggables, 'tagKey', 'key', 'key', 'taggableType', 'taggableId') },
    })
    await db.table(taggables).insert([
      { id: 1, tagKey: Buffer.from('t1'), taggableType: Post.definition.morphClass, taggableId: keyA },
    ])

    const [postA, postB] = await Post.with('tags').orderBy('title').get()
    const [tag] = await TagWithPosts.with('posts').get()

    expect((loaded<Entity<TableDefinition>[]>(postA, 'tags') ?? []).map(entity => entity.get('name'))).toEqual(['tag-1'])
    expect(loaded<Entity<TableDefinition>[]>(postB, 'tags')).toEqual([])
    expect((loaded<Entity<TableDefinition>[]>(tag, 'posts') ?? []).map(entity => entity.get('title'))).toEqual(['post-a'])
  })

  it('counts and filters hasMany rows across blob keys', async () => {
    const db = openSQLite()
    const owners = defineTable('owners', { key: column.blob().primaryKey(), name: column.string() })
    const items = defineTable('items', { id: column.id(), ownerKey: column.blob(), label: column.string() })
    await createTestTable(db, owners)
    await createTestTable(db, items)
    await db.table(owners).insert([{ key: keyA, name: 'A' }, { key: keyB, name: 'B' }])
    await db.table(items).insert([
      { id: 1, ownerKey: keyA, label: 'one' },
      { id: 2, ownerKey: keyA, label: 'two' },
    ])

    const Item = defineModelFromTable(items)
    const Owner = defineModelFromTable(owners, { relations: { items: hasMany(() => Item, 'ownerKey', 'key') } })
    const withItems = await Owner.whereHas('items').get()
    const counted = await Owner.withCount('items').orderBy('name').get()

    expect(withItems.map(owner => owner.get('name'))).toEqual(['A'])
    expect(counted.map(owner => (owner.toJSON() as Record<string, unknown>).items_count)).toEqual([2, 0])
  })
})
