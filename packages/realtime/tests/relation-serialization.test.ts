import {
  belongsTo,
  belongsToMany,
  column,
  defineGeneratedTable,
  defineModel,
  hasMany,
  hasOne,
} from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { executeRealtimeMutation, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

type RealtimeTestDatabase = Awaited<ReturnType<typeof openRealtimeDatabase>>

const authorsTable = () => defineGeneratedTable('authors', {
  id: column.id(),
  name: column.string(),
  password: column.string(),
})

const authorModels = [
  ['hides', () => defineModel(authorsTable(), { timestamps: false, hidden: ['password'] })],
  ['limits', () => defineModel(authorsTable(), { timestamps: false, visible: ['id', 'name'] })],
  ['casts', () => defineModel(authorsTable(), {
    timestamps: false,
    casts: { name: { get: value => `cast:${String(value)}` } },
  })],
  ['accessors', () => defineModel(authorsTable(), {
    timestamps: false,
    accessors: { name: value => String(value).toUpperCase() },
  })],
  ['appends', () => defineModel(authorsTable(), {
    timestamps: false,
    appended: ['label'],
    accessors: { label: (_value, entity) => `Author:${entity.toAttributes().name}` },
  })],
] as const

async function seedAuthorsAndPosts({ adapter }: RealtimeTestDatabase) {
  await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER)')
  await adapter.execute("INSERT INTO authors VALUES (1, 'Ada', 'ada-secret'), (2, 'Grace', 'grace-secret')")
  await adapter.execute("INSERT INTO posts VALUES (1, 'Initial', 1)")
}

