import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery, type RealtimeSubscribeOptions } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

type RealtimeContext = Awaited<ReturnType<typeof openRealtimeDatabase>>

async function seedAuthorsAndPosts({ adapter }: RealtimeContext) {
  await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER)')
  await adapter.execute("INSERT INTO authors VALUES (1, 'Ada'), (2, 'Grace')")
  await adapter.execute("INSERT INTO posts VALUES (1, 'Initial', 1)")
}

describe('realtime per-instance serialization overrides', () => {
  it.each([
    ['makeHidden', (posts: { makeHidden: (...keys: string[]) => unknown }) => posts.makeHidden('author_id')],
    ['setVisible', (posts: { setVisible: (keys: string[]) => unknown }) => posts.setVisible(['id', 'title', 'author'])],
  ])('refreshes instead of patching a raw foreign key after %s in the handler', async (_, override) => {
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
    const handler = async () => {
      reads += 1
      const posts = await db.model(Post).query().with('author').orderBy('id').get()
      override(posts)
      return posts.toJSON()
    }
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> & { readonly onPatch?: (patch: unknown) => void } = {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: (patch: unknown) => { patches.push(patch) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ author_id: 2 }),
    }))

    expect(reads).toBe(2)
    expect(JSON.stringify(patches)).not.toContain('author_id')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('author_id')
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('keeps incremental patching when the handler applies no override', async () => {
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
    const handler = async () => {
      reads += 1
      const posts = await db.model(Post).query().with('author').orderBy('id').get()
      return posts.toJSON()
    }
    const snapshots: unknown[] = []
    const options: RealtimeSubscribeOptions<unknown> & { readonly onPatch?: (patch: unknown) => void } = {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, options)

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ author_id: 2 }),
    }))

    expect(reads).toBe(1)
    expect(snapshots.at(-1)).toEqual(await handler())
  })
})
