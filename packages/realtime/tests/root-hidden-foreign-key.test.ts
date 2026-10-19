import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

type RealtimeContext = Awaited<ReturnType<typeof openRealtimeDatabase>>
type RealtimeDatabase = RealtimeContext['db']

async function seedAuthorsAndPosts({ adapter }: RealtimeContext) {
  await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER)')
  await adapter.execute("INSERT INTO authors VALUES (1, 'Ada'), (2, 'Grace')")
  await adapter.execute("INSERT INTO posts VALUES (1, 'Initial', 1)")
}

describe('realtime hidden root foreign keys', () => {
  it.each(Object.entries({
    update: (db: RealtimeDatabase) => db.table('posts').where('id', 1).update({ author_id: 2 }),
    insert: (db: RealtimeDatabase) => db.table('posts').insert({ id: 2, title: 'New', author_id: 2 }),
  }))('refreshes instead of patching a hidden root foreign key on %s', async (_, change) => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = defineModel(defineGeneratedTable('authors', { id: column.id(), name: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      hidden: ['author_id'],
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    let reads = 0
    const handler = () => {
      reads += 1
      return db.model(Post).query().with('author').orderBy('id').getJson()
    }
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => change(db),
    }))

    expect(reads).toBe(2)
    expect(JSON.stringify(patches)).not.toContain('author_id')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('author_id')
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('keeps incremental patching for a plain root whose constrained belongs-to is loaded', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = defineModel(defineGeneratedTable('authors', { id: column.id(), name: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    let reads = 0
    const handler = () => {
      reads += 1
      return db.model(Post).query().with({ author: query => query.where('id', 'in', [1, 2]) }).orderBy('id').getJson()
    }
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ author_id: 2 }),
    }))

    expect(reads).toBe(1)
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a hidden root foreign key in an offset window instead of patching it', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    await db.table('posts').insert([{ id: 2, title: 'Second', author_id: 2 }, { id: 3, title: 'Third', author_id: 2 }])
    const Author = defineModel(defineGeneratedTable('authors', { id: column.id(), name: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      hidden: ['author_id'],
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    let reads = 0
    const handler = () => {
      reads += 1
      return db.model(Post).query().with('author').orderBy('id').offset(1).limit(1).getJson()
    }
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 2).update({ author_id: 1 }),
    }))

    expect(reads).toBe(2)
    expect(JSON.stringify(patches)).not.toContain('author_id')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('author_id')
    expect(snapshots.at(-1)).toEqual(await handler())
  })
})
