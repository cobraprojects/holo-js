import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

describe('native belongs-to subscription hydration', () => {
  it.each([false, true])('keeps related rows current with projection %s and batches shared parents', async (projected) => {
    const { adapter, db, queries } = await openRealtimeDatabase()
    await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER)')
    await adapter.execute("INSERT INTO authors VALUES (1, 'Ada'), (2, 'Grace')")
    await adapter.execute("INSERT INTO posts VALUES (1, 'Initial', 1)")
    const Author = defineModel(defineGeneratedTable('authors', { id: column.id(), name: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', { id: column.id(), title: column.string(), author_id: column.integer().nullable() }), {
      timestamps: false, relations: { author: belongsTo(() => Author, 'author_id') },
    })
    let reads = 0
    const handler = () => {
      reads += 1
      const builder = db.model(Post).query().with('author').orderBy('id')
      return (projected ? builder.select('id', 'title', 'author_id') : builder).getJson()
    }
    const snapshots: Awaited<ReturnType<typeof handler>>[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error },
    })
    const verify = async () => {
      const rows = await adapter.query<{ id: number, title: string, author_id: number | null, related_id: number | null, name: string | null }>(
        'SELECT posts.id, posts.title, posts.author_id, authors.id AS related_id, authors.name FROM posts LEFT JOIN authors ON posts.author_id = authors.id ORDER BY posts.id',
      )
      expect(snapshots.at(-1)).toEqual(rows.rows.map(row => ({
        id: row.id, title: row.title, author_id: row.author_id,
        author: row.related_id === null ? null : { id: row.related_id, name: row.name },
      })))
    }
    await verify()
    const beforeInsert = queries.length
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('posts').insert([
      { id: 2, title: 'Shared', author_id: 1 }, { id: 3, title: 'Other', author_id: 2 },
      { id: 4, title: 'Missing', author_id: 99 }, { id: 5, title: 'Nullable', author_id: null },
    ]) }))
    await verify()
    expect(queries.slice(beforeInsert).filter(query => query.sql.includes('FROM "authors"'))).toHaveLength(1)
    for (const change of [
      () => db.table('authors').where('id', 1).update({ name: 'Updated Ada' }),
      () => db.table('posts').where('id', 2).update({ author_id: 2 }),
      () => db.table('authors').where('id', 2).delete(),
      () => db.table('authors').insert({ id: 99, name: 'New Parent' }),
      () => db.table('posts').where('id', 1).update({ title: 'Changed' }),
      () => db.table('posts').where('id', 3).update({ author_id: null }),
    ]) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
    }
    expect(reads).toBe(1)
  })
})
