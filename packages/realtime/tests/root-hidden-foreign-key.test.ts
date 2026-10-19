import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

type RealtimeDatabase = Awaited<ReturnType<typeof openRealtimeDatabase>>['db']

async function seedAuthorsAndPosts({ adapter }: Awaited<ReturnType<typeof openRealtimeDatabase>>) {
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
})
