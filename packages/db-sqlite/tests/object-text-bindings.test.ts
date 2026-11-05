import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SerializationError,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSchemaService,
  defineGeneratedTable,
  defineModel,
  resetDB,
} from '@holo-js/db'
import { createSQLiteAdapter } from '../src'

const fix = 'Add a \'json\' cast for it or JSON.stringify the value.'
const objectMessage = `Cannot write an object to column "meta" on SQLite. ${fix}`
const arrayMessage = `Cannot write an array to column "meta" on SQLite. ${fix}`
const convert = 'Convert it to a string, number, bigint, Buffer or null first.'
const compareObjectMessage = 'Cannot compare column "meta" to an object on SQLite. Use whereJsonContains() for JSON, or JSON.stringify the value.'
const compareArrayMessage = 'Cannot compare column "meta" to an array on SQLite. Use whereIn() for a list of values.'

class Money {
  constructor(readonly cents: number) {}
}

describe('SQLite writes of objects into a column without a json cast', () => {
  let directory: string
  let database: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-object-text-'))
    const adapter = createSQLiteAdapter({ filename: join(directory, 'database.sqlite') })
    await adapter.ensureDatabaseExists()
    database = createDatabase({ adapter, dialect: createDialect('sqlite') })
    await createSchemaService(database).createTable('posts', table => {
      table.integer('id').primaryKey()
      table.text('meta').nullable()
      table.json('settings').nullable()
      table.blob('payload').nullable()
      table.integer('stamp').nullable()
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: database, app: database } }))
  })

  afterEach(async () => {
    resetDB()
    await database.disconnect()
    await rm(directory, { recursive: true, force: true })
  })

  it('names the column and the fix when a query writes an object or array to a text column', async () => {
    const posts = database.table('posts')

    await expect(posts.insert({ id: 1, meta: { theme: 'dark' } })).rejects.toThrow(new SerializationError(objectMessage))
    await expect(posts.insert({ id: 1, meta: ['dark'] })).rejects.toThrow(new SerializationError(arrayMessage))
    await expect(posts.upsert([{ id: 1, meta: { theme: 'dark' } }], ['id'], ['meta'])).rejects.toThrow(new SerializationError(objectMessage))
    await posts.insert({ id: 1, meta: 'plain' })
    await expect(posts.where('id', 1).update({ meta: { theme: 'dark' } })).rejects.toThrow(new SerializationError(objectMessage))
    await expect(posts.where('id', 1).update({ meta: ['dark'] })).rejects.toThrow(new SerializationError(arrayMessage))
    expect(await posts.get()).toEqual([{ id: 1, meta: 'plain', settings: null, payload: null, stamp: null }])
  })

  const definedPosts = () => database.table(defineGeneratedTable('posts', {
    id: column.integer().primaryKey(),
    meta: column.text().nullable(),
    settings: column.json().nullable(),
    payload: column.blob().nullable(),
    stamp: column.integer().nullable(),
  }))

  it('names the column when the table definition declares a text column', async () => {
    const posts = definedPosts()

    await expect(posts.insert({ id: 1, meta: { theme: 'dark' } as never })).rejects.toThrow(new SerializationError(objectMessage))
    await posts.insert({ id: 1, settings: { theme: 'dark' }, payload: new Uint8Array([1, 2]) })
    expect(await posts.value('settings')).toBe('{"theme":"dark"}')
  })

  it('keeps writing dates and typed arrays to defined columns that are not text', async () => {
    const posts = definedPosts()

    await posts.insert({ id: 2, stamp: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) as never, payload: new Float32Array([1.5]) as never })
    expect(await posts.where('id', 2).value('stamp')).toBe('2026-01-02 03:04:05')
    expect(await posts.where('id', 2).value('payload')).toEqual(Buffer.from(new Float32Array([1.5]).buffer))
  })

  it('names the column when a model without a json cast saves an object', async () => {
    const Post = defineModel('posts', { connectionName: 'app', fillable: ['id', 'meta', 'settings'], timestamps: false })
    const CastPost = defineModel('posts', { connectionName: 'app', fillable: ['id', 'meta'], casts: { meta: 'json' }, timestamps: false })

    await expect(Post.create({ id: 1, meta: { theme: 'dark' } })).rejects.toThrow(new SerializationError(objectMessage))
    await CastPost.create({ id: 2, meta: { theme: 'dark' } })
    expect((await CastPost.findOrFail(2)).get('meta')).toEqual({ theme: 'dark' })
    expect(await database.table('posts').where('id', 2).value('meta')).toBe('{"theme":"dark"}')
  })

  it('keeps writing typed arrays without a schema', async () => {
    const posts = database.table('posts')

    await posts.insert({ id: 3, payload: new Float32Array([2.5]) })
    expect(await posts.where('id', 3).value('payload')).toEqual(Buffer.from(new Float32Array([2.5]).buffer))
  })

  it('keeps binary, null and scalar writes working without a schema', async () => {
    const posts = database.table('posts')

    await posts.insert({ id: 1, meta: null, payload: Buffer.from([7]) })
    await posts.insert({ id: 2, meta: 'text', settings: '{"a":1}', payload: new Uint8Array([8]) })

    expect(await posts.orderBy('id').get()).toEqual([
      { id: 1, meta: null, settings: null, payload: Buffer.from([7]), stamp: null },
      { id: 2, meta: 'text', settings: '{"a":1}', payload: Buffer.from([8]), stamp: null },
    ])
  })

  it('names the column when a write binds a value the driver cannot bind', async () => {
    const posts = database.table('posts')
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['Map', new Map([['a', 1]])],
      ['Set', new Set([1])],
      ['Money', new Money(5)],
      ['DataView', new DataView(new ArrayBuffer(2))],
      ['ArrayBuffer', new ArrayBuffer(2)],
    ]

    for (const [type, value] of cases) {
      await expect(posts.insert({ id: 1, meta: value })).rejects.toThrow(new SerializationError(`Cannot write a value of type ${type} to column "meta" on SQLite. ${convert}`))
    }
    await posts.insert({ id: 1, meta: 'plain', stamp: 1 })
    await expect(posts.where('id', 1).update({ meta: new Money(5) })).rejects.toThrow(new SerializationError(`Cannot write a value of type Money to column "meta" on SQLite. ${convert}`))
    await posts.where('id', 1).increment('stamp', 2, { meta: new Date(Date.UTC(2026, 0, 2)) })
    expect(await posts.get()).toEqual([{ id: 1, meta: '2026-01-02 00:00:00', settings: null, payload: null, stamp: 3 }])
  })

  it('names the column when a predicate compares it to an object, array or unbindable value', async () => {
    const posts = database.table('posts')
    await posts.insert({ id: 1, meta: 'plain', payload: Buffer.from([1]) })

    expect(() => posts.where('meta', { theme: 'dark' } as never)).toThrow(new SerializationError(compareObjectMessage))
    expect(() => posts.where('meta', '!=', { theme: 'dark' } as never)).toThrow(new SerializationError(compareObjectMessage))
    expect(() => posts.where('meta', ['plain'] as never)).toThrow(new SerializationError(compareArrayMessage))
    expect(() => posts.whereIn('meta', [{ theme: 'dark' }])).toThrow(new SerializationError(compareObjectMessage))
    expect(() => posts.whereBetween('meta', [['a'], 'z'])).toThrow(new SerializationError(compareArrayMessage))
    expect(() => posts.where('meta', new Map() as never)).toThrow(new SerializationError(`Cannot compare column "meta" to a value of type Map on SQLite. ${convert}`))
    expect(() => posts.whereValueBetween({ a: 1 }, ['meta', 'meta'])).toThrow(new SerializationError(compareObjectMessage))

    expect(await posts.where('meta', 'plain').pluck('id')).toEqual([1])
    expect(await posts.whereIn('meta', ['plain', 'other']).pluck('id')).toEqual([1])
    expect(await posts.where('payload', Buffer.from([1])).pluck('id')).toEqual([1])
    expect(await posts.where('meta', '<', new Date(Date.UTC(2026, 0, 1))).pluck('id')).toEqual([])
  })
})
