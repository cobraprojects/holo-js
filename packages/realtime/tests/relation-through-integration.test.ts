import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, belongsTo, hasMany, hasManyThrough, hasOneThrough, resetDB } from '@holo-js/db'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Database = Parameters<Parameters<typeof defineRealtimeMutation>[0]['handler']>[0]['db']

async function openLibrary(driver: ReturnType<typeof integrationDrivers<'sqlite' | 'postgres' | 'mysql'>>[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => {
    resetRealtimeRuntime()
    resetDB()
  })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    authors: `tr_authors_${suffix}`,
    posts: `tr_posts_${suffix}`,
    reviews: `tr_reviews_${suffix}`,
    users: `tr_users_${suffix}`,
    teams: `tr_teams_${suffix}`,
  }
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  const create = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    created.push(name)
  }
  await create(names.teams, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await create(names.authors, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
    table.integer('team_id').nullable()
  })
  await create(names.users, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await create(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.string('title')
  })
  await create(names.reviews, (table) => {
    table.integer('id').primaryKey()
    table.integer('post_id')
    table.integer('reviewer_id')
    table.string('body')
  })

  const authors = defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string(), team_id: column.integer().nullable() })
  const teams = defineGeneratedTable(names.teams, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), title: column.string() })
  const users = defineGeneratedTable(names.users, { id: column.integer().primaryKey(), name: column.string() })
  const reviews = defineGeneratedTable(names.reviews, { id: column.integer().primaryKey(), post_id: column.integer(), reviewer_id: column.integer(), body: column.string() })

  await DB.table(teams).insert([{ id: 1, name: 'Compilers' }])
  await DB.table(authors).insert([{ id: 1, name: 'Ada', team_id: null }, { id: 2, name: 'Grace', team_id: 1 }, { id: 3, name: 'Linus', team_id: 1 }])
  await DB.table(posts).insert([{ id: 10, author_id: 1, title: 'Engines' }, { id: 20, author_id: 2, title: 'Compilers' }, { id: 30, author_id: 1, title: 'Notes' }])
  await DB.table(users).insert([{ id: 7, name: 'Barbara' }, { id: 8, name: 'Edsger' }])
  await DB.table(reviews).insert([{ id: 100, post_id: 10, reviewer_id: 7, body: 'great' }, { id: 300, post_id: 30, reviewer_id: 8, body: 'fine' }, { id: 200, post_id: 20, reviewer_id: 7, body: 'sharp' }])

  const User = defineModel(users, { timestamps: false })
  const Review = defineModel(reviews, { timestamps: false, relations: { reviewer: belongsTo(() => User, 'reviewer_id') } })
  const Post = defineModel(posts, { timestamps: false })
  const Author = defineModel(authors, {
    timestamps: false,
    relations: {
      reviews: hasManyThrough(() => Review, () => Post, 'author_id', 'post_id'),
      review: hasOneThrough(() => Review, () => Post, 'author_id', 'post_id'),
      posts: hasMany(() => Post, 'author_id'),
    },
  })
  const Team = defineModel(teams, { timestamps: false, relations: { members: hasMany(() => Author, 'team_id') } })

  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { names, Author, Post, Review, User, Team }
}

type Library = Awaited<ReturnType<typeof openLibrary>>

const ordered = (query: { orderBy: (column: 'id') => unknown }) => query.orderBy('id')
const bothOrdered = { reviews: ordered, review: ordered }

async function subscribe(read: () => Promise<unknown>) {
  const query = defineRealtimeQuery({ access: 'public', handler: async () => await read() })
  const subscription = await subscribeRealtimeQuery(query, {}, {
    onData: () => {},
    onError: (error) => { throw error },
  })
  return subscription
}

