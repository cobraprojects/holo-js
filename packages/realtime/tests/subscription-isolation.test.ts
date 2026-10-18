import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, expect, it } from 'vitest'
import { authRuntimeInternals, createAsyncAuthContext, getAuthRuntime, resetAuthRuntime, type AuthRuntimeContext } from '@holo-js/auth'
import { DB, configureDB, createConnectionManager, createDatabase, createDialect, resetDB, type DatabaseContext } from '@holo-js/db'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src'
import { createNativeAuthPersistence } from '../../auth/tests/support/native-persistence'
import { createNativeSessionStore } from '../../auth/tests/support/native-session'
import { createNativeRelationalAdapter } from './helpers/native-fixture'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, RealtimeUnauthorizedError, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

afterEach(() => {
  resetRealtimeRuntime()
  resetAuthRuntime()
  resetSessionRuntime()
  resetDB()
})

async function configureAuthenticatedSubscriptions(context: AuthRuntimeContext) {
  const persistence = await createNativeAuthPersistence()
  const store = createNativeSessionStore()
  configureSessionRuntime({
    config: { ...persistence.loadedConfig.session, driver: 'file', stores: { file: { name: 'file', driver: 'file', path: store.path } } },
    stores: { file: store },
  })
  authRuntimeInternals.configureRuntime({
    config: persistence.loadedConfig.auth,
    providers: persistence.providers,
    session: getSessionRuntime(),
    context,
  })
  await persistence.db.table('users').insert([
    { id: 10, name: 'Ava', email: 'ava@example.com' },
    { id: 20, name: 'Ben', email: 'ben@example.com' },
  ])
  configureRealtimeRuntime({ db: () => persistence.db })
  return persistence
}

it.each(['authenticated', 'public'] as const)('isolates identical %s subscriptions for different users and anonymous callers', async (require) => {
  const context = createAsyncAuthContext()
  const configuredContext = { ...context, getSessionId: (guard: string) => context.getSessionId(guard) }
  const persistence = await configureAuthenticatedSubscriptions(configuredContext)
  const authorized: Array<string | number | undefined> = []
  const query = defineRealtimeQuery({
    access: {
      require,
      authorize: async ({ auth }) => {
        authorized.push(auth?.user.id)
        return true
      },
    },
    handler: async ({ auth, db }) => await db.table('users').where('id', auth?.user.id ?? 0).whereInSub('id', db.table('users').select('id')).select('id', 'name').get(),
  })

  const first = await context.run(async () => {
    await getAuthRuntime().guard('web').loginUsingId(10)
    return await subscribeRealtimeQuery(query)
  })
  expect(first.current.data).toEqual([{ id: 10, name: 'Ava' }])
  const second = await context.run(async () => {
    await getAuthRuntime().guard('web').loginUsingId(20)
    return await subscribeRealtimeQuery(query)
  })
  expect(second.current.data).toEqual([{ id: 20, name: 'Ben' }])
  await context.run(async () => {
    if (require === 'authenticated') {
      await expect(subscribeRealtimeQuery(query)).rejects.toBeInstanceOf(RealtimeUnauthorizedError)
    } else {
      const anonymous = await subscribeRealtimeQuery(query)
      expect(anonymous.current.data).toEqual([])
    }
  })
  expect(authorized).toEqual(require === 'authenticated' ? [10, 20] : [10, 20, undefined])
  await context.run(async () => {
    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: async ({ db }) => {
        await db.table('users').where('id', 10).update({ name: 'Updated Ava' })
      },
    }))
  })
  expect(first.current.data).toEqual([{ id: 10, name: 'Updated Ava' }])
  expect(second.current.data).toEqual([{ id: 20, name: 'Ben' }])
}, 30000)

it('uses one initial query and patches a single subscription without extra reads', async () => {
  const adapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'First' }] })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureRealtimeRuntime({ db: () => db })
  const query = defineRealtimeQuery({
    access: 'public',
    handler: async ({ db }) => await db.table('posts').where('id', 1).get(),
  })
  const subscription = await subscribeRealtimeQuery(query)
  expect(subscription.current.data).toEqual([{ id: 1, title: 'First' }])
  expect(adapter.queries).toHaveLength(1)
  adapter.queries.length = 0

  await executeRealtimeMutation(defineRealtimeMutation({
    access: 'public',
    handler: async ({ db }) => {
      await db.table('posts').where('id', 1).update({ title: 'Updated' })
    },
  }))

  expect(subscription.current.data).toEqual([{ id: 1, title: 'Updated' }])
  expect(adapter.queries.filter(query => query.sql.startsWith('SELECT '))).toHaveLength(0)
})