describe('realtime relation serialization', () => {
  it.each(authorModels)('refreshes belongs-to relations whose related model %s attributes', async (_, createAuthor) => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = createAuthor()
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    const handler = () => db.model(Post).query().with('author').orderBy('id').getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })
    const verify = async () => {
      expect(snapshots.at(-1)).toEqual(await handler())
      expect(patches).toEqual([])
    }
    const mutations = [
      { change: () => db.table('posts').insert([
        { id: 2, title: 'Shared', author_id: 1 },
        { id: 3, title: 'Other', author_id: 2 },
      ]), refreshes: true },
      { change: () => db.table('authors').where('id', 1).update({ name: 'Updated Ada' }), refreshes: true },
      { change: () => db.table('authors').where('id', 2).update({ password: 'grace-rotated-secret' }), refreshes: true },
      { change: () => db.table('authors').insert({ id: 3, name: 'Linus', password: 'linus-secret' }), refreshes: false },
      { change: () => db.table('posts').where('id', 3).update({ author_id: 3 }), refreshes: true },
    ]

    await verify()
    for (const [index, { change, refreshes }] of mutations.entries()) {
      const readsBefore = reads
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
      expect(reads - readsBefore, `mutation ${index} reruns`).toBe(refreshes ? 1 : 0)
    }
  })

  it('refreshes has-many relations whose related model hides attributes', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    await context.adapter.execute('ALTER TABLE posts ADD COLUMN body TEXT')
    await context.adapter.execute("UPDATE posts SET body = 'body-secret' WHERE id = 1")
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), { timestamps: false, hidden: ['body'] })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: { posts: hasMany(() => Post, 'author_id') },
    })
    const handler = () => db.model(Author).query().with('posts').orderBy('id').getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })
    const verify = async () => {
      expect(snapshots.at(-1)).toEqual(await handler())
      expect(patches).toEqual([])
    }
    const mutations = [
      () => db.table('posts').insert({ id: 2, title: 'Second', author_id: 1, body: 'second-body' }),
      () => db.table('posts').where('id', 1).update({ title: 'Changed' }),
    ]

    await verify()
    for (const [index, change] of mutations.entries()) {
      const readsBefore = reads
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      await verify()
      expect(reads, `mutation ${index} should refresh`).toBe(readsBefore + 1)
    }
  })

  it('refreshes has-one relations whose related model hides attributes', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('CREATE TABLE profiles (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, bio TEXT NOT NULL, note TEXT NOT NULL)')
    await adapter.execute("INSERT INTO profiles VALUES (1, 1, 'Bio one', 'note-secret')")
    const Profile = defineModel(defineGeneratedTable('profiles', {
      id: column.id(),
      author_id: column.integer(),
      bio: column.string(),
      note: column.string(),
    }), { timestamps: false, hidden: ['note'] })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: { profile: hasOne(() => Profile, 'author_id') },
    })
    const handler = () => db.model(Author).query().with('profile').orderBy('id').getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })
    const mutations = [
      () => db.table('profiles').insert({ id: 2, author_id: 2, bio: 'Bio two', note: 'note-secret-two' }),
      () => db.table('profiles').where('id', 1).update({ bio: 'Changed bio' }),
    ]

    expect(snapshots.at(-1)).toEqual(await handler())
    for (const change of mutations) {
      const readsBefore = reads
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      expect(snapshots.at(-1)).toEqual(await handler())
      expect(patches).toEqual([])
      expect(reads - readsBefore).toBe(1)
    }
  })

  it('refreshes belongs-to-many relations whose related model hides attributes', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL, internal TEXT NOT NULL)')
    await adapter.execute('CREATE TABLE author_tags (author_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 'news', 'tag-secret'), (2, 'tech', 'tech-secret')")
    await adapter.execute('INSERT INTO author_tags VALUES (1, 1)')
    const Tag = defineModel(defineGeneratedTable('tags', {
      id: column.id(),
      label: column.string(),
      internal: column.string(),
    }), { timestamps: false, hidden: ['internal'] })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: { tags: belongsToMany(() => Tag, 'author_tags', 'author_id', 'tag_id') },
    })
    const handler = () => db.model(Author).query().with('tags').orderBy('id').getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })
    const mutations = [
      () => db.table('author_tags').insert({ author_id: 1, tag_id: 2 }),
      () => db.table('tags').where('id', 1).update({ label: 'Changed news' }),
    ]

    expect(snapshots.at(-1)).toEqual(await handler())
    for (const change of mutations) {
      const readsBefore = reads
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: change }))
      expect(snapshots.at(-1)).toEqual(await handler())
      expect(patches).toEqual([])
      expect(reads - readsBefore).toBe(1)
    }
  })

  it('refreshes offset-windowed has-many relations whose related model hides attributes', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('ALTER TABLE posts ADD COLUMN body TEXT')
    await adapter.execute("UPDATE posts SET body = 'body-one' WHERE id = 1")
    await adapter.execute("INSERT INTO posts VALUES (2, 'Second', 1, 'body-two'), (4, 'Fourth', 2, 'body-four')")
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), { timestamps: false, hidden: ['body'] })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: { posts: hasMany(() => Post, 'author_id') },
    })
    const handler = () => db.model(Author).query()
      .with({ posts: query => query.orderBy('id').offset(1).limit(1) })
      .orderBy('id')
      .getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').insert({ id: 0, title: 'Zeroth', author_id: 1, body: 'body-zero' }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
    expect(JSON.stringify([snapshots, patches])).not.toContain('body')
  })

  it('refreshes a hidden belongs-to relation when a plain relation shares its foreign key', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Plain = defineModel(authorsTable(), { timestamps: false })
    const Hidden = defineModel(authorsTable(), { timestamps: false, hidden: ['password'] })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: {
        plain: belongsTo(() => Plain, 'author_id'),
        hidden: belongsTo(() => Hidden, 'author_id'),
      },
    })
    const handler = () => db.model(Post).query().with('plain', 'hidden').orderBy('id').getJson()
    const snapshots: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ author_id: 2 }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
    expect(reads).toBe(2)
  })

  it('refreshes a hidden belongs-to relation when a plain has-many on the same row changes its foreign key', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('ALTER TABLE posts ADD COLUMN parent_id INTEGER')
    await adapter.execute('INSERT INTO posts VALUES (2, \'Child\', 1, 1)')
    const Hidden = defineModel(authorsTable(), { timestamps: false, hidden: ['password'] })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
      parent_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: {
        hidden: belongsTo(() => Hidden, 'author_id'),
        children: hasMany(() => Post, 'parent_id'),
      },
    })
    const handler = () => db.model(Post).query().with('hidden', 'children').orderBy('id').getJson()
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 'in', [1, 2]).update({ author_id: 2 }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a hidden belongs-to relation when the handler also reads the foreign key directly', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = defineModel(authorsTable(), { timestamps: false, hidden: ['password'] })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    const handler = async () => {
      await db.table('posts').where('id', 1).first()
      return db.model(Post).query().where('id', 1).with('author').firstJson()
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

    expect(snapshots.at(-1)).toEqual(await handler())
  })

  it('refreshes a serialized root model when a discarded raw read covers its columns', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      hidden: ['password'],
      appended: ['label'],
      accessors: { label: (_value, entity) => `Author:${entity.toAttributes().name}` },
    })
    const handler = async () => {
      await db.table('authors').where('id', 1).first()
      return db.model(Author).query().where('id', 1).firstJson()
    }
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('authors').where('id', 1).update({ name: 'Grace', password: 'rotated-secret' }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
    expect(JSON.stringify(snapshots)).not.toContain('rotated-secret')
  })

  it('refreshes belongs-to-many relations whose pivot model hides a pivot column', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
    await adapter.execute('CREATE TABLE author_tags (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, note TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 'news'), (2, 'tech')")
    await adapter.execute("INSERT INTO author_tags (author_id, tag_id, note) VALUES (1, 1, 'pivot-note-one')")
    const Tag = defineModel(defineGeneratedTable('tags', { id: column.id(), label: column.string() }), { timestamps: false })
    const AuthorTag = defineModel(defineGeneratedTable('author_tags', {
      id: column.id(),
      author_id: column.integer(),
      tag_id: column.integer(),
      note: column.string(),
    }), { timestamps: false, hidden: ['note'] })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: {
        tags: belongsToMany(() => Tag, 'author_tags', 'author_id', 'tag_id')
          .withPivot('note')
          .using(() => AuthorTag),
      },
    })
    const handler = () => db.model(Author).query().with('tags').orderBy('id').getJson()
    const snapshots: unknown[] = []
    const patches: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('author_tags').where('id', 1).update({ note: 'pivot-note-updated' }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
    expect(JSON.stringify([snapshots, patches])).not.toContain('pivot-note')
    expect(reads).toBe(2)
  })

  it('keeps belongs-to-many patching for a plain pivot model with one handler run', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
    await adapter.execute('CREATE TABLE author_tags (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, note TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 'news'), (2, 'tech')")
    await adapter.execute("INSERT INTO author_tags (author_id, tag_id, note) VALUES (1, 1, 'pivot-note-one')")
    const Tag = defineModel(defineGeneratedTable('tags', { id: column.id(), label: column.string() }), { timestamps: false })
    const AuthorTag = defineModel(defineGeneratedTable('author_tags', {
      id: column.id(),
      author_id: column.integer(),
      tag_id: column.integer(),
      note: column.string(),
    }), { timestamps: false })
    const Author = defineModel(authorsTable(), {
      timestamps: false,
      relations: {
        tags: belongsToMany(() => Tag, 'author_tags', 'author_id', 'tag_id')
          .withPivot('note')
          .using(() => AuthorTag),
      },
    })
    let reads = 0
    const patches: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return db.model(Author).query().with('tags').orderBy('id').getJson()
      },
    }), {}, {
      onData: () => {},
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('author_tags').where('id', 1).update({ note: 'pivot-note-updated' }),
    }))

    expect(reads).toBe(1)
    expect(JSON.stringify(patches)).toContain('pivot-note-updated')
  })

  it('keeps plain belongs-to patching when a belongs-to-many relation is loaded alongside it', async () => {
    const context = await openRealtimeDatabase()
    const { db, adapter } = context
    await seedAuthorsAndPosts(context)
    await adapter.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
    await adapter.execute('CREATE TABLE post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 'news'), (2, 'tech')")
    await adapter.execute('INSERT INTO post_tags VALUES (1, 1), (1, 2)')
    const Author = defineModel(authorsTable(), { timestamps: false })
    const Tag = defineModel(defineGeneratedTable('tags', { id: column.id(), label: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: {
        author: belongsTo(() => Author, 'author_id'),
        tags: belongsToMany(() => Tag, 'post_tags', 'post_id', 'tag_id'),
      },
    })
    const handler = () => db.model(Post).query().with('author', 'tags').orderBy('id').getJson()
    const snapshots: unknown[] = []
    let reads = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return handler()
      },
    }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('posts').where('id', 1).update({ author_id: 2 }),
    }))

    expect(snapshots.at(-1)).toEqual(await handler())
    expect(reads).toBe(1)
  })

  it('keeps belongs-to patching for plain related models with one handler run', async () => {
    const context = await openRealtimeDatabase()
    const { db } = context
    await seedAuthorsAndPosts(context)
    const Author = defineModel(authorsTable(), { timestamps: false })
    const Post = defineModel(defineGeneratedTable('posts', {
      id: column.id(),
      title: column.string(),
      author_id: column.integer().nullable(),
    }), {
      timestamps: false,
      relations: { author: belongsTo(() => Author, 'author_id') },
    })
    let reads = 0
    const patches: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: () => {
        reads += 1
        return db.model(Post).query().with('author').orderBy('id').getJson()
      },
    }), {}, {
      onData: () => {},
      onPatch: patch => { patches.push(patch) },
      onError: error => { throw error },
    })

    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table('authors').where('id', 1).update({ name: 'Updated Ada' }),
    }))

    expect(reads).toBe(1)
    expect(JSON.stringify(patches)).toContain('Updated Ada')
  })
})
