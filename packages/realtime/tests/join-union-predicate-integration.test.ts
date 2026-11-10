import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function sortById(rows: unknown): unknown {
  return Array.isArray(rows) ? [...rows].sort((left, right) => Number(left.id) - Number(right.id)) : rows
}

async function openAuthorPosts(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsName = `holo_jp_authors_${suffix}`
  const postsName = `holo_jp_posts_${suffix}`
  await schema.createTable(authorsName, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(postsName, (table) => {
    table.id()
    table.integer('author_id')
    table.string('title')
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(authorsName)
  })
  const authors = defineGeneratedTable(authorsName, { id: column.id(), name: column.string() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), author_id: column.integer(), title: column.string() })
  await db.table(authors).insert({ id: 1, name: 'Ada' })
  await db.table(authors).insert({ id: 2, name: 'Grace' })
  await db.table(posts).insert({ id: 1, author_id: 2, title: 'first' })
  await db.table(posts).insert({ id: 2, author_id: 1, title: 'second' })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { authorsName, db, postsName, posts, authors }
}

describe.each(drivers)('realtime predicates across joined and unioned queries on %s', (driver) => {
  it('refreshes a joined subscription when a write to the base table changes its joined predicate row', async () => {
    const { authorsName, db, postsName, authors, posts } = await openAuthorPosts(driver)
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table(posts)
        .join(authors, `${postsName}.author_id`, '=', `${authorsName}.id`)
        .where(`${authorsName}.id`, 1)
        .select('title')
        .get(),
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = snapshot.data },
    })
    expect(latest).toEqual([{ title: 'second' }])

    await db.table(posts).where('id', 2).update({ title: 'second updated' })

    expect(latest).toEqual([{ title: 'second updated' }])
  })

  it('refreshes a unioned subscription when a write to one branch changes its row', async () => {
    const { db, posts } = await openAuthorPosts(driver)
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => await context.table(posts)
        .select('id', 'title')
        .where('author_id', 1)
        .union(context.table(posts).select('id', 'title').where('author_id', 2))
        .get(),
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = sortById(snapshot.data) },
    })
    expect(latest).toEqual([{ id: 1, title: 'first' }, { id: 2, title: 'second' }])

    await db.table(posts).where('id', 1).update({ title: 'first updated' })

    expect(latest).toEqual([{ id: 1, title: 'first updated' }, { id: 2, title: 'second' }])
  })
})
