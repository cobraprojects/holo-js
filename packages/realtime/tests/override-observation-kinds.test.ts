import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery, type RealtimeSubscribeOptions } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

type RealtimeContext = Awaited<ReturnType<typeof openRealtimeDatabase>>

async function seedPostsAndComments({ adapter }: RealtimeContext) {
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, body TEXT NOT NULL)')
  await adapter.execute("INSERT INTO posts VALUES (1, 'First'), (2, 'Second')")
  await adapter.execute("INSERT INTO comments VALUES (1, 1, 'Hello')")
}

describe('realtime serialization overrides mark every observation kind in the run', () => {
  it('refreshes a table count after a collection override in the same run', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Comment = defineModel(defineGeneratedTable('comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.string(),
    }), { timestamps: false })
    let reads = 0
    const handler = async () => {
      reads += 1
      const comments = await db.model(Comment).query().orderBy('id').get()
      comments.makeHidden('body')
      const total = await db.table('comments').count()
      return { total, comments: comments.toJSON() }
    }
    const snapshots: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> = {
      onData: (snapshot: { data: unknown }) => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('comments').insert({ id: 2, post_id: 2, body: 'New' }),
    }))

    expect(reads).toBe(2)
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a pluck on another table after a collection override in the same run', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Comment = defineModel(defineGeneratedTable('comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.string(),
    }), { timestamps: false })
    let reads = 0
    const handler = async () => {
      reads += 1
      const comments = await db.model(Comment).query().orderBy('id').get()
      comments.makeHidden('body')
      const titles = await db.table('posts').orderBy('id').pluck('title')
      return { titles, comments: comments.toJSON() }
    }
    const snapshots: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> = {
      onData: (snapshot: { data: unknown }) => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 2).update({ title: 'Renamed' }),
    }))

    expect(reads).toBe(2)
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a first() record after an entity override, then a write to its column', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
    }), { timestamps: false })
    let reads = 0
    const handler = async () => {
      reads += 1
      const post = await db.model(Post).query().where('id', 1).first()
      post?.makeHidden('title')
      return post?.toJSON() ?? null
    }
    const snapshots: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> = {
      onData: (snapshot: { data: unknown }) => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ title: 'Renamed' }),
    }))

    expect(reads).toBe(2)
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a value() scalar after a collection override in the same run', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Comment = defineModel(defineGeneratedTable('comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.string(),
    }), { timestamps: false })
    let reads = 0
    const handler = async () => {
      reads += 1
      const comments = await db.model(Comment).query().orderBy('id').get()
      comments.makeHidden('body')
      const title = await db.table('posts').where('id', 2).value('title')
      return { title, comments: comments.toJSON() }
    }
    const snapshots: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> = {
      onData: (snapshot: { data: unknown }) => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 2).update({ title: 'Renamed' }),
    }))

    expect(reads).toBe(2)
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('keeps a loaded belongs-to relation hidden after an override on the related records', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedPostsAndComments(context)
    await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO authors VALUES (1, 'Ada')")
    await adapter.execute('ALTER TABLE posts ADD COLUMN author_id INTEGER')
    await adapter.execute('UPDATE posts SET author_id = 1')
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
    const handler = async () => {
      reads += 1
      const posts = await db.model(Post).query().with('author').orderBy('id').get()
      posts[0]?.author?.makeHidden('name')
      return posts.toJSON()
    }
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> & { readonly onPatch?: (patch: unknown) => void } = {
      onData: (snapshot: { data: unknown }) => { snapshots.push(snapshot.data) },
      onPatch: (patch: unknown) => { patches.push(patch) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('authors').where('id', 1).update({ name: 'Renamed' }),
    }))

    expect(JSON.stringify(patches)).not.toContain('Renamed')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('Renamed')
    expect(snapshots.at(-1)).toEqual(await handler())
  })
})
