import { column, defineGeneratedTable, defineModel, hasMany } from '@holo-js/db'
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

function definePosts(hidden: readonly string[] = []) {
  const Comment = defineModel(defineGeneratedTable('comments', {
    id: column.id(),
    post_id: column.integer(),
    body: column.string(),
  }), { timestamps: false })
  return defineModel(defineGeneratedTable('posts', {
    id: column.id(),
    title: column.string(),
  }), {
    timestamps: false,
    hidden: [...hidden],
    relations: { comments: hasMany(() => Comment, 'post_id') },
  })
}

describe('realtime relation aggregate serialization', () => {
  it.each([
    ['makeHidden', (posts: { makeHidden: (...keys: string[]) => unknown }) => posts.makeHidden('comments_exists')],
    ['setVisible', (posts: { setVisible: (keys: string[]) => unknown }) => posts.setVisible(['id'])],
  ])('refreshes withExists after %s on the handler records, then a related insert', async (_, override) => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Post = definePosts()
    let reads = 0
    const handler = async () => {
      reads += 1
      const posts = await db.model(Post).query().withExists('comments').orderBy('id').get()
      override(posts)
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
      handler: () => db.table('comments').insert({ id: 2, post_id: 2, body: 'New' }),
    }))

    expect(reads).toBe(2)
    expect(JSON.stringify(patches)).not.toContain('comments_exists')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('comments_exists')
    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a withCount attribute that the root model hides, then a related insert', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedPostsAndComments(context)
    const Post = definePosts(['comments_count'])
    let reads = 0
    const handler = () => {
      reads += 1
      return db.model(Post).query().withCount('comments').orderBy('id').getJson()
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
      handler: () => db.table('comments').insert({ id: 2, post_id: 1, body: 'New' }),
    }))

    expect(reads).toBe(2)
    expect(JSON.stringify(patches)).not.toContain('comments_count')
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('comments_count')
    expect(snapshots.at(-1)).toEqual(await handler())
  })
})
