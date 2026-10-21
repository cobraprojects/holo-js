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
