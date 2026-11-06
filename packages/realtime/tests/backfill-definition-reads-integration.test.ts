import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function openFixture(driver: typeof drivers[number], statements: string[] = []) {
  const { db, schema } = await openDatabase(driver, { wrapAdapter: adapter => new Proxy(adapter, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target)
      return (sql: string, ...rest: unknown[]) => {
        statements.push(sql)
        return Reflect.apply(target.query, target, [sql, ...rest])
      }
    },
  }) })
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const groupsName = `holo_fill_groups_${suffix}`
  const tagsName = `holo_fill_tags_${suffix}`
  const pivotName = `holo_fill_group_tags_${suffix}`
  const postsName = `holo_fill_posts_${suffix}`
  await schema.createTable(groupsName, (table) => {
    table.id()
    table.bigInteger('rank')
    table.string('name')
  })
  await schema.createTable(tagsName, (table) => {
    table.id()
    table.bigInteger('weight')
    table.string('name')
  })
  await schema.createTable(pivotName, (table) => {
    table.id()
    table.bigInteger('group_id')
    table.bigInteger('tag_id')
    table.bigInteger('position')
  })
  await schema.createTable(postsName, (table) => {
    table.id()
    table.bigInteger('group_id')
    table.bigInteger('score')
    table.string('title')
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(groupsName)
  })
  const groups = defineGeneratedTable(groupsName, { id: column.id(), rank: column.bigInteger(), name: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), weight: column.bigInteger(), name: column.string() })
  const groupTags = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.bigInteger(), tag_id: column.bigInteger(), position: column.bigInteger() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), group_id: column.bigInteger(), score: column.bigInteger(), title: column.string() })
  await db.table(groups).insert([{ id: 1, rank: 10, name: 'first' }, { id: 2, rank: 20, name: 'second' }])
  await db.table(tags).insert([{ id: 1, weight: 5, name: 'sale' }, { id: 2, weight: 7, name: 'new' }, { id: 3, weight: 9, name: 'old' }])
  await db.table(groupTags).insert([{ id: 1, group_id: 1, tag_id: 1, position: 2 }])
  await db.table(posts).insert([
    { id: 1, group_id: 1, score: 3, title: 'a' },
    { id: 2, group_id: 1, score: 8, title: 'b' },
    { id: 3, group_id: 2, score: 6, title: 'c' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(groups, { timestamps: false })
  const Post = defineModel(posts, { timestamps: false, fillable: ['group_id', 'score', 'title'], relations: { group: belongsTo(() => Owner, 'group_id') } })
  const Group = defineModel(groups, { timestamps: false, relations: {
    tags: belongsToMany(() => Tag, groupTags, 'group_id', 'tag_id').withPivot('position').orderByPivot('position'),
    topPost: hasOne(() => Post, 'group_id'),
  } })
  return { db, schema, groups, groupTags, posts, Owner, Group, Post }
}

async function subscribeAll(queries: Record<string, () => Promise<unknown>>) {
  const runs = Object.fromEntries(Object.keys(queries).map(name => [name, 0]))
  const subscriptions = await Promise.all(Object.entries(queries).map(([name, handler]) => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: () => {
      runs[name]! += 1
      return handler()
    } }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )))
  return async () => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    expect(Object.fromEntries(Object.keys(queries).map((name, index) => [name, subscriptions[index]!.current.data])))
      .toEqual(Object.fromEntries(Object.keys(queries).map((name, index) => [name, fresh[index]])))
    expect(runs).toEqual(Object.fromEntries(Object.keys(queries).map(name => [name, 1])))
  }
}

