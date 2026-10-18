import { afterEach, expect, it } from 'vitest'
import { authRuntimeInternals, createAsyncAuthContext, getAuthRuntime, resetAuthRuntime } from '@holo-js/auth'
import { createDatabase, createDialect, resetDB } from '@holo-js/db'
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

it.each(['authenticated', 'public'] as const)('isolates identical %s subscriptions for different users and anonymous callers', async (require) => {
  const persistence = await createNativeAuthPersistence()
  const store = createNativeSessionStore()
  const context = createAsyncAuthContext()
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
