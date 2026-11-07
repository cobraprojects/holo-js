import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres'] as const)

type Driver = typeof drivers[number]

async function openQualifiedDatabase(driver: Driver) {
  const statements: string[] = []
  const { db, schema } = await openDatabase(driver, {
    security: { debugSqlInLogs: true },
    logger: { onQuerySuccess: (entry) => { if (entry.sql) statements.push(entry.sql) } },
  })
  const namespace = driver === 'sqlite' ? 'archive' : `holo_live_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  if (driver === 'sqlite') {
    await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
  } else {
    await db.executeCompiled({ sql: `CREATE SCHEMA "${namespace}"`, source: 'schema' })
    onTestFinished(async () => {
      await db.executeCompiled({ sql: `DROP SCHEMA "${namespace}" CASCADE`, source: 'schema' })
    })
  }
  onTestFinished(() => resetRealtimeRuntime())
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, schema, namespace, statements }
}

describe.each(drivers)('realtime on schema-qualified tables on %s', (driver) => {
  it.each([
    ['unqualified', (_table: string, column: string) => column],
    ['table-qualified', (table: string, column: string) => `${table.slice(table.indexOf('.') + 1)}.${column}`],
    ['schema-qualified', (table: string, column: string) => `${table}.${column}`],
  ] as const)('backfills offset windows of grouped subscriptions from a schema-qualified table with %s columns', async (_label, qualify) => {
    const { db, schema, namespace, statements } = await openQualifiedDatabase(driver)
    const tableName = `${namespace}.records`
    await schema.createTable(tableName, (table) => {
      table.integer('id').primaryKey()
      table.integer('group_id')
      table.integer('score')
    })
    const records = defineGeneratedTable(tableName, { id: column.integer().primaryKey(), group_id: column.integer(), score: column.integer() })
    await db.table(records).insert([
      { id: 1, group_id: 1, score: 10 },
      { id: 2, group_id: 2, score: 20 },
      { id: 3, group_id: 1, score: 30 },
      { id: 4, group_id: 2, score: 40 },
      { id: 5, group_id: 1, score: 50 },
      { id: 6, group_id: 2, score: 60 },
      { id: 7, group_id: 1, score: 70 },
      { id: 8, group_id: 2, score: 80 },
    ])
    const read = (group: number) => db.table(tableName).where(qualify(tableName, 'group_id'), group).select(qualify(tableName, 'id'), qualify(tableName, 'score')).orderBy(qualify(tableName, 'id')).offset(1).limit(2).get()
    let reads = 0
    const subscriptions = await Promise.all([1, 2].map(group => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => {
        reads += 1
        return read(group)
      } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(records).whereIn('id', [3, 4]).delete() }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual([
      [{ id: 5, score: 50 }, { id: 7, score: 70 }],
      [{ id: 6, score: 60 }, { id: 8, score: 80 }],
    ])
    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all([read(1), read(2)]))
    expect(reads).toBe(2)
    expect(statements.some(sql => sql.includes('ROW_NUMBER() OVER') && sql.includes(`FROM "${namespace}"."records"`))).toBe(true)
  })

  it.each([
    ['unqualified', (_table: string, column: string) => column],
    ['table-qualified', (table: string, column: string) => `${table.slice(table.indexOf('.') + 1)}.${column}`],
    ['schema-qualified', (table: string, column: string) => `${table}.${column}`],
  ] as const)('hydrates the ordered has-one relation of inserted rows from a schema-qualified table with %s columns', async (_label, qualify) => {
    const { db, schema, namespace, statements } = await openQualifiedDatabase(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const postsName = `holo_live_posts_${suffix}`
    const postsTable = `${namespace}.${postsName}`
    const authorsTable = `holo_live_authors_${suffix}`
    await schema.createTable(authorsTable, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    onTestFinished(() => schema.dropTable(authorsTable))
    await schema.createTable(postsTable, (table) => {
      table.integer('id').primaryKey()
      table.integer('author_id')
      table.integer('score')
    })
    const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer() }), { timestamps: false })
    const Author = defineModel(defineGeneratedTable(authorsTable, { id: column.integer().primaryKey(), name: column.string() }), {
      timestamps: false,
      relations: { topPost: hasOne(() => Post, 'author_id') },
    })
    await db.table(postsTable).insert([
      { id: 1, author_id: 1, score: 10 },
      { id: 2, author_id: 1, score: 30 },
      { id: 3, author_id: 2, score: 50 },
      { id: 4, author_id: 2, score: 20 },
    ])
    await db.table(authorsTable).insert({ id: 3, name: 'Linus' })
    const read = () => db.model(Author).query().with('topPost', query => query.where(qualify(postsTable, 'score'), '>', 0).orderBy(qualify(postsTable, 'score'), 'desc')).orderBy('id').get()
    let reads = 0
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => {
        reads += 1
        return read()
      } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const statementsBeforeInsert = statements.length

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(authorsTable).insert([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]) }))

    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual([
      { id: 1, name: 'Ada', topPost: { id: 2, author_id: 1, score: 30 } },
      { id: 2, name: 'Grace', topPost: { id: 3, author_id: 2, score: 50 } },
      { id: 3, name: 'Linus', topPost: null },
    ])
    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(JSON.parse(JSON.stringify(await read())))
    expect(reads).toBe(1)
    expect(statements.slice(statementsBeforeInsert).some(sql => sql.includes('ROW_NUMBER() OVER') && sql.includes(`"${postsName}"`))).toBe(true)
  })
})

describe('realtime relation reads on attached SQLite databases', () => {
  async function openShadowedArchive() {
    const { db, schema } = await openQualifiedDatabase('sqlite')
    await schema.createTable('archive.owners', (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    await db.table('archive.owners').insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
    const Owner = defineModel(defineGeneratedTable('archive.owners', { id: column.integer().primaryKey(), name: column.string() }), { timestamps: false })
    const shadowOwners = async () => {
      await schema.createTable('owners', (table) => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      await db.table('owners').insert({ id: 2, name: 'Shadow Grace' })
    }
    return { db, schema, Owner, shadowOwners }
  }

  async function subscribe<T>(read: () => Promise<T>) {
    return await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: read }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
  }

  it.each([
    ['hasOne', [1]],
    ['hasOne', [1, 2]],
    ['hasMany', [1]],
    ['hasMany', [1, 2]],
  ] as const)('hydrates the %s relation of inserted authors %j from the attached table after a same-named table appears in main', async (kind, ids) => {
    const { db, schema } = await openQualifiedDatabase('sqlite')
    await schema.createTable('archive.posts', (table) => {
      table.integer('id').primaryKey()
      table.integer('author_id')
      table.integer('score')
    })
    await schema.createTable('authors', (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    const Post = defineModel(defineGeneratedTable('archive.posts', { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer() }), { timestamps: false })
    const Author = defineModel(defineGeneratedTable('authors', { id: column.integer().primaryKey(), name: column.string() }), {
      timestamps: false,
      relations: {
        posts: kind === 'hasOne' ? hasOne(() => Post, 'author_id') : hasMany(() => Post, 'author_id'),
      },
    })
    await db.table('archive.posts').insert([
      { id: 1, author_id: 1, score: 10 },
      { id: 2, author_id: 1, score: 30 },
      { id: 3, author_id: 2, score: 50 },
    ])
    await db.table('authors').insert({ id: 3, name: 'Linus' })
    const read = () => db.model(Author).query().with('posts', query => query.orderBy('score', 'desc')).orderBy('id').get()
    const subscription = await subscribe(read)
    await schema.createTable('posts', (table) => {
      table.integer('id').primaryKey()
      table.integer('author_id')
      table.integer('score')
    })
    await db.table('posts').insert([
      { id: 9, author_id: 1, score: 90 },
      { id: 8, author_id: 2, score: 80 },
    ])

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('authors').insert(ids.map(id => ({ id, name: `Author ${id}` }))) }))

    const posts: Record<number, readonly { id: number, author_id: number, score: number }[]> = {
      1: [{ id: 2, author_id: 1, score: 30 }, { id: 1, author_id: 1, score: 10 }],
      2: [{ id: 3, author_id: 2, score: 50 }],
      3: [],
    }
    const fresh = JSON.parse(JSON.stringify(await read()))
    expect(fresh.map((author: { posts: unknown }) => author.posts)).toEqual([...ids, 3].map(id => kind === 'hasOne' ? posts[id]?.[0] ?? null : posts[id]))
    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(fresh)
  })

  it.each([
    ['hasOne', [1]],
    ['hasOne', [1, 2]],
    ['hasMany', [1]],
    ['hasMany', [1, 2]],
  ] as const)('keeps %s relation reads of authors %j apart for an attached table and the same-named main table', async (kind, ids) => {
    const { db, schema } = await openQualifiedDatabase('sqlite')
    const createPosts = async (name: string, tableName: string, rows: readonly { id: number, author_id: number, score: number }[]) => {
      await schema.createTable(tableName, (table) => {
        table.integer('id').primaryKey()
        table.integer('author_id')
        table.integer('score')
      })
      await db.table(tableName).insert([...rows])
      return defineModel(defineGeneratedTable(tableName, { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer() }), { name, timestamps: false })
    }
    await schema.createTable('authors', (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    await db.table('authors').insert({ id: 3, name: 'Linus' })
    const defineAuthor = (name: string, Post: Awaited<ReturnType<typeof createPosts>>) => defineModel(defineGeneratedTable('authors', { id: column.integer().primaryKey(), name: column.string() }), {
      name,
      timestamps: false,
      relations: { posts: kind === 'hasOne' ? hasOne(() => Post, 'author_id') : hasMany(() => Post, 'author_id') },
    })
    const ArchiveAuthor = defineAuthor('ArchiveAuthor', await createPosts('ArchivePost', 'archive.posts', [{ id: 1, author_id: 1, score: 10 }, { id: 2, author_id: 2, score: 20 }, { id: 3, author_id: 3, score: 30 }]))
    const readArchive = () => db.model(ArchiveAuthor).query().with('posts', query => query.orderBy('score', 'desc')).orderBy('id').get()
    const archive = await subscribe(readArchive)
    const MainAuthor = defineAuthor('MainAuthor', await createPosts('MainPost', 'posts', [{ id: 9, author_id: 1, score: 90 }, { id: 8, author_id: 2, score: 80 }, { id: 7, author_id: 3, score: 70 }]))
    const readMain = () => db.model(MainAuthor).query().with('posts', query => query.orderBy('score', 'desc')).orderBy('id').get()
    const main = await subscribe(readMain)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('authors').insert(ids.map(id => ({ id, name: `Author ${id}` }))) }))

    expect(JSON.parse(JSON.stringify(archive.current.data))).toEqual(JSON.parse(JSON.stringify(await readArchive())))
    expect(JSON.parse(JSON.stringify(main.current.data))).toEqual(JSON.parse(JSON.stringify(await readMain())))
  })

  it.each([
    [[2]],
    [[1, 2]],
  ] as const)('hydrates the belongsTo relation of inserted rows with owners %j from the attached table after a same-named table appears in main', async (ownerIds) => {
    const { db, schema, Owner, shadowOwners } = await openShadowedArchive()
    await schema.createTable('notes', (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_id')
    })
    await db.table('notes').insert({ id: 1, owner_id: 1 })
    const Note = defineModel(defineGeneratedTable('notes', { id: column.integer().primaryKey(), owner_id: column.integer() }), {
      timestamps: false,
      relations: { owner: belongsTo(() => Owner, 'owner_id') },
    })
    const read = () => db.model(Note).query().with('owner').orderBy('id').get()
    const subscription = await subscribe(read)
    await shadowOwners()

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('notes').insert(ownerIds.map((ownerId, index) => ({ id: index + 2, owner_id: ownerId }))) }))

    const fresh = JSON.parse(JSON.stringify(await read()))
    expect(fresh.map((note: { owner: unknown }) => note.owner)).toEqual([1, ...ownerIds].map(id => id === 1 ? { id: 1, name: 'Ada' } : { id: 2, name: 'Grace' }))
    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(fresh)
  })

  it.each([
    [[1]],
    [[1, 2]],
  ] as const)('keeps belongsTo relation reads of owners %j apart for an attached table and the same-named main table', async (ownerIds) => {
    const { db, schema } = await openQualifiedDatabase('sqlite')
    const createOwners = async (name: string, tableName: string, label: string, ids: readonly number[]) => {
      await schema.createTable(tableName, (table) => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      await db.table(tableName).insert(ids.map(id => ({ id, name: `${label} ${id}` })))
      return defineModel(defineGeneratedTable(tableName, { id: column.integer().primaryKey(), name: column.string() }), { name, timestamps: false })
    }
    await schema.createTable('notes', (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_id')
    })
    await db.table('notes').insert({ id: 1, owner_id: 3 })
    const defineNote = (name: string, Owner: Awaited<ReturnType<typeof createOwners>>) => defineModel(defineGeneratedTable('notes', { id: column.integer().primaryKey(), owner_id: column.integer() }), {
      name,
      timestamps: false,
      relations: { owner: belongsTo(() => Owner, 'owner_id') },
    })
    const ArchiveNote = defineNote('ArchiveNote', await createOwners('ArchiveOwner', 'archive.owners', 'Archive', [1, 2, 3]))
    const readArchive = () => db.model(ArchiveNote).query().with('owner').orderBy('id').get()
    const archive = await subscribe(readArchive)
    const MainNote = defineNote('MainNote', await createOwners('MainOwner', 'owners', 'Main', [1, 2]))
    const readMain = () => db.model(MainNote).query().with('owner').orderBy('id').get()
    const main = await subscribe(readMain)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('notes').insert(ownerIds.map((ownerId, index) => ({ id: index + 2, owner_id: ownerId }))) }))

    expect(JSON.parse(JSON.stringify(archive.current.data))).toEqual(JSON.parse(JSON.stringify(await readArchive())))
    expect(JSON.parse(JSON.stringify(main.current.data))).toEqual(JSON.parse(JSON.stringify(await readMain())))
  })

  it('reads the related row of an attached pivot row from the attached table after a same-named table appears in main', async () => {
    const { db, schema, Owner, shadowOwners } = await openShadowedArchive()
    await schema.createTable('teams', (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    await schema.createTable('team_owners', (table) => {
      table.integer('team_id')
      table.integer('owner_id')
      table.integer('position')
    })
    await db.table('teams').insert({ id: 1, name: 'Core' })
    await db.table('team_owners').insert({ team_id: 1, owner_id: 1, position: 1 })
    const Team = defineModel(defineGeneratedTable('teams', { id: column.integer().primaryKey(), name: column.string() }), {
      timestamps: false,
      relations: { owners: belongsToMany(() => Owner, 'team_owners', 'team_id', 'owner_id').withPivot('position').orderByPivot('position') },
    })
    const read = () => db.model(Team).query().with('owners').orderBy('id').get()
    const subscription = await subscribe(read)
    await shadowOwners()

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table('team_owners').insert({ team_id: 1, owner_id: 2, position: 2 }) }))

    const fresh = JSON.parse(JSON.stringify(await read()))
    expect(fresh[0].owners.map((owner: { name: string }) => owner.name)).toEqual(['Ada', 'Grace'])
    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(fresh)
  })
})
