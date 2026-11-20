import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import auth, { authRuntimeInternals, createAsyncAuthContext, hashPassword, resetAuthRuntime, type AuthPasswordHasher } from '@holo-js/auth'
import { configureSessionRuntime, getSessionRuntime, normalizeSessionConfig, parseCookieHeader, resetSessionRuntime } from '@holo-js/session'
import { field, safeParse, schema, validate, type FieldBuilderInput, type ValidationField, ValidationException } from '@holo-js/validation'
import { createNativeAuthPersistence } from './support/native-persistence'
import { createNativeSessionStore } from './support/native-session'

async function setup(options: { passwordHasher?: AuthPasswordHasher, customPasswordAttribute?: boolean } = {}) {
  const persistence = await createNativeAuthPersistence()
  const store = createNativeSessionStore()
  configureSessionRuntime({
    appKey: 'current-password-test-key',
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: store.path } } }),
    stores: { file: store },
  })
  const users = persistence.providers.users
  const admins = persistence.providers.admins
  if (!users || !admins) throw new Error('Auth test providers are missing.')
  const requests = new AsyncLocalStorage<{ cookies: Record<string, string>, responseCookies: string[] }>()
  const context = {
    ...createAsyncAuthContext(),
    getRequestCookie: (name: string) => requests.getStore()?.cookies[name],
    appendResponseCookie: (cookie: string) => { requests.getStore()?.responseCookies.push(cookie) },
  }
  const usersProvider: typeof users = options.customPasswordAttribute
    ? { ...users, getPasswordHash: user => users.getPasswordHash?.(user)?.replace(/^stored:/, '') }
    : users
  authRuntimeInternals.configureRuntime({
    config: {
      defaults: { guard: 'web' },
      guards: {
        web: { driver: 'session', provider: 'users' },
        admin: { driver: 'session', provider: 'admins' },
        api: { driver: 'token', provider: 'users' },
      },
      providers: { users: { model: 'User' }, admins: { model: 'Admin' } },
    },
    providers: { users: usersProvider, admins },
    session: getSessionRuntime(),
    sessionRevocations: persistence.sessionRevocations,
    tokens: persistence.tokens,
    context,
    passwordHasher: options.passwordHasher,
  })
  async function request<TValue>(sessionId: string | undefined, callback: (responseCookies: string[]) => Promise<TValue>, requestCookies: Record<string, string> = {}): Promise<TValue> {
    const cookies = { ...requestCookies, ...sessionId ? parseCookieHeader(getSessionRuntime().sessionCookie(sessionId).split(';', 1)[0] ?? '') : {} }
    const responseCookies: string[] = []
    return requests.run({ cookies, responseCookies }, () => context.run(() => callback(responseCookies)))
  }
  async function createUser(provider: typeof usersProvider, password: string, email: string): Promise<string | number> {
    const digest = await hashPassword(password)
    const user = await provider.create({ name: 'Ava', email, password: options.customPasswordAttribute ? `stored:${digest}` : digest })
    return provider.getId(user)
  }
  return { ...persistence, store, users, admins, context, request, createUser }
}

afterEach(() => {
  resetAuthRuntime()
  resetSessionRuntime()
})

