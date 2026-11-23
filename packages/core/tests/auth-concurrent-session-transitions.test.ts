import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthMultiFactorCredentialRecord, type AuthMultiFactorStore, type AuthProviderAdapter, type AuthSessionRevocationStore } from '../../auth/src'
import { configureSecurityRuntime, createMemoryRateLimitStore, resetSecurityRuntime } from '@holo-js/security'
import { configureSessionRuntime, getSessionRuntime, parseCookieHeader, resetSessionRuntime, type SessionStore } from '@holo-js/session'
import { sessionStoreFactories } from './support/session-stores'

type StoredUser = { id: number, email: string, password: null, remember_token: string | null }

const rememberTokenUpdateFailures: Error[] = []

const users = new Map<number, StoredUser>([1, 2, 3].map(id => [id, { id, email: `user-${id}@app.test`, password: null, remember_token: null }]))

const provider: AuthProviderAdapter<StoredUser> = {
  async create() { throw new Error('Users are seeded.') },
  async findByCredentials() { return null },
  async findById(id) {
    const user = users.get(Number(id))
    return user ? { ...user } : null
  },
  getId(user) { return user.id },
  getPasswordHash(user) { return user.password },
  getRememberToken(user) { return user.remember_token },
  async updateRememberToken(user, token) {
    const failure = rememberTokenUpdateFailures.shift()
    if (failure) throw failure
    users.set(user.id, { ...users.get(user.id)!, remember_token: token })
  },
  serialize(user) { return { id: user.id, email: user.email } },
}

const multiFactorCredentials = new Map<string, AuthMultiFactorCredentialRecord>()

const credentialKey = (provider: string, userId: string | number): string => `${provider}:${userId}`

const memoryMultiFactorCredentials: AuthMultiFactorStore = {
  async find(provider, userId) { return multiFactorCredentials.get(credentialKey(provider, userId)) ?? null },
  async save(record) { multiFactorCredentials.set(credentialKey(record.provider, record.userId), record) },
  async delete(provider, userId) { multiFactorCredentials.delete(credentialKey(provider, userId)) },
  async advanceCounter(provider, userId, counter) {
    const credential = multiFactorCredentials.get(credentialKey(provider, userId))
    if (!credential || (credential.lastUsedCounter !== null && credential.lastUsedCounter >= counter)) return null
    multiFactorCredentials.set(credentialKey(provider, userId), { ...credential, lastUsedCounter: counter })
    return { lastUsedCounter: counter, recoveryCodeHashes: credential.recoveryCodeHashes }
  },
  async consumeRecoveryCode() { return null },
  async replaceRecoveryCodes() { return false },
}

const TOTP_PERIOD_MS = 30_000

function freezeClockInsideTotpWindow(): number {
  const counter = Math.floor(Date.now() / TOTP_PERIOD_MS)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(counter * TOTP_PERIOD_MS + TOTP_PERIOD_MS / 2)
  onTestFinished(() => {
    vi.useRealTimers()
  })
  return counter
}

const revokedUserIds = new Set<number>()

const sessionRevocations: AuthSessionRevocationStore = {
  async readMany(identities) {
    return identities.map(identity => ({ ...identity, generation: revokedUserIds.has(Number(identity.userId)) ? 1 : 0 }))
  },
  async revokeOthers() { return true },
}

type WriteGate = {
  readonly store: SessionStore
  readonly reached: Promise<void>
  release(): void
}

