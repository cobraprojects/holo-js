import { expect, it, onTestFinished } from 'vitest'
import auth, { configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter } from '../src'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src'
import { createNativeAuthPersistence } from './support/native-persistence'
import { createNativeSessionStore } from './support/native-session'
import type NativeUser from './support/models/User'

it('selects dynamic session guards before credentials and preserves the configured provider', async () => {
  const persistence = await createNativeAuthPersistence()
  const sessionStore = createNativeSessionStore()
  const cookies: string[] = []
  const context = Object.assign(createAsyncAuthContext(), {
    appendResponseCookie: (cookie: string) => { cookies.push(cookie) },
  })
  configureSessionRuntime({ appKey: 'dynamic-guard-test-app-key', config: persistence.loadedConfig.session, stores: { file: sessionStore } })
  type User = ReturnType<NonNullable<Awaited<ReturnType<typeof NativeUser.find>>>['toAttributes']>
  const admins = persistence.providers.admins as AuthProviderAdapter<User>
  const users = persistence.providers.users as AuthProviderAdapter<User>
  configureAuthRuntime({ ...persistence, providers: { admins, users }, config: persistence.loadedConfig.auth, session: getSessionRuntime(), context })
  onTestFinished(() => { resetAuthRuntime(); resetSessionRuntime() })

  const password = await auth.hashPassword('secret-secret')
  const admin = await admins.create({ name: 'Admin', email: 'shared@app.test', password })
  const user = await users.create({ name: 'User', email: 'shared@app.test', password })
  const adminId = admins.getId(admin)
  const userId = users.getId(user)

  const login = (name: string) => context.run(async () => {
    const guard = auth.guard(name)
    if (!('multiFactor' in guard)) throw new Error('A session guard is required')
    return guard.login({ email: 'shared@app.test', password: 'secret-secret' })
  })

  await expect(login('api')).rejects.toThrow('A session guard is required')
  await expect(persistence.tokens.listByUserId('users', userId)).resolves.toEqual([])
  await expect(sessionStore.countRecords()).resolves.toBe(0)
  expect(cookies).toEqual([])

  const session = await login('admin')
  expect(session.user).toMatchObject({ id: adminId, name: 'Admin' })
  expect(session.cookies.length).toBeGreaterThan(0)
  await expect(sessionStore.countRecords()).resolves.toBe(1)
  await expect(persistence.tokens.listByUserId('users', userId)).resolves.toEqual([])
})
