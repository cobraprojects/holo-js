import { randomUUID } from 'node:crypto'
import { belongsTo, column, defineGeneratedTable, defineModel, hasMany, hasOne } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]
type Kind = 'hasMany' | 'hasOne'

async function openAuthors(driver: Driver, kind: Kind) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsName = `holo_child_authors_${suffix}`
  const postsName = `holo_child_posts_${suffix}`
  await schema.createTable(authorsName, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await schema.createTable(postsName, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.integer('tenant_id')
    table.string('title')
    table.timestamp('deleted_at').nullable()
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(authorsName)
  })
  const authors = defineGeneratedTable(authorsName, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(postsName, { id: column.integer().primaryKey(), author_id: column.integer(), tenant_id: column.integer(), title: column.string(), deleted_at: column.timestamp().nullable() })
  await db.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
  await db.table(posts).insert([
    { id: 1, author_id: 1, tenant_id: 1, title: 'first', deleted_at: null },
    { id: 2, author_id: 2, tenant_id: 1, title: 'second', deleted_at: null },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const SoftPost = defineModel(posts, { timestamps: false, softDeletes: true })
  const tenantPosts = defineGeneratedTable(postsName, { id: column.integer().primaryKey(), author_id: column.integer(), tenant_id: column.integer(), title: column.string() })
  const TenantPost = defineModel(tenantPosts, { timestamps: false, globalScopes: { tenant: query => query.where('tenant_id', 1) } })
  const SoftAuthor = defineModel(authors, { timestamps: false, relations: { posts: kind === 'hasMany' ? hasMany(() => SoftPost, 'author_id') : hasOne(() => SoftPost, 'author_id') } })
  const TenantAuthor = defineModel(authors, { timestamps: false, relations: { posts: kind === 'hasMany' ? hasMany(() => TenantPost, 'author_id') : hasOne(() => TenantPost, 'author_id') } })
  const NarrowPost = defineModel(posts, { timestamps: false, globalScopes: { narrow: query => query.select('id', 'author_id', 'title') } })
  const NarrowAuthor = defineModel(authors, { timestamps: false, relations: { posts: kind === 'hasMany' ? hasMany(() => NarrowPost, 'author_id') : hasOne(() => NarrowPost, 'author_id') } })
  const Writer = defineModel(authors, { timestamps: false })
  const NestedPost = defineModel(posts, { timestamps: false, relations: { writer: belongsTo(() => Writer, 'author_id') }, globalScopes: { writer: query => query.with('writer') } })
  const NestedAuthor = defineModel(authors, { timestamps: false, relations: { posts: kind === 'hasMany' ? hasMany(() => NestedPost, 'author_id') : hasOne(() => NestedPost, 'author_id') } })
  const ExistsPost = defineModel(posts, { timestamps: false, globalScopes: { tenant: query => query.where('tenant_id', 1).whereExists(db.table(authors).select('id')) } })
  const ExistsAuthor = defineModel(authors, { timestamps: false, relations: { posts: kind === 'hasMany' ? hasMany(() => ExistsPost, 'author_id') : hasOne(() => ExistsPost, 'author_id') } })
  return { db, authors, posts, SoftPost, SoftAuthor, TenantAuthor, NarrowAuthor, NestedAuthor, ExistsAuthor }
}

async function subscribe(handler: () => Promise<unknown>) {
  return await subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )
}

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function expectFresh(subscription: { current: { data: unknown } }, handler: () => Promise<unknown>) {
  expect(subscription.current.data).toEqual(await handler())
}

describe.each(drivers)('realtime hasOne and hasMany children hidden by global scopes on %s', (driver) => {
  describe.each(['hasMany', 'hasOne'] as const)('%s', (kind) => {
    it('keeps a soft-deleted child hidden from an inserted parent', async () => {
      const { db, authors, posts, SoftAuthor } = await openAuthors(driver, kind)
      const handler = () => db.model(SoftAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(posts).insert({ id: 3, author_id: 3, tenant_id: 1, title: 'trashed', deleted_at: new Date() }))
      await expectFresh(subscription, handler)

      await mutate(() => db.table(authors).insert({ id: 3, name: 'Linus' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"Linus"')
      expect(JSON.stringify(subscription.current.data)).not.toContain('"trashed"')
    })

    it('patches a parent in place while its other-tenant child stays hidden', async () => {
      const { db, authors, posts, TenantAuthor } = await openAuthors(driver, kind)
      await db.table(posts).where('id', 1).update({ tenant_id: 2 })
      let reads = 0
      const read = () => db.model(TenantAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(() => {
        reads += 1
        return read()
      })

      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, read)
      expect(JSON.stringify(subscription.current.data)).toContain('"Ada Lovelace"')
      expect(JSON.stringify(subscription.current.data)).not.toContain('"first"')
      expect(reads).toBe(1)
    })

    it('keeps a soft-deleted child hidden when its parent changes', async () => {
      const { db, authors, SoftPost, SoftAuthor } = await openAuthors(driver, kind)
      const handler = () => db.model(SoftAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"first"')

      await mutate(() => db.model(SoftPost).query().where('id', 1).delete())
      await expectFresh(subscription, handler)

      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"Ada Lovelace"')
      expect(JSON.stringify(subscription.current.data)).not.toContain('"first"')
    })

    it('shows a restored child again once its parent changes', async () => {
      const { db, authors, posts, SoftAuthor } = await openAuthors(driver, kind)
      await db.table(posts).where('id', 1).update({ deleted_at: new Date() })
      const handler = () => db.model(SoftAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)
      expect(JSON.stringify(subscription.current.data)).not.toContain('"first"')

      await mutate(() => db.table(posts).where('id', 1).update({ deleted_at: null }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"first"')
    })

    it.each(['soft-deleted', 'other-tenant', 'exists-scoped other-tenant'] as const)('keeps the %s child inserted for an existing parent hidden as the parent changes', async (hidden) => {
      const { db, authors, posts, SoftAuthor, TenantAuthor, ExistsAuthor } = await openAuthors(driver, kind)
      await db.table(posts).where('id', 1).delete()
      const Author = hidden === 'soft-deleted' ? SoftAuthor : hidden === 'other-tenant' ? TenantAuthor : ExistsAuthor
      const handler = () => db.model(Author).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(posts).insert({ id: 3, author_id: 1, tenant_id: hidden === 'soft-deleted' ? 1 : 2, title: 'hidden', deleted_at: hidden === 'soft-deleted' ? new Date() : null }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).not.toContain('"hidden"')
    })

    it('keeps children selected by a global scope in the same shape when their parent changes', async () => {
      const { db, authors, NarrowAuthor } = await openAuthors(driver, kind)
      const handler = () => db.model(NarrowAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).insert({ id: 3, name: 'Linus' }))
      await expectFresh(subscription, handler)
    })

    it('keeps children eager-loaded by a global scope in the same shape as they change', async () => {
      const { db, authors, posts, NestedAuthor } = await openAuthors(driver, kind)
      await db.table(posts).where('id', 2).delete()
      const handler = () => db.model(NestedAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(posts).insert({ id: 3, author_id: 2, tenant_id: 1, title: 'third', deleted_at: null }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(posts).where('id', 3).update({ title: 'third edited' }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"writer"')
    })

    it('drops an exists-scoped child that leaves the tenant while a plain query of the children patches', async () => {
      const { db, posts, ExistsAuthor } = await openAuthors(driver, kind)
      const handler = async () => ({
        authors: await db.model(ExistsAuthor).query().with('posts').orderBy('id').getJson(),
        posts: await db.table(posts).select('id', 'title').orderBy('id').get(),
      })
      const subscription = await subscribe(handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"first"')

      await mutate(() => db.table(posts).where('id', 1).update({ tenant_id: 2 }))
      await expectFresh(subscription, handler)
    })

    it('keeps an other-tenant child hidden from an inserted parent', async () => {
      const { db, authors, posts, TenantAuthor } = await openAuthors(driver, kind)
      const handler = () => db.model(TenantAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(posts).insert({ id: 3, author_id: 3, tenant_id: 2, title: 'foreign', deleted_at: null }))
      await expectFresh(subscription, handler)

      await mutate(() => db.table(authors).insert({ id: 3, name: 'Linus' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"Linus"')
      expect(JSON.stringify(subscription.current.data)).not.toContain('"foreign"')
    })

    it('follows a child moving out of and back into the tenant scope as its parent changes', async () => {
      const { db, authors, posts, TenantAuthor } = await openAuthors(driver, kind)
      const handler = () => db.model(TenantAuthor).query().with('posts').orderBy('id').getJson()
      const subscription = await subscribe(handler)

      await mutate(() => db.table(posts).where('id', 1).update({ tenant_id: 2 }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada Lovelace' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).not.toContain('"first"')

      await mutate(() => db.table(posts).where('id', 1).update({ tenant_id: 1 }))
      await expectFresh(subscription, handler)
      await mutate(() => db.table(authors).where('id', 1).update({ name: 'Ada King' }))
      await expectFresh(subscription, handler)
      expect(JSON.stringify(subscription.current.data)).toContain('"first"')
    })
  })
})