function mutate(handler: (db: Database) => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => { await handler(db) } }))
}

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'])) {
  describe(`${driver} realtime through relations`, () => {
    const reads = {
      'eager loaded many': (Author: Library['Author']) => Author.query().with('reviews', ordered).orderBy('id').getJson(),
      'eager loaded one': (Author: Library['Author']) => Author.query().with('review', ordered).orderBy('id').getJson(),
      'eager loaded entities': async (Author: Library['Author']) => (await Author.query().with(bothOrdered).orderBy('id').get()).toJSON(),
      'first with relations': async (Author: Library['Author']) => (await Author.query().with(bothOrdered).where('id', 1).first())?.toJSON(),
      'lazy loaded': async (Author: Library['Author']) => (await (await Author.query().orderBy('id').get()).load('reviews')).toJSON()
        .map(author => ({ ...author, reviews: [...author.reviews].sort((left, right) => Number(left.id) - Number(right.id)) })),
      'related existence': (Author: Library['Author']) => Author.query().whereHas('reviews').orderBy('id').getJson(),
      'related count': (Author: Library['Author']) => Author.query().withCount('reviews').orderBy('id').getJson(),
      'counted through rows': (Author: Library['Author']) => Author.query().with(bothOrdered).withCount('posts').orderBy('id').getJson(),
      'summed through rows': (Author: Library['Author']) => Author.query().with(bothOrdered).withSum('posts', 'id').orderBy('id').getJson(),
      'counted through relations': (Author: Library['Author']) => Author.query().withCount('reviews').withCount('posts').orderBy('id').getJson(),
      'summed through relations': (Author: Library['Author']) => Author.query().withSum('reviews', 'id').withCount('posts').orderBy('id').getJson(),
      'nested in a relation callback': async (_Author: Library['Author'], Post: Library['Post'], _Review: Library['Review'], _User: Library['User'], Team: Library['Team']) => ({
        teams: await Team.query().with('members', query => query.with('reviews', ordered).orderBy('id')).where('id', 1).getJson(),
        posts: await Post.query().orderBy('id').getJson(),
      }),
      'loading relations of the related rows': async (Author: Library['Author'], _Post: Library['Post'], _Review: Library['Review'], User: Library['User']) => ({
        authors: await Author.query().with('reviews', query => query.with('reviewer').orderBy('id')).orderBy('id').getJson(),
        users: await User.query().orderBy('id').getJson(),
      }),
      'composed with the through table': async (Author: Library['Author'], Post: Library['Post']) => ({
        authors: await Author.query().with(bothOrdered).orderBy('id').getJson(),
        posts: await Post.query().orderBy('id').getJson(),
      }),
      'composed with the related table': async (Author: Library['Author'], _Post: Library['Post'], Review: Library['Review']) => ({
        authors: await Author.query().with(bothOrdered).orderBy('id').getJson(),
        reviews: await Review.query().orderBy('id').getJson(),
      }),
    }
    for (const [name, readWith] of Object.entries(reads)) {
      it(`keeps ${name} subscriptions equal to a fresh read across through row and key writes`, async () => {
        const { names, Author, Post, Review, User, Team } = await openLibrary(driver)
        const read = async () => await readWith(Author, Post, Review, User, Team)
        const live = await subscribe(read)
        const expectFresh = async () => {
          expect(JSON.parse(JSON.stringify(live.current.data))).toEqual(JSON.parse(JSON.stringify(await read())))
        }

        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 20).update({ author_id: 3 }))
        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 30).update({ author_id: 2 }))
        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 10).update({ id: 40 }))
        await expectFresh()
        await mutate(db => db.table(names.reviews).where('id', 100).update({ post_id: 40 }))
        await expectFresh()
        await mutate(db => db.table(names.posts).insert({ id: 50, author_id: 3, title: 'Kernels' }))
        await expectFresh()
        await mutate(db => db.table(names.reviews).insert({ id: 500, post_id: 50, reviewer_id: 8, body: 'solid' }))
        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 50).update({ author_id: 1 }))
        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 20).delete())
        await expectFresh()
        await mutate(db => db.table(names.reviews).where('id', 300).delete())
        await expectFresh()
        await mutate(db => db.table(names.posts).where('id', 40).update({ title: 'Engines II' }))
        await expectFresh()
        await mutate(db => db.table(names.users).where('id', 7).update({ name: 'Liskov' }))
        await expectFresh()
      })
    }
  })
}