it('refreshes outside a completed subscription transaction', async () => {
  const adapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'First' }] })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => DB.connection() })
  const query = defineRealtimeQuery({
    access: 'public',
    handler: async ({ db }) => ({
      scope: DB.connection().getScope().kind,
      posts: await db.table('posts').whereInSub('id', db.table('posts').select('id')).get(),
    }),
  })
  const subscription = await db.transaction(async () => await subscribeRealtimeQuery(query))
  expect(subscription.current.data.scope).not.toBe('root')

  await db.table('posts').where('id', 1).update({ title: 'Updated' })

  expect(subscription.current.data).toEqual({ scope: 'root', posts: [{ id: 1, title: 'Updated' }] })
})

it('keeps mutation patches and backfills inside each caller database', async () => {
  const firstAdapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'A1' }, { id: 2, title: 'A2' }] })
  const secondAdapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'B1' }, { id: 2, title: 'B2' }] })
  const firstDb = createDatabase({ adapter: firstAdapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  const secondDb = createDatabase({ adapter: secondAdapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  const caller = new AsyncLocalStorage<DatabaseContext>()
  configureRealtimeRuntime({ db: () => caller.getStore() ?? firstDb })
  const query = defineRealtimeQuery({
    access: 'public',
    handler: async ({ db }) => await db.table('posts').orderBy('id').limit(1).get(),
  })
  const first = await caller.run(firstDb, async () => await subscribeRealtimeQuery(query))
  const second = await caller.run(secondDb, async () => await subscribeRealtimeQuery(query))
  expect(first.current.data).toEqual([{ id: 1, title: 'A1' }])
  expect(second.current.data).toEqual([{ id: 1, title: 'B1' }])

  await caller.run(firstDb, async () => await firstDb.table('posts').where('id', 1).delete())

  expect(first.current.data).toEqual([{ id: 2, title: 'A2' }])
  expect(second.current.data).toEqual([{ id: 1, title: 'B1' }])

  await caller.run(secondDb, async () => await secondDb.table('posts').where('id', 1).delete())

  expect(first.current.data).toEqual([{ id: 2, title: 'A2' }])
  expect(second.current.data).toEqual([{ id: 2, title: 'B2' }])

  await Promise.all([
    caller.run(firstDb, async () => await firstDb.table('posts').where('id', 2).update({ title: 'Updated A2' })),
    caller.run(secondDb, async () => await secondDb.table('posts').where('id', 2).update({ title: 'Updated B2' })),
  ])

  expect(first.current.data).toEqual([{ id: 2, title: 'Updated A2' }])
  expect(second.current.data).toEqual([{ id: 2, title: 'Updated B2' }])
})

it('retains each caller across independent memory auth contexts', async () => {
  const context = authRuntimeInternals.createMemoryAuthContext()
  const persistence = await configureAuthenticatedSubscriptions(context)
  const query = defineRealtimeQuery({
    access: 'authenticated',
    handler: async ({ auth, db }) => await db.table('users').where('id', auth.user.id).whereInSub('id', db.table('users').select('id')).select('id', 'name').get(),
  })
  await getAuthRuntime().guard('web').loginUsingId(10)
  const first = await subscribeRealtimeQuery(query)
  authRuntimeInternals.configureRuntime({
    config: persistence.loadedConfig.auth,
    providers: persistence.providers,
    session: getSessionRuntime(),
    context: authRuntimeInternals.createMemoryAuthContext(),
  })
  await getAuthRuntime().guard('web').loginUsingId(20)
  const second = await subscribeRealtimeQuery(query)

  await persistence.db.table('users').where('id', 10).update({ name: 'Updated Ava' })

  expect(first.current.data).toEqual([{ id: 10, name: 'Updated Ava' }])
  expect(second.current.data).toEqual([{ id: 20, name: 'Ben' }])
}, 30000)

it('reruns queries that observe a different database from the runtime binding', async () => {
  const primaryAdapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'A1' }, { id: 2, title: 'A2' }] })
  const observedAdapter = await createNativeRelationalAdapter({ posts: [{ id: 1, title: 'B1' }, { id: 2, title: 'B2' }] })
  const primary = createDatabase({ adapter: primaryAdapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  const observed = createDatabase({ adapter: observedAdapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureRealtimeRuntime({ db: () => primary })
  const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({
    access: 'public',
    handler: async () => await observed.table('posts').orderBy('id').limit(1).get(),
  }))
  expect(subscription.current.data).toEqual([{ id: 1, title: 'B1' }])

  await primary.table('posts').where('id', 1).update({ title: 'Foreign A1' })
  expect(subscription.current.data).toEqual([{ id: 1, title: 'B1' }])

  await observed.table('posts').where('id', 1).delete()

  expect(subscription.current.data).toEqual([{ id: 2, title: 'B2' }])
})