function holdFirstWrites(store: SessionStore, count: number): WriteGate {
  let held = 0
  let reachedAll!: () => void
  let release!: () => void
  const reached = new Promise<void>(resolve => { reachedAll = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const hold = async (): Promise<void> => {
    if (held >= count) return
    held += 1
    if (held === count) reachedAll()
    await released
  }
  return {
    store: {
      ...store,
      write: async (record) => {
        await hold()
        await store.write(record)
      },
      ...(store.updateData ? {
        updateData: async (sessionId, key, update) => {
          await hold()
          return store.updateData!(sessionId, key, update)
        },
      } : {}),
      ...(store.rotate ? {
        rotate: async (previousSessionId, record, update) => {
          await hold()
          return store.rotate!(previousSessionId, record, update)
        },
      } : {}),
    },
    reached,
    release,
  }
}

const requestCookies = new AsyncLocalStorage<ReadonlyMap<string, string>>()
const browserCookies = new Map<string, string>()

function receive(setCookie: string): void {
  const [pair] = setCookie.split(';', 1)
  const [name, value] = Object.entries(parseCookieHeader(pair!))[0]!
  if (!value || /max-age=0/i.test(setCookie)) browserCookies.delete(name)
  else browserCookies.set(name, value)
}

const context = createAsyncAuthContext()

function configure(store: SessionStore): void {
  configureSessionRuntime({
    appKey: 'concurrent-session-app-key',
    config: {
      driver: 'file',
      stores: { file: { driver: 'file', name: 'file', path: './sessions' } },
      cookie: { name: 'holo_session', path: '/', secure: false, httpOnly: true, sameSite: 'lax', partitioned: false, maxAge: 120 },
      idleTimeout: 120,
      absoluteLifetime: 120,
      rememberMeLifetime: 43200,
    },
    stores: { file: store },
  })
  configureAuthRuntime({
    config: {
      defaults: { guard: 'web' },
      guards: {
        web: { driver: 'session', provider: 'users' },
        admin: { driver: 'session', provider: 'users' },
        support: { driver: 'session', provider: 'users' },
      },
      providers: { users: { model: 'User' } },
      multiFactor: true,
    },
    providers: { users: provider },
    multiFactor: memoryMultiFactorCredentials,
    multiFactorEncryptionKey: 'concurrent-session-multi-factor-key',
    sessionRevocations,
    context: {
      ...context,
      getRequestCookie: name => requestCookies.getStore()?.get(name),
      appendResponseCookie: receive,
    },
    session: getSessionRuntime(),
  })
}

async function browserSessionData(store: SessionStore): Promise<Readonly<Record<string, unknown>>> {
  const sessionId = getSessionRuntime().decryptCookie('holo_session', browserCookies.get('holo_session')!)
  return (await store.read(sessionId!))?.data ?? {}
}

async function signedInBrowser(create: () => Promise<SessionStore>) {
  const store = await create()
  configure(store)
  const request = <TValue>(callback: () => Promise<TValue>): Promise<TValue> => requestCookies.run(new Map(browserCookies), () => context.run(callback))
  await request(() => auth.guard('admin').loginUsingId(1))
  await request(() => auth.guard('support').loginUsingId(3))
  const concurrently = async (...callbacks: ReadonlyArray<() => Promise<unknown>>): Promise<void> => {
    const overlapping = holdFirstWrites(store, callbacks.length)
    configure(overlapping.store)
    const requests = callbacks.map(callback => request(callback))
    await overlapping.reached
    overlapping.release()
    await Promise.all(requests)
  }
  return { store, request, concurrently }
}

afterEach(() => {
  browserCookies.clear()
  revokedUserIds.clear()
  multiFactorCredentials.clear()
  resetSecurityRuntime()
  resetAuthRuntime()
  resetSessionRuntime()
})

describe.each(sessionStoreFactories)('concurrent authenticated session transitions on the $name session store', ({ create }) => {
  it('keeps both changes when one guard stops impersonating while another logs out', async () => {
    const { request, concurrently } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(3))
    await request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await concurrently(
      () => auth.guard('web').stopImpersonating(),
      () => auth.guard('support').logout(),
    )

    await expect(request(() => auth.guard('web').impersonation())).resolves.toBeNull()
    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 3 })
    await expect(request(() => auth.guard('support').user())).resolves.toBeNull()
    await expect(request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('keeps a session key another request stores while a guard logs out', async () => {
    const { store, request } = await signedInBrowser(create)
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)
    const sessionId = getSessionRuntime().decryptCookie('holo_session', browserCookies.get('holo_session')!)!

    const logout = request(() => auth.guard('support').logout())
    await gate.reached
    await getSessionRuntime().setDataIfAbsent(sessionId, '_token', 'csrf-token')
    gate.release()
    await logout

    await expect(browserSessionData(store)).resolves.toMatchObject({ _token: 'csrf-token' })
    await expect(request(() => auth.guard('support').user())).resolves.toBeNull()
    await expect(request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('keeps both pending multi-factor enrollments started at the same time on different guards', async () => {
    const { store, concurrently } = await signedInBrowser(create)

    await concurrently(
      () => auth.guard('admin').multiFactor.beginEnrollment(),
      () => auth.guard('support').multiFactor.beginEnrollment(),
    )

    expect(Object.keys((await browserSessionData(store)).authMultiFactorEnrollments as Record<string, string>).sort()).toEqual(['admin', 'support'])
  })

  it('keeps a guard signed out when it logs out while its impersonation is being stopped', async () => {
    const { store, request } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(3))
    await request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    const stopping = request(() => auth.guard('web').stopImpersonating())
    await gate.reached
    await request(() => auth.guard('web').logout())
    gate.release()

    await expect(stopping).resolves.toBeNull()
    await expect(request(() => auth.guard('web').user())).resolves.toBeNull()
    await expect(request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('cycles the remember token of the user a logout removes when impersonation stops first', async () => {
    const { store, request } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(3))
    await request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))
    users.set(1, { ...users.get(1)!, remember_token: 'actor-token' })
    users.set(3, { ...users.get(3)!, remember_token: 'original-token' })
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    const logout = request(() => auth.guard('web').logout())
    await gate.reached
    await request(() => auth.guard('web').stopImpersonating())
    gate.release()
    await logout

    expect(users.get(1)?.remember_token).toBe('actor-token')
    expect(users.get(3)?.remember_token).not.toBe('original-token')
  })

  it('keeps an identity restored while another request removes the revoked payload it replaced', async () => {
    const { store, request } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(3))
    await request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    revokedUserIds.add(2)
    const revokedRead = request(() => auth.guard('web').user())
    await gate.reached
    revokedUserIds.delete(2)
    await request(() => auth.guard('web').stopImpersonating())
    gate.release()
    await revokedRead

    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 3 })
  })

  it('rejects a multi-factor enrollment whose session ends before it is stored', async () => {
    const { store, request } = await signedInBrowser(create)
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)
    const sessionId = getSessionRuntime().decryptCookie('holo_session', browserCookies.get('holo_session')!)!

    const enrollment = request(() => auth.guard('admin').multiFactor.beginEnrollment())
    await gate.reached
    await store.delete(sessionId)
    gate.release()

    await expect(enrollment).rejects.toMatchObject({ code: 'multi_factor_authentication_required' })
  })

  it('keeps a guard signed out when it logs out while another guard logs in', async () => {
    const { store, request } = await signedInBrowser(create)
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    const login = request(() => auth.guard('web').loginUsingId(2))
    await gate.reached
    await request(() => auth.guard('support').logout())
    gate.release()
    await login

    await expect(request(() => auth.guard('support').user())).resolves.toBeNull()
    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 2 })
    await expect(request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('keeps the CSRF token and a pending multi-factor enrollment stored while a guard logs in', async () => {
    const { store, request } = await signedInBrowser(create)
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)
    const sessionId = getSessionRuntime().decryptCookie('holo_session', browserCookies.get('holo_session')!)!

    const login = request(() => auth.guard('web').loginUsingId(2))
    await gate.reached
    await getSessionRuntime().setDataIfAbsent(sessionId, '_token', 'csrf-token')
    await request(() => auth.guard('admin').multiFactor.beginEnrollment())
    gate.release()
    await login

    await expect(browserSessionData(store)).resolves.toMatchObject({
      _token: 'csrf-token',
      authMultiFactorEnrollments: { admin: expect.any(String) },
    })
    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 2 })
  })

  it('keeps a stopped impersonation stopped when another guard logs in meanwhile', async () => {
    const { store, request } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(3))
    await request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    const login = request(() => auth.guard('support').loginUsingId(1))
    await gate.reached
    await request(() => auth.guard('web').stopImpersonating())
    gate.release()
    await login

    await expect(request(() => auth.guard('web').impersonation())).resolves.toBeNull()
    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 3 })
    await expect(request(() => auth.guard('support').user())).resolves.toMatchObject({ id: 1 })
  })

  it('keeps a guard signed out when it logs out while another guard completes a multi-factor challenge', async () => {
    const counter = freezeClockInsideTotpWindow()
    configureSecurityRuntime({ config: {}, csrfSigningKey: 'concurrent-session-signing-key', rateLimitStore: createMemoryRateLimitStore() })
    const { store, request } = await signedInBrowser(create)
    await request(() => auth.guard('web').loginUsingId(2))
    const enrollment = await request(() => auth.guard('web').multiFactor.beginEnrollment())
    await request(() => auth.guard('web').multiFactor.confirmEnrollment({ code: authRuntimeInternals.multiFactor.totpAtCounter(enrollment.manualKey, counter - 1) }))
    await request(() => auth.guard('web').logout())
    await request(() => auth.guard('web').loginUsingId(2))
    const gate = holdFirstWrites(store, 1)
    configure(gate.store)

    const completion = request(() => auth.guard('web').multiFactor.challenge({ code: authRuntimeInternals.multiFactor.totpAtCounter(enrollment.manualKey, counter) }))
    await gate.reached
    await request(() => auth.guard('support').logout())
    gate.release()
    await completion

    await expect(request(() => auth.guard('support').user())).resolves.toBeNull()
    await expect(request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 2 })
    await expect(request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('invalidates the session when the last guard logs out', async () => {
    const { store, request } = await signedInBrowser(create)
    const sessionId = getSessionRuntime().decryptCookie('holo_session', browserCookies.get('holo_session')!)!

    await request(() => auth.guard('admin').logout())
    await expect(request(() => auth.guard('support').user())).resolves.toMatchObject({ id: 3 })
    await request(() => auth.guard('support').logout())

    await expect(store.read(sessionId)).resolves.toBeNull()
  })
})

