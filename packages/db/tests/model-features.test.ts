import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  DB, HasSnowflakes, HasUlids, HasUniqueIds, HasUuids,
  binaryCast, belongsTo, column, configureDB, createConnectionManager,
  createDatabase, createDialect, encryptedCast, enumCast, resetDB,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

async function openModelDatabase() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

beforeEach(() => resetDB())

describe('native model attributes and persistence', () => {
  it('persists mutators and casts while applying accessors, hidden fields, and appends', async () => {
    const db = await openModelDatabase()
    const users = defineTable('users', {
      id: column.id(), name: column.string(), settings: column.json<{ enabled: boolean }>(),
      active: column.boolean(), bornAt: column.timestamp(), score: column.integer(), secret: column.string(),
    })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, {
      fillable: ['name', 'settings', 'active', 'bornAt', 'score', 'secret'],
      casts: { settings: 'json', active: 'boolean', bornAt: 'date', score: 'number', secret: { get: value => `secret:${String(value)}`, set: value => String(value).toUpperCase() } },
      mutators: { name: value => String(value).trim() },
      accessors: { name: value => String(value).toUpperCase(), label: (_value, entity) => `User:${entity.toAttributes().name}` },
      hidden: ['secret'], appended: ['label'],
    })
    const date = new Date('2025-01-02T03:04:05Z')
    const user = await User.create({ name: ' Mohamed ', settings: { enabled: true }, active: true, bornAt: date, score: 10, secret: 'token' })
    expect(user.get('name')).toBe('MOHAMED')
    expect(user.get('bornAt')).toEqual(date)
    expect(user.get('active')).toBe(true)
    expect(user.toJSON()).toMatchObject({ name: 'MOHAMED', label: 'User:Mohamed', settings: { enabled: true } })
    expect(user.toJSON()).not.toHaveProperty('secret')
    const stored = await db.queryCompiled<{ name: string, secret: string, settings: string }>({ sql: 'SELECT name, secret, settings FROM users WHERE id = ?', bindings: [user.get('id')] })
    expect(stored.rows[0]).toMatchObject({ name: 'Mohamed', secret: 'TOKEN' })
    const settings = stored.rows[0]?.settings
    if (settings === undefined) throw new Error('Expected stored settings')
    expect(JSON.parse(settings)).toEqual({ enabled: true })
    const restored = await User.findOrFail(user.get('id'))
    expect(restored.get('secret')).toBe('secret:TOKEN')
    restored.set('score', 20)
    await restored.save()
    expect((await User.findOrFail(user.get('id'))).get('score')).toBe(20)
    expect(restored.setVisible(['name']).withoutAppends().toJSON()).toEqual({ name: 'MOHAMED' })
    expect(restored.makeVisible('secret').toJSON()).toEqual({ name: 'MOHAMED', secret: 'secret:TOKEN' })
    expect(restored.makeHidden('secret').append('label').toJSON()).toEqual({ name: 'MOHAMED' })
    expect(restored.makeVisible('label').toJSON()).toEqual({ name: 'MOHAMED', label: 'User:Mohamed' })
  })

  it('applies query-time date casts without changing the model definition', async () => {
    const db = await openModelDatabase()
    const users = defineTable('users', { id: column.id(), lastPostedAt: column.string() })
    await createTestTable(db, users)
    const User = defineModelFromTable(users, { fillable: ['lastPostedAt'] })
    const iso = '2025-03-04T05:06:07.000Z'
    await User.create({ lastPostedAt: iso })
    expect((await User.firstOrFail()).get('lastPostedAt')).toBe(iso)
    expect((await User.withCasts({ lastPostedAt: 'date' }).firstOrFail()).get('lastPostedAt')).toEqual(new Date(iso))
    expect(User.definition.casts.lastPostedAt).toBeUndefined()
    expect((await User.firstOrFail()).get('lastPostedAt')).toBe(iso)
  })

  it('round trips formatted dates and applies custom date serialization', async () => {
    const db = await openModelDatabase()
    const events = defineTable('events', { id: column.id(), startsAt: column.timestamp(), sentAt: column.timestamp() })
    await createTestTable(db, events)
    const Event = defineModelFromTable(events, {
      fillable: ['startsAt', 'sentAt'],
      casts: { startsAt: 'datetime:Y-m-d H:i:s', sentAt: 'timestamp:unix' },
    })
    const startsAt = new Date('2025-06-07T08:09:10.000Z')
    const sentAt = new Date('2025-06-07T08:09:11.000Z')
    const event = await Event.create({ startsAt, sentAt })
    const restored = await Event.findOrFail(event.get('id'))
    expect(restored.get('startsAt')).toEqual(startsAt)
    expect(restored.get('sentAt')).toEqual(sentAt)
    expect(restored.toJSON()).toMatchObject({ startsAt: '2025-06-07 08:09:10', sentAt: 1749283751 })
    const Custom = defineModelFromTable(events, { serializeDate: value => value.toISOString().slice(0, 10) })
    expect((await Custom.findOrFail(event.get('id'))).toJSON()).toMatchObject({ startsAt: '2025-06-07', sentAt: '2025-06-07' })
  })

  it('persists castable definitions and set-only casts with nullable scalar attributes', async () => {
    class TitleCastable {
      castUsing() {
        return {
          get: (value: unknown) => value == null ? value : `title:${String(value)}`,
          set: (value: unknown) => value == null ? value : String(value).toUpperCase(),
        }
      }
    }
    const db = await openModelDatabase()
    const records = defineTable('records', {
      id: column.id(), title: column.string(), token: column.string(),
      enabled: column.boolean().nullable(), count: column.integer().nullable(),
    })
    await createTestTable(db, records)
    const Record = defineModelFromTable(records, {
      fillable: ['title', 'token', 'enabled', 'count'],
      casts: { title: new TitleCastable(), token: { set: value => `stored:${String(value)}` }, enabled: 'boolean', count: 'number' },
    })
    const record = await Record.create({ title: 'hello', token: 'abc', enabled: null, count: null })
    expect(await db.table(records).where('id', record.get('id')).first()).toMatchObject({ title: 'HELLO', token: 'stored:abc', enabled: null, count: null })
    const restored = await Record.findOrFail(record.get('id'))
    expect(restored.toJSON()).toMatchObject({ title: 'title:HELLO', token: 'stored:abc', enabled: null, count: null })
    restored.set('count', 12)
    await restored.save()
    expect(restored.get('title')).toBe('title:HELLO')
    expect(restored.get('token')).toBe('stored:abc')
    expect((await Record.findOrFail(record.get('id'))).get('count')).toBe(12)
  })

  it('round trips nullable enum values and rejects invalid values before persistence', async () => {
    enum Status { Draft = 'draft', Published = 'published' }
    const db = await openModelDatabase()
    const posts = defineTable('posts', { id: column.id(), status: column.string().nullable() })
    await createTestTable(db, posts)
    const Post = defineModelFromTable(posts, { fillable: ['status'], casts: { status: enumCast(Status) } })
    const draft = await Post.create({ status: Status.Draft })
    expect((await Post.findOrFail(draft.get('id'))).get('status')).toBe(Status.Draft)
    const empty = await Post.create({ status: null })
    expect((await Post.findOrFail(empty.get('id'))).get('status')).toBeNull()
    await expect(Post.create({ status: 'invalid' })).rejects.toThrow()
    await db.table(posts).where('id', draft.get('id')).update({ status: 'invalid' })
    await expect(Post.findOrFail(draft.get('id'))).rejects.toThrow()
    expect(await db.table(posts).count()).toBe(2)
  })

  it('round trips value-object casts and preserves unchanged cast attributes on save', async () => {
    class Money { constructor(readonly cents: number) {} }
    class MoneyCast {
      get(value: unknown) { return value == null ? value : new Money(Number(value)) }
      set(value: unknown) { return value instanceof Money ? value.cents : Number(value) }
    }
    const db = await openModelDatabase()
    const products = defineTable('products', { id: column.id(), name: column.string(), price: column.integer() })
    await createTestTable(db, products)
    const Product = defineModelFromTable(products, { fillable: ['name', 'price'], casts: { price: new MoneyCast() } })
    const product = await Product.create({ name: 'Original', price: 2500 })
    const found = await Product.findOrFail(product.get('id'))
    expect(found.get('price')).toEqual(new Money(2500))
    found.set('name', 'Updated')
    await found.save()
    expect(found.get('price')).toEqual(new Money(2500))
    found.set('price', found.get('price'))
    expect(found.isDirty()).toBe(false)
    found.set('price', 3999)
    expect(found.isDirty()).toBe(true)
    await found.save()
    expect(found.get('price')).toEqual(new Money(3999))
    expect(await db.table(products).value('price')).toBe(3999)
  })

  it('stores encrypted ciphertext and native binary data and rejects corrupted ciphertext', async () => {
    const db = await openModelDatabase()
    const files = defineTable('files', { id: column.id(), payload: column.blob().nullable(), secret: column.string().nullable() })
    await createTestTable(db, files)
    const File = defineModelFromTable(files, { fillable: ['payload', 'secret'], casts: { payload: binaryCast(), secret: encryptedCast('test-encryption-key') } })
    const payload = new Uint8Array([1, 2, 3, 4])
    const file = await File.create({ payload, secret: 'confidential' })
    const stored = await db.table(files).where('id', file.get('id')).first()
    expect(stored?.secret).toMatch(/^enc:/)
    expect(stored?.secret).not.toContain('confidential')
    expect(Array.from(stored?.payload ?? [])).toEqual(Array.from(payload))
    const restored = await File.findOrFail(file.get('id'))
    expect(restored.get('secret')).toBe('confidential')
    expect(Array.from(restored.get('payload') ?? [])).toEqual(Array.from(payload))
    restored.set('payload', new Uint8Array(payload))
    expect(restored.isDirty()).toBe(false)
    await db.table(files).where('id', file.get('id')).update({ secret: 'enc:broken.payload' })
    await expect(File.findOrFail(file.get('id'))).rejects.toThrow('malformed payload')
    const empty = await File.create({ payload: null, secret: null })
    expect((await File.findOrFail(empty.get('id'))).toJSON()).toMatchObject({ payload: null, secret: null })
  })

  it('does not persist partial writes after a custom cast rejects an attribute', async () => {
    const db = await openModelDatabase()
    const records = defineTable('records', { id: column.id(), value: column.string() })
    await createTestTable(db, records)
    const Record = defineModelFromTable(records, { fillable: ['value'], casts: { value: {
      get: value => String(value), set() { throw new Error('invalid cast input') },
    } } })
    await expect(Record.create({ value: 'rejected' })).rejects.toThrow('invalid cast input')
    expect(await db.table(records).count()).toBe(0)
  })

  it('persists mass soft deletes without dispatching per-row lifecycle events', async () => {
    const db = await openModelDatabase()
    const users = defineTable('users', { id: column.id(), name: column.string(), deleted_at: column.timestamp().nullable() })
    await createTestTable(db, users)
    const events: string[] = []
    const User = defineModelFromTable(users, { fillable: ['name'], softDeletes: true, events: {
      deleting() { events.push('deleting') }, deleted() { events.push('deleted') }, trashed() { events.push('trashed') },
    } })
    const user = await User.create({ name: 'Preserved' })
    expect((await User.where('id', user.get('id')).delete()).affectedRows).toBe(1)
    expect(events).toEqual([])
    expect(await User.count()).toBe(0)
    const deleted = await User.withTrashed().findOrFail(user.get('id'))
    expect(deleted.get('deleted_at')).toBeInstanceOf(Date)
    expect(await db.table(users).count()).toBe(1)
    await deleted.restore()
    expect((await User.findOrFail(user.get('id'))).get('name')).toBe('Preserved')
    await deleted.forceDelete()
    expect(await db.table(users).count()).toBe(0)
  })

  it('touches persisted parent timestamps through belongs-to relations and tolerates null parents', async () => {
    const db = await openModelDatabase()
    const users = defineTable('users', { id: column.id(), name: column.string(), updated_at: column.timestamp() })
    const posts = defineTable('posts', { id: column.id(), userId: column.integer().nullable(), title: column.string() })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    const User = defineModelFromTable(users, { fillable: ['name', 'updated_at'] })
    const Post = defineModelFromTable(posts, { fillable: ['userId', 'title'], relations: { author: belongsTo(() => User, 'userId') }, touches: ['author'] })
    const previous = new Date('2020-01-01T00:00:00Z')
    const parent = await User.create({ name: 'Parent', updated_at: previous })
    const post = await Post.create({ userId: parent.get('id'), title: 'Draft' })
    const started = Date.now()
    post.set('title', 'Published')
    await post.save()
    const updated = (await User.findOrFail(parent.get('id'))).get('updated_at')
    expect(updated.getTime()).toBeGreaterThanOrEqual(started)
    expect(updated.getTime()).toBeLessThanOrEqual(Date.now())
    await Post.create({ userId: null, title: 'Orphan' })
    expect(await Post.count()).toBe(2)
  })

  it('generates and persists UUID, ULID, Snowflake, and configured unique keys without replacing explicit keys', async () => {
    const db = await openModelDatabase()
    const uuids = defineTable('uuid_users', { id: column.uuid().primaryKey(), name: column.string() })
    const ulids = defineTable('ulid_users', { id: column.ulid().primaryKey(), name: column.string() })
    const snowflakes = defineTable('snowflake_users', { id: column.snowflake().primaryKey(), name: column.string() })
    const custom = defineTable('custom_users', { id: column.string().primaryKey(), publicId: column.string().unique(), name: column.string() })
    for (const table of [uuids, ulids, snowflakes, custom]) await createTestTable(db, table)
    const Uuid = defineModelFromTable(uuids, { fillable: ['id', 'name'], traits: [HasUuids()] })
    const Ulid = defineModelFromTable(ulids, { fillable: ['name'], traits: [HasUlids()] })
    const Snowflake = defineModelFromTable(snowflakes, { fillable: ['name'], traits: [HasSnowflakes()] })
    const Custom = defineModelFromTable(custom, { fillable: ['id', 'name'], traits: [HasUniqueIds({ columns: ['publicId'] })], newUniqueId: () => 'public-id' })
    const uuid = await Uuid.create({ name: 'UUID' })
    const manual = await Uuid.create({ id: 'explicit-id', name: 'Manual' })
    const ulid = await Ulid.create({ name: 'ULID' })
    const flakes = await Promise.all([Snowflake.create({ name: 'First' }), Snowflake.create({ name: 'Second' })])
    const unique = await Custom.create({ id: 'custom-key', name: 'Custom' })
    expect(uuid.get('id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect((await Uuid.findOrFail(manual.get('id'))).get('id')).toBe('explicit-id')
    expect(ulid.get('id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect((await Ulid.findOrFail(ulid.get('id'))).get('id')).toBe(ulid.get('id'))
    expect(flakes[0]?.get('id')).not.toBe(flakes[1]?.get('id'))
    for (const flake of flakes) expect((await Snowflake.findOrFail(flake.get('id'))).get('id')).toBe(flake.get('id'))
    expect((await Custom.findOrFail(unique.get('id'))).get('publicId')).toBe('public-id')
    expect(await DB.table(custom).count()).toBe(1)
  })

  it('rejects invalid unique key generation without inserting a row', async () => {
    const db = await openModelDatabase()
    const records = defineTable('records', { id: column.uuid().primaryKey(), name: column.string() })
    await createTestTable(db, records)
    const Record = defineModelFromTable(records, { fillable: ['name'], traits: [HasUniqueIds({ generator: () => '' })] })
    await expect(Record.create({ name: 'Rejected' })).rejects.toMatchObject({ code: 'INVALID_UNIQUE_ID' })
    expect(await db.table(records).count()).toBe(0)
  })
})