describe('currentPassword validation with native auth persistence', () => {
  it('checks the authenticated user without exposing hashes, rehashing, rotating or changing session data', async () => {
    const runtime = await setup()
    const userId = await runtime.createUser(runtime.users, 'current-secret', 'ava@example.com')
    const sessionId = await runtime.request(undefined, async () => {
      await auth.loginUsingId(userId)
      return runtime.context.getSessionId('web')
    })
    expect(sessionId).toBeDefined()
    const contract = schema({ credential: field.string().required().currentPassword() })
    const before = await getSessionRuntime().read(sessionId!)
    await runtime.request(sessionId, async (cookies) => {
      expect(await auth.user()).not.toHaveProperty('password')
      await expect(validate({ credential: 'current-secret' }, contract)).resolves.toEqual({ credential: 'current-secret' })
      const result = await safeParse({ credential: 'wrong-secret' }, contract)
      expect(result.valid).toBe(false)
      expect(result.errors.get('credential')).toEqual(['The password is incorrect.'])
      expect(await auth.id()).toBe(userId)
      expect(runtime.context.getSessionId('web')).toBe(sessionId)
      expect(cookies).toEqual([])
    })
    expect((await getSessionRuntime().read(sessionId!))?.data).toEqual(before?.data)
    expect(await runtime.store.countRecords()).toBe(1)
  })

  it('isolates the default and named guards even when their provider user ids overlap', async () => {
    const runtime = await setup()
    const userId = await runtime.createUser(runtime.users, 'user-secret', 'ava@example.com')
    const adminId = await runtime.createUser(runtime.admins, 'admin-secret', 'admin@example.com')
    const sessionId = await runtime.request(undefined, async () => {
      await auth.loginUsingId(userId)
      await auth.guard('admin').loginUsingId(adminId)
      return runtime.context.getSessionId('web')
    })
    const contract = schema({
      userCredential: field.password().currentPassword(),
      adminCredential: field.password().currentPassword('admin', 'The admin password is incorrect.'),
    })
    await runtime.request(sessionId, async () => {
      expect((await safeParse({ userCredential: 'user-secret', adminCredential: 'admin-secret' }, contract)).valid).toBe(true)
      const failure = await safeParse({ userCredential: 'admin-secret', adminCredential: 'user-secret' }, contract)
      expect(failure.valid).toBe(false)
      expect(failure.errors.flatten()).toEqual({
        userCredential: ['The password is incorrect.'],
        adminCredential: ['The admin password is incorrect.'],
      })
      expect(await auth.id()).toBe(userId)
      expect(await auth.guard('admin').id()).toBe(adminId)
    })
  })

  it('rejects unauthenticated requests and keeps concurrent request identities separate', async () => {
    const runtime = await setup()
    const contract = schema({ credential: field.password().currentPassword() })
    const sessions = await Promise.all(['first', 'second'].map(async (name) => {
      const userId = await runtime.createUser(runtime.users, `${name}-secret`, `${name}@example.com`)
      return runtime.request(undefined, async () => {
        await auth.loginUsingId(userId)
        return runtime.context.getSessionId('web')
      })
    }))
    await Promise.all(sessions.map((sessionId, index) => runtime.request(sessionId, async () => {
      const own = index === 0 ? 'first-secret' : 'second-secret'
      const other = index === 0 ? 'second-secret' : 'first-secret'
      expect((await safeParse({ credential: own }, contract)).valid).toBe(true)
      expect((await safeParse({ credential: other }, contract)).valid).toBe(false)
    })))
    await runtime.request(undefined, async (cookies) => {
      expect((await safeParse({ credential: 'first-secret' }, contract)).valid).toBe(false)
      expect(await auth.user()).toBeNull()
      expect(cookies).toEqual([])
    })
    expect(await runtime.store.countRecords()).toBe(2)
  })

  it('uses custom provider password access and the configured hasher without rehashing', async () => {
    const hasher: AuthPasswordHasher = {
      async hash(value) { return createHash('sha256').update(value).digest('hex') },
      async verify(value, digest) { return await this.hash(value) === digest },
      needsRehash() { return true },
    }
    const runtime = await setup({ passwordHasher: hasher, customPasswordAttribute: true })
    const userId = await runtime.createUser(runtime.users, 'custom-secret', 'ava@example.com')
    await runtime.request(undefined, async () => {
      await auth.loginUsingId(userId)
      const contract = schema({ credential: field.password().currentPassword() })
      expect((await safeParse({ credential: 'custom-secret' }, contract)).valid).toBe(true)
      expect((await safeParse({ credential: 'wrong-secret' }, contract)).valid).toBe(false)
      const persisted = await runtime.users.findById(userId)
      expect(runtime.users.getPasswordHash?.(persisted)).toBe(`stored:${await hasher.hash('custom-secret')}`)
    })
  })

  it('checks remembered users without creating sessions and leaves ordinary remember restoration available', async () => {
    const runtime = await setup()
    const userId = await runtime.createUser(runtime.users, 'remembered-secret', 'ava@example.com')
    const rememberCookie = await runtime.request(undefined, async (cookies) => {
      await auth.loginUsingId(userId, { remember: true })
      return cookies.flatMap(cookie => Object.entries(parseCookieHeader(cookie.split(';', 1)[0] ?? '')))
        .find(([name]) => name === 'holo_session_remember')?.[1]
    })
    expect(rememberCookie).toBeDefined()
    const contract = schema({ credential: field.password().currentPassword() })
    await runtime.request(undefined, async (cookies) => {
      expect((await safeParse({ credential: 'wrong-secret' }, contract)).valid).toBe(false)
      expect((await safeParse({ credential: 'remembered-secret' }, contract)).valid).toBe(true)
      expect(runtime.context.getSessionId('web')).toBeUndefined()
      expect(await runtime.store.countRecords()).toBe(1)
      expect(cookies).toEqual([])
      expect(await auth.id()).toBe(userId)
      expect(runtime.context.getSessionId('web')).toBeDefined()
      expect(cookies.length).toBeGreaterThan(0)
    }, { holo_session_remember: rememberCookie! })
  })

  it('checks the original impersonation user on the first attempt when the target is deleted', async () => {
    const runtime = await setup()
    const actorId = await runtime.createUser(runtime.users, 'actor-secret', 'actor@example.com')
    const targetId = await runtime.createUser(runtime.users, 'target-secret', 'target@example.com')
    await runtime.request(undefined, async () => {
      await auth.loginUsingId(actorId)
      await auth.impersonateById(targetId)
      const sessionId = runtime.context.getSessionId('web')!
      const before = await getSessionRuntime().read(sessionId)
      await runtime.db.table('users').where('id', targetId).delete()
      const contract = schema({ credential: field.password().currentPassword() })
      expect((await safeParse({ credential: 'actor-secret' }, contract)).valid).toBe(true)
      expect((await safeParse({ credential: 'target-secret' }, contract)).valid).toBe(false)
      expect((await getSessionRuntime().read(sessionId))?.data).toEqual(before?.data)
      expect(await auth.refreshUser()).toMatchObject({ id: actorId })
      expect(await auth.id()).toBe(actorId)
    })
  })

  it('uses the latest password and rejects passwordless and deleted users without creating sessions', async () => {
    const runtime = await setup()
    const userId = await runtime.createUser(runtime.users, 'old-secret', 'ava@example.com')
    await runtime.request(undefined, async () => {
      await auth.loginUsingId(userId)
      const contract = schema({ credential: field.password().currentPassword() })
      await auth.user()
      await runtime.db.table('users').where('id', userId).update({ password: await hashPassword('new-secret') })
      expect((await safeParse({ credential: 'old-secret' }, contract)).valid).toBe(false)
      expect((await safeParse({ credential: 'new-secret' }, contract)).valid).toBe(true)
      await runtime.db.table('users').where('id', userId).update({ password: null })
      expect((await safeParse({ credential: 'new-secret' }, contract)).valid).toBe(false)
      await runtime.db.table('users').where('id', userId).delete()
      expect((await safeParse({ credential: 'new-secret' }, contract)).valid).toBe(false)
      expect(await auth.id()).toBe(userId)
      expect(await auth.refreshUser()).toBeNull()
    })
    expect(await runtime.store.countRecords()).toBe(0)
  })

  it('supports token guards and rejects credentials for another provider', async () => {
    const runtime = await setup()
    const userId = await runtime.createUser(runtime.users, 'token-secret', 'ava@example.com')
    const nativeUser = await runtime.users.findById(userId)
    const token = await auth.tokens.create(nativeUser, { name: 'test', guard: 'api' })
    const adminId = await runtime.createUser(runtime.admins, 'admin-secret', 'admin@example.com')
    const admin = await runtime.admins.findById(adminId)
    const adminToken = await auth.tokens.create(admin, { name: 'admin-test', guard: 'admin' })
    await runtime.request(undefined, async () => {
      runtime.context.setAccessToken?.('api', token.plainTextToken)
      const contract = schema({ credential: field.password().currentPassword('api') })
      const before = await runtime.tokens.findById(token.id)
      expect((await safeParse({ credential: 'token-secret' }, contract)).valid).toBe(true)
      expect((await safeParse({ credential: 'wrong-secret' }, contract)).valid).toBe(false)
      expect(await runtime.tokens.findById(token.id)).toEqual(before)
      expect(await auth.user()).toBeNull()
      expect(await auth.guard('api').id()).toBe(userId)
      expect(runtime.context.getSessionId('web')).toBeUndefined()
      runtime.context.setAccessToken?.('api', adminToken.plainTextToken)
      expect((await safeParse({ credential: 'admin-secret' }, contract)).valid).toBe(false)
    })
    expect(await runtime.store.countRecords()).toBe(0)
  })

  it('enforces restored rule metadata and redacts custom field names from thrown failures', async () => {
    const runtime = await setup()
    const original = field.string().currentPassword()
    const restored: FieldBuilderInput<string> = { field: JSON.parse(JSON.stringify(original.field)) as ValidationField<string> }
    const contract = schema({ security: { credential: restored } })
    await runtime.request(undefined, async () => {
      const failure = await validate({ security: { credential: 'do-not-flash' } }, contract).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ValidationException)
      expect(failure).toMatchObject({
        values: { security: {} },
      })
      expect(JSON.stringify(failure)).not.toContain('do-not-flash')
    })
  })
})