describe('a session store without atomic data updates', () => {
  it('fails the guard logout and leaves the session unchanged', async () => {
    const [file] = sessionStoreFactories
    const { store, request } = await signedInBrowser(file.create)
    const { updateData: _updateData, ...withoutUpdateData } = store
    configure(withoutUpdateData)
    users.set(3, { ...users.get(3)!, remember_token: 'remember-token' })
    const before = await browserSessionData(store)

    await expect(request(() => auth.guard('support').logout())).rejects.toThrow('Session store "file" does not support atomic data writes.')

    await expect(browserSessionData(store)).resolves.toEqual(before)
    expect(users.get(3)?.remember_token).toBe('remember-token')
  })
})

describe('a session that ends while a Redis logout update runs', () => {
  it('leaves the remember token unchanged', async () => {
    const redis = sessionStoreFactories.find(factory => factory.name === 'redis')!
    const { store, request } = await signedInBrowser(redis.create)
    users.set(3, { ...users.get(3)!, remember_token: 'remember-token' })
    configure({
      ...store,
      updateData: (sessionId, key, update) => store.updateData!(sessionId, key, (current) => {
        void store.delete(sessionId)
        return update(current)
      }),
    })

    await request(() => auth.guard('support').logout())

    expect(users.get(3)?.remember_token).toBe('remember-token')
  })
})

describe('a logout whose remember token update fails', () => {
  it('cycles the remember token when the logout is retried', async () => {
    const [file] = sessionStoreFactories
    const { request } = await signedInBrowser(file.create)
    await request(() => auth.guard('support').loginUsingId(3, { remember: true }))
    const rememberToken = users.get(3)?.remember_token
    expect(rememberToken).toEqual(expect.any(String))
    rememberTokenUpdateFailures.push(new Error('users table unavailable'))

    await expect(request(() => auth.guard('support').logout())).rejects.toThrow('users table unavailable')
    await request(() => auth.guard('support').logout())

    expect(users.get(3)?.remember_token).not.toBe(rememberToken)
    await expect(request(() => auth.guard('support').user())).resolves.toBeNull()
  })
})