describe.each(drivers)('realtime backfills over tables outside the generated registry on %s', (driver) => {
  it('backfills a related row for an ordered belongsToMany insert the way a fresh model read does', async () => {
    const { db, groupTags, Group } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      eager: () => db.model(Group).query().with('tags').orderBy('id').getJson(),
    })

    await mutate(() => db.table(groupTags).insert({ id: 2, group_id: 1, tag_id: 2, position: 1 }))
    await expectFresh()
    await mutate(() => db.table(groupTags).insert({ id: 3, group_id: 2, tag_id: 3, position: 4 }))
    await expectFresh()
  })

  it('hydrates a belongsTo row for a new child the way a fresh model read does', async () => {
    const { db, posts, Post } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      eager: () => db.model(Post).query().with('group').orderBy('id').getJson(),
    })

    await mutate(() => db.table(posts).insert({ id: 4, group_id: 2, score: 1, title: 'd' }))
    await expectFresh()
    await mutate(() => db.table(posts).where('id', 1).update({ group_id: 2 }))
    await expectFresh()
    await mutate(() => db.table(posts).insert([{ id: 5, group_id: 1, score: 2, title: 'e' }, { id: 6, group_id: 2, score: 4, title: 'f' }]))
    await expectFresh()
  })

  it('hydrates ordered hasOne rows for several parents the way a fresh model read does', async () => {
    const { db, groups, posts, Group } = await openFixture(driver)
    await db.table(posts).insert([
      { id: 4, group_id: 3, score: 1, title: 'd' },
      { id: 5, group_id: 3, score: 9, title: 'e' },
      { id: 6, group_id: 4, score: 4, title: 'f' },
    ])
    const expectFresh = await subscribeAll({
      eager: () => db.model(Group).query().with('topPost', query => query.orderBy('score', 'desc')).orderBy('id').getJson(),
    })

    await mutate(() => db.table(groups).insert([{ id: 3, rank: 30, name: 'third' }, { id: 4, rank: 40, name: 'fourth' }]))
    await expectFresh()
  })

  it('backfills windows of several groups the way a fresh model read does', async () => {
    const statements: string[] = []
    const { db, posts, Post } = await openFixture(driver, statements)
    await db.table(posts).insert([{ id: 4, group_id: 2, score: 2, title: 'd' }, { id: 5, group_id: 1, score: 9, title: 'e' }, { id: 6, group_id: 2, score: 7, title: 'f' }])
    const expectFresh = await subscribeAll({
      first: () => db.model(Post).query().where('group_id', 1).orderBy('score').offset(1).limit(1).getJson(),
      second: () => db.model(Post).query().where('group_id', 2).orderBy('score').offset(1).limit(1).getJson(),
    })

    statements.length = 0
    await mutate(() => db.table(posts).where('id', 'in', [1, 4]).delete())
    const reads = statements.slice(statements.findIndex(sql => sql.startsWith('DELETE'))).filter(sql => sql.startsWith('SELECT'))
    await expectFresh()
    expect(reads).toHaveLength(1)
    expect(reads[0]).toContain('__holo_grouped_rows')
  })

  it('backfills aggregates the way a fresh model read does', async () => {
    const { db, posts, Post } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      max: () => db.model(Post).query().max('score'),
      min: () => db.model(Post).query().min('id'),
      sum: () => db.model(Post).query().sum('score'),
    })

    await mutate(() => db.table(posts).where('id', 2).delete())
    await expectFresh()
    await mutate(() => db.table(posts).where('id', 1).delete())
    await expectFresh()
  })

  it('backfills pagination windows and totals the way a fresh model read does', async () => {
    const { db, groups, Group } = await openFixture(driver)
    await db.table(groups).insert([{ id: 3, rank: 30, name: 'third' }, { id: 4, rank: 40, name: 'fourth' }])
    const expectFresh = await subscribeAll({
      page: () => db.model(Group).query().orderBy('id').paginateJson(2, 1),
      simple: () => db.model(Group).query().orderBy('id').simplePaginateJson(2, 1),
      rows: () => db.table(groups).select('id', 'rank').orderBy('id').limit(2).get(),
    })

    await mutate(() => db.table(groups).where('id', 1).delete())
    await expectFresh()
    await mutate(() => db.table(groups).where('id', 2).delete())
    await expectFresh()
  })

  it('re-runs a subscription whose backfilled row holds an integer queries cannot read', async () => {
    const { db, groups, posts, Post } = await openFixture(driver)
    await db.table(groups).insert({ id: 3, rank: '9007199254740993', name: 'huge' })
    const errors: unknown[] = []
    let runs = 0
    const handler = () => db.model(Post).query().with('group').orderBy('id').getJson()
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      runs += 1
      return handler()
    } }), {}, { onData: () => {}, onError: (error) => {
      errors.push(error)
    } })

    await mutate(() => db.table(posts).insert({ id: 4, group_id: 3, score: 1, title: 'd' }))

    await expect(handler()).rejects.toThrow('9007199254740993')
    expect(runs).toBe(2)
    expect(String(errors[0])).toContain('9007199254740993')
  })

  it('hydrates a hasOne row for a new related insert the way a fresh model read does', async () => {
    const { db, posts, Group, Post } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      eager: () => db.model(Group).query().with('topPost').orderBy('id').getJson(),
      ordered: () => db.model(Group).query().with('topPost', query => query.orderBy('score', 'desc')).orderBy('id').getJson(),
    })

    await mutate(() => db.table(posts).insert({ id: 30, group_id: 2, score: 9, title: 'z' }))
    await expectFresh()
    if (driver === 'postgres') {
      await db.executeCompiled({ sql: `SELECT setval(pg_get_serial_sequence('"${posts.tableName}"', 'id'), 40)`, source: 'schema' })
    }
    await mutate(() => db.model(Post).create({ group_id: 1, score: 10, title: 'y' }))
    await expectFresh()
    await mutate(() => db.table(posts.tableName).insert({ id: 50, group_id: 2, score: 11, title: 'x' }))
    await expectFresh()
  })

  it('hydrates belongsTo rows for several children whose text keys reference an integer key', async () => {
    const { db, schema, Owner } = await openFixture(driver)
    const name = `holo_fill_notes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.string('group_key')
    })
    onTestFinished(() => schema.dropTable(name))
    const notes = defineGeneratedTable(name, { id: column.id(), group_key: column.string() })
    await db.table(notes).insert({ id: 1, group_key: '1' })
    const Note = defineModel(notes, { timestamps: false, relations: { group: belongsTo(() => Owner, 'group_key') } })
    const expectFresh = await subscribeAll({
      eager: () => db.model(Note).query().with('group').orderBy('id').getJson(),
    })

    await mutate(() => db.table(notes).insert([{ id: 2, group_key: '1' }, { id: 3, group_key: '2' }]))
    await expectFresh()
  })

  it('hydrates hasMany and hasOne rows for several parents whose children hold text keys', async () => {
    const { db, schema, groups } = await openFixture(driver)
    const name = `holo_fill_notes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.string('group_key')
      table.bigInteger('score')
    })
    onTestFinished(() => schema.dropTable(name))
    const notes = defineGeneratedTable(name, { id: column.id(), group_key: column.string(), score: column.bigInteger() })
    await db.table(notes).insert([{ id: 1, group_key: '3', score: 1 }, { id: 2, group_key: '3', score: 5 }, { id: 3, group_key: '4', score: 2 }])
    const Note = defineModel(notes, { timestamps: false })
    const Parent = defineModel(groups, { timestamps: false, relations: {
      notes: hasMany(() => Note, 'group_key'),
      topNote: hasOne(() => Note, 'group_key'),
    } })
    const expectFresh = await subscribeAll({
      many: () => db.model(Parent).query().with('notes').orderBy('id').getJson(),
      top: () => db.model(Parent).query().with('topNote', query => query.orderBy('score', 'desc')).orderBy('id').getJson(),
    })

    await mutate(() => db.table(groups).insert([{ id: 3, rank: 30, name: 'third' }, { id: 4, rank: 40, name: 'fourth' }]))
    await expectFresh()
  })

  it.runIf(driver === 'sqlite')('patches a window backfill whose integer column holds text a fresh read returns unchanged', async () => {
    const { db, posts } = await openFixture(driver)
    await db.executeCompiled({ sql: `UPDATE "${posts.tableName}" SET "score" = 'abc' WHERE "id" = 2`, source: 'schema' })
    const expectFresh = await subscribeAll({
      rows: () => db.table(posts).orderBy('id').limit(1).get(),
    })

    await mutate(() => db.table(posts).where('id', 1).delete())
    await expectFresh()
  })
})
