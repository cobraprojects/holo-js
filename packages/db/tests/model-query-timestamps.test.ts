import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  column, configureDB, createConnectionManager, createDatabase, createDialect, resetDB,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

const past = new Date('2020-01-01T00:00:00.000Z')

async function openModelDatabase() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

function postsTable() {
  return defineTable('posts', {
    id: column.id(),
    slug: column.string().unique(),
    title: column.string(),
    views: column.integer(),
    settings: column.json<{ theme: string }>(),
    created_at: column.timestamp(),
    updated_at: column.timestamp(),
    deleted_at: column.timestamp().nullable(),
  })
}

async function seedPost(db: Awaited<ReturnType<typeof openModelDatabase>>, posts: ReturnType<typeof postsTable>) {
  await createTestTable(db, posts)
  await db.table(posts).insert({
    id: 1,
    slug: 'draft',
    title: 'Draft',
    views: 1,
    settings: { theme: 'light' },
    created_at: past,
    updated_at: past,
    deleted_at: null,
  })
}

describe('model query mutations apply updated_at like Laravel', () => {
  beforeEach(() => resetDB())

  it('bumps updated_at on query updates, JSON updates, increments and decrements when the caller omits it', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, { fillable: ['title', 'views', 'settings'] })
    const resetUpdatedAt = () => db.table(posts).where('id', 1).update({ updated_at: past })
    const updatedAt = async () => (await Post.findOrFail(1)).get('updated_at').getTime()

    await resetUpdatedAt()
    await Post.query().where('id', 1).update({ title: 'Published' })
    expect(await updatedAt()).toBeGreaterThan(past.getTime())

    await resetUpdatedAt()
    await Post.query().where('id', 1).updateJson('settings->theme', 'dark')
    expect(await updatedAt()).toBeGreaterThan(past.getTime())

    await resetUpdatedAt()
    await Post.query().where('id', 1).increment('views')
    expect(await updatedAt()).toBeGreaterThan(past.getTime())

    await resetUpdatedAt()
    await Post.query().where('id', 1).decrement('views')
    expect(await updatedAt()).toBeGreaterThan(past.getTime())

    await resetUpdatedAt()
    await Post.increment('views', 2)
    expect(await updatedAt()).toBeGreaterThan(past.getTime())
  })

  it('keeps a caller-supplied updated_at on query updates and increments', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, { fillable: ['title', 'views', 'settings', 'updated_at'] })
    const explicit = new Date('2021-06-01T00:00:00.000Z')

    await Post.query().where('id', 1).update({ title: 'Explicit', updated_at: explicit })
    expect((await Post.findOrFail(1)).get('updated_at')).toEqual(explicit)

    await Post.query().where('id', 1).increment('views', 1, { updated_at: past })
    expect((await Post.findOrFail(1)).get('updated_at')).toEqual(past)
  })

  it('leaves models without timestamps and the table builder unchanged', async () => {
    const db = await openModelDatabase()
    const notes = defineTable('notes', { id: column.id(), body: column.string() })
    await createTestTable(db, notes)
    await db.table(notes).insert({ id: 1, body: 'first' })
    const Note = defineModelFromTable(notes, { timestamps: false, fillable: ['body'] })
    await Note.query().where('id', 1).update({ body: 'second' })
    expect((await Note.findOrFail(1)).get('body')).toBe('second')

    const posts = postsTable()
    await seedPost(db, posts)
    await db.table(posts).where('id', 1).update({ title: 'Table' })
    expect((await defineModelFromTable(posts).findOrFail(1)).get('updated_at')).toEqual(past)
  })

  it('sets created_at and updated_at on upsert inserts and bumps updated_at on conflict', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, { fillable: ['slug', 'title', 'views', 'settings', 'updated_at'] })
    const started = Date.now()

    await Post.query().upsert([{ slug: 'new', title: 'New', views: 0, settings: { theme: 'light' } }], ['slug'], ['title'])
    const inserted = await Post.query().where('slug', 'new').firstOrFail()
    expect(inserted.get('created_at').getTime()).toBeGreaterThanOrEqual(started)
    expect(inserted.get('updated_at')).toEqual(inserted.get('created_at'))

    await Post.query().upsert([{ slug: 'explicit', title: 'Explicit', views: 0, settings: { theme: 'light' }, updated_at: past }], ['slug'], ['title'])
    expect((await Post.query().where('slug', 'explicit').firstOrFail()).get('updated_at')).toEqual(past)

    await db.table(posts).where('slug', 'new').update({ updated_at: past, created_at: past })
    await Post.query().upsert([{ slug: 'new', title: 'Renamed', views: 0, settings: { theme: 'light' } }], ['slug'], ['title'])
    const conflicted = await Post.query().where('slug', 'new').firstOrFail()
    expect(conflicted.get('title')).toBe('Renamed')
    expect(conflicted.get('created_at')).toEqual(past)
    expect(conflicted.get('updated_at').getTime()).toBeGreaterThan(past.getTime())
  })

  it('runs created_at and updated_at mutators on generated timestamps, as the save path does', async () => {
    const db = await openModelDatabase()
    const events = defineTable('events', {
      id: column.id(),
      name: column.string(),
      created_at: column.integer(),
      updated_at: column.integer(),
    })
    await createTestTable(db, events)
    await db.table(events).insert({ id: 1, name: 'Launch', created_at: 0, updated_at: 0 })
    const toEpoch = (value: unknown) => Date.parse(String(value))
    const Event = defineModelFromTable(events, { fillable: ['name'], mutators: { created_at: toEpoch, updated_at: toEpoch } })

    await Event.query().where('id', 1).update({ name: 'Shipped' })
    const row = await Event.findOrFail(1)
    expect(row.get('updated_at')).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'))
  })

  it('restores a soft-deleted row with the attribute values a fresh read returns', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, {
      softDeletes: true,
      fillable: ['title'],
      casts: { updated_at: { get: value => ({ at: value }), set: value => value } },
    })

    await Post.withTrashed().findOrFail(1).then(post => post.delete())
    const restored = await Post.withTrashed().findOrFail(1).then(post => post.restore())
    const fresh = await Post.findOrFail(1)
    expect(restored.get('updated_at')).toEqual(fresh.get('updated_at'))
  })

  it('applies deleted_at casts to a restored entity the way a fresh read does', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, {
      softDeletes: true,
      fillable: ['title'],
      casts: { deleted_at: { get: value => (value == null ? 'active' : value), set: value => value } },
    })

    await Post.withTrashed().findOrFail(1).then(post => post.delete())
    const restored = await Post.withTrashed().findOrFail(1).then(post => post.restore())
    expect(restored.get('deleted_at')).toBe('active')
    expect(restored.get('deleted_at')).toEqual((await Post.findOrFail(1)).get('deleted_at'))
  })

  it('bumps updated_at with deleted_at on query delete and restore, and force delete still removes the row', async () => {
    const db = await openModelDatabase()
    const posts = postsTable()
    await seedPost(db, posts)
    const Post = defineModelFromTable(posts, { softDeletes: true, fillable: ['title'] })

    await Post.query().where('id', 1).delete()
    const trashed = await Post.withTrashed().findOrFail(1)
    expect(trashed.get('deleted_at')).toBeInstanceOf(Date)
    expect(trashed.get('updated_at').getTime()).toBeGreaterThan(past.getTime())

    await db.table(posts).where('id', 1).update({ updated_at: past })
    expect(await Post.onlyTrashed().where('id', 1).restore()).toBe(1)
    const restored = await Post.findOrFail(1)
    expect(restored.get('deleted_at')).toBeNull()
    expect(restored.get('updated_at').getTime()).toBeGreaterThan(past.getTime())

    await Post.withTrashed().where('id', 1).forceDelete()
    expect(await db.table(posts).count()).toBe(0)
  })
})
