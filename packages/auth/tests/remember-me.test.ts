import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthenticatedAuthUser, type AuthProviderAdapter, type AuthSessionRevocationStore } from '../src'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, normalizeSessionConfig, parseCookieHeader, resetSessionRuntime } from '../../session/src'

type StoredUser = {
  id: number
  email: string
  password: string | null
  remember_token: string | null
}

const users = new Map<number, StoredUser>()
const provider: AuthProviderAdapter<StoredUser> = {
  async create(input) {
    const user = { id: users.size + 1, email: String(input.email), password: null, remember_token: null }
    users.set(user.id, user)
    return { ...user }
  },
  async findByCredentials() { return null },
  async findById(id) {
    const user = users.get(Number(id))
    return user ? { ...user } : null
  },
  getId(user) { return user.id },
  getPasswordHash(user) { return user.password },
  getRememberToken(user) { return user.remember_token },
  async updateRememberToken(user, token) {
    users.set(user.id, { ...users.get(user.id)!, remember_token: token })
  },
  serialize(user) { return { id: user.id, email: user.email } },
}

const appKey = 'remember-me-app-key'
let directory: string

class Browser {
  readonly cookies = new Map<string, string>()

  async request<TValue>(callback: () => Promise<TValue>, bindings: Partial<Parameters<typeof configureAuthRuntime>[0]> = {}, scoped: boolean | 'unscoped' = true): Promise<TValue> {
    const current = authRuntimeInternals.getRuntimeBindings()
    const requestCookies = new Map(this.cookies)
    const requestContext = createAsyncAuthContext()
    const memoryContext = authRuntimeInternals.createMemoryAuthContext()
    const context = {
      ...(scoped === true ? requestContext : scoped === false ? { ...memoryContext, getRequestScope: () => memoryContext } : memoryContext),
      getRequestCookie: (name: string) => requestCookies.get(name),
      appendResponseCookie: (setCookie: string) => this.receive(setCookie),
    }
    authRuntimeInternals.configureRuntime({ ...current, ...bindings, context })
    try {
      return await requestContext.run(callback)
    } finally {
      authRuntimeInternals.configureRuntime(current)
    }
  }

  receive(setCookie: string): void {
    const [pair] = setCookie.split(';', 1)
    const [name, value] = Object.entries(parseCookieHeader(pair!))[0]!
    if (!value || /max-age=0/i.test(setCookie)) this.cookies.delete(name)
    else this.cookies.set(name, value)
  }

  expireSession(): void {
    this.cookies.delete('holo_session')
  }
}

async function sessionFileCount(): Promise<number> {
  return (await readdir(directory)).filter(name => name.endsWith('.json')).length
}

function decryptRemember(browser: Browser): unknown {
  const value = browser.cookies.get('holo_session_remember')
  return value ? JSON.parse(getSessionRuntime().decryptCookie('holo_session_remember', value)!) : undefined
}

beforeEach(async () => {
  users.clear()
  users.set(1, { id: 1, email: 'ava@app.test', password: 'scrypt$hash-one', remember_token: null })
  directory = await mkdtemp(join(tmpdir(), 'auth-remember-me-'))
  configureSessionRuntime({
    appKey,
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: directory } }, idleTimeout: 120, absoluteLifetime: 120, rememberMeLifetime: 43200 }),
    stores: { file: createFileSessionStore(directory) },
  })
  configureAuthRuntime({
    config: {
      defaults: { guard: 'web' },
      guards: { web: { driver: 'session', provider: 'users' }, admin: { driver: 'session', provider: 'users' } },
      providers: { users: { model: 'User' } },
    },
    providers: { users: provider },
    context: authRuntimeInternals.createMemoryAuthContext(),
    session: getSessionRuntime(),
  })
})

afterEach(async () => {
  vi.useRealTimers()
  resetAuthRuntime()
  resetSessionRuntime()
  await rm(directory, { recursive: true, force: true })
})

describe('remember me', () => {
  it('stores a per-user remember token and keeps it on the next remembered login', async () => {
    const laptop = new Browser()
    const phone = new Browser()
    await laptop.request(() => auth.loginUsingId(1, { remember: true }))
    const token = users.get(1)?.remember_token
    expect(token).toEqual(expect.any(String))
    expect(token!.length).toBeGreaterThanOrEqual(40)

    await phone.request(() => auth.loginUsingId(1, { remember: true }))
    expect(users.get(1)?.remember_token).toBe(token)
  })

  it('carries the user identifier, token, and password hash in the encrypted remember cookie', async () => {
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))

    const stored = users.get(1)!
    expect(browser.cookies.get('holo_session_remember')).not.toContain(stored.remember_token!)
    expect(decryptRemember(browser)).toEqual({
      web: [1, stored.remember_token, expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Number)],
    })
  })

  it('restores a remembered user after the browser session expires and within the remember lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const browser = new Browser()
    const login = await browser.request(() => auth.loginUsingId(1, { remember: true }))

    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000)
    browser.expireSession()
    await expect(getSessionRuntime().read(login.sessionId)).resolves.toBeNull()

    await expect(browser.request(() => auth.user())).resolves.toMatchObject({ id: 1, email: 'ava@app.test' })
    const restoredSessionId = browser.cookies.get('holo_session')
    expect(restoredSessionId).toEqual(expect.any(String))
    const sessionOnly = new Browser()
    sessionOnly.cookies.set('holo_session', restoredSessionId!)
    await expect(sessionOnly.request(() => auth.check())).resolves.toBe(true)
  })

  it.each([
    { elapsed: 43200 * 60_000 - 1, restored: true },
    { elapsed: 43200 * 60_000, restored: false },
    { elapsed: 43200 * 60_000 + 1, restored: false },
  ])('enforces the remember lifetime on replayed cookies after $elapsed milliseconds', async ({ elapsed, restored }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const issuedAt = Date.now()
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    browser.expireSession()

    vi.setSystemTime(issuedAt + elapsed)
    await expect(browser.request(() => auth.check())).resolves.toBe(restored)
  })

  it('authenticates the remember expiry and rejects a plaintext extension', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    const payload = decryptRemember(browser) as { web: [number, string, string, number] }
    expect(payload.web[3]).toBe(Date.now() + 43200 * 60_000)
    payload.web[3] += 60_000
    browser.cookies.set('holo_session_remember', JSON.stringify(payload))
    browser.expireSession()

    await expect(browser.request(() => auth.check())).resolves.toBe(false)
  })

  it('restores a remembered user when the session cookie points at an expired session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    const expiredSessionCookie = browser.cookies.get('holo_session')

    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000)
    await expect(browser.request(() => auth.check())).resolves.toBe(true)
    expect(browser.cookies.get('holo_session')).not.toBe(expiredSessionCookie)
  })

  it('rejects a remember cookie whose token or password hash no longer matches', async () => {
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    browser.expireSession()

    users.set(1, { ...users.get(1)!, remember_token: 'a-different-token-value-from-another-cycle' })
    await expect(browser.request(() => auth.check())).resolves.toBe(false)

    const other = new Browser()
    await other.request(() => auth.loginUsingId(1, { remember: true }))
    other.expireSession()
    users.set(1, { ...users.get(1)!, password: 'scrypt$hash-two' })
    await expect(other.request(() => auth.check())).resolves.toBe(false)
  })

  it('does not restore a remember entry written for another guard', async () => {
    const browser = new Browser()
    await browser.request(() => auth.guard('admin').loginUsingId(1, { remember: true }))
    browser.expireSession()

    await expect(browser.request(() => auth.check())).resolves.toBe(false)
    await expect(browser.request(() => auth.guard('admin').check())).resolves.toBe(true)
  })

  it('keeps remember entries for several guards in one browser', async () => {
    const browser = new Browser()
    await browser.request(async () => {
      await auth.loginUsingId(1, { remember: true })
      await auth.guard('admin').loginUsingId(1, { remember: true })
    })
    browser.expireSession()

    await expect(browser.request(async () => [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
  })

  it.each([true, false])('keeps a remember entry cleared earlier in the same request out of later cookies (async context: %s)', async (scoped) => {
    users.set(2, { id: 2, email: 'mina@app.test', password: 'scrypt$hash-two', remember_token: null })
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))

    await browser.request(async () => {
      await auth.loginUsingId(2)
      await auth.guard('admin').loginUsingId(2, { remember: true })
    }, {}, scoped)

    expect(decryptRemember(browser)).toEqual({ admin: [2, expect.any(String), expect.any(String), expect.any(Number)] })
    browser.expireSession()
    await expect(browser.request(() => auth.check())).resolves.toBe(false)
  })

  it('preserves a built-in async request scope across separately loaded auth modules', async () => {
    vi.resetModules()
    const reloaded = await import('../src')
    const requestContext = reloaded.createAsyncAuthContext()
    const browser = new Browser()
    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      context: {
        ...requestContext,
        getRequestCookie: (name: string) => browser.cookies.get(name),
        appendResponseCookie: (cookie: string) => browser.receive(cookie),
      },
    })

    await requestContext.run(() => auth.loginUsingId(1, { remember: true }))
    browser.expireSession()
    await expect(requestContext.run(() => auth.check())).resolves.toBe(true)
  })

  it.each([{ scoped: true, accessor: 'none' }, { scoped: true, accessor: 'getter' }, { scoped: true, accessor: 'setter' }, { scoped: false, accessor: 'none' }])('restores guards across requests in a custom context (scope: $scoped, accessor: $accessor)', async ({ scoped, accessor }) => {
    const browser = new Browser()
    const storage = new AsyncLocalStorage<ReturnType<typeof authRuntimeInternals.createMemoryAuthContext>>()
    const current = () => storage.getStore()!
    const context = {
      ...(scoped ? { getRequestScope: () => current() } : {}),
      ...(accessor === 'getter' ? { getRememberToken: (guard: string) => current().getRememberToken(guard) } : {}),
      ...(accessor === 'setter' ? { setRememberToken: (guard: string, token?: string) => current().setRememberToken(guard, token) } : {}),
      getSessionId: (guard: string) => current().getSessionId(guard),
      setSessionId: (guard: string, id?: string) => current().setSessionId(guard, id),
      getCachedUser: (guard: string) => current().getCachedUser(guard),
      setCachedUser: (guard: string, user: AuthenticatedAuthUser | null) => current().setCachedUser(guard, user),
      getRequestCookie: (name: string) => browser.cookies.get(name),
      appendResponseCookie: (cookie: string) => browser.receive(cookie),
    }
    if (!scoped) {
      await browser.request(async () => {
        await auth.loginUsingId(1, { remember: true })
        await auth.guard('admin').loginUsingId(1, { remember: true })
      })
    }
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), context })
    const request = <T,>(callback: () => Promise<T>) => storage.run(authRuntimeInternals.createMemoryAuthContext(), callback)
    if (scoped) {
      await request(async () => {
        await auth.loginUsingId(1, { remember: true })
        await auth.guard('admin').loginUsingId(1, { remember: true })
      })
    }
    browser.expireSession()

    await expect(request(async () => scoped
      ? Promise.all([auth.check(), auth.guard('admin').check()])
      : [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
    browser.cookies.delete('holo_session_remember')
    await expect(request(async () => scoped
      ? Promise.all([auth.check(), auth.guard('admin').check()])
      : [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
  })

  it('restores once for concurrent checks in the same request', async () => {
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    browser.expireSession()
    const sessionsBefore = await sessionFileCount()

    await expect(browser.request(async () => {
      const first = auth.check()
      await new Promise(resolve => setImmediate(resolve))
      return Promise.all([first, auth.check(), auth.user()])
    })).resolves.toEqual([true, true, expect.objectContaining({ id: 1 })])
    expect(await sessionFileCount()).toBe(sessionsBefore + 1)
  })

  it('keeps the browser session intact when the restored session cookie cannot be sent', async () => {
    const browser = new Browser()
    await browser.request(() => auth.guard('admin').loginUsingId(1, { remember: true }))
    browser.expireSession()
    await browser.request(() => auth.loginUsingId(1))
    const liveSession = browser.cookies.get('holo_session')

    const readOnly = new Browser()
    for (const [name, value] of browser.cookies) readOnly.cookies.set(name, value)
    readOnly.receive = () => {}
    await expect(readOnly.request(() => auth.guard('admin').check())).resolves.toBe(true)

    const sessionOnly = new Browser()
    sessionOnly.cookies.set('holo_session', liveSession!)
    await expect(sessionOnly.request(() => auth.check())).resolves.toBe(true)
  })

  it('restores several guards into one session within a request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const browser = new Browser()
    await browser.request(async () => {
      await auth.loginUsingId(1, { remember: true })
      await auth.guard('admin').loginUsingId(1, { remember: true })
    })
    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000)

    await expect(browser.request(async () => [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
    browser.cookies.delete('holo_session_remember')
    await expect(browser.request(async () => [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
  })

  it('restores remember-cookie users without persisting sessions when the context has no response cookie writer', async () => {
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    browser.expireSession()
    const storage = new AsyncLocalStorage<ReturnType<typeof authRuntimeInternals.createMemoryAuthContext>>()
    const current = () => storage.getStore()!
    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      context: {
        getRequestScope: () => current(),
        getSessionId: (guard: string) => current().getSessionId(guard),
        setSessionId: (guard: string, id?: string) => current().setSessionId(guard, id),
        getCachedUser: (guard: string) => current().getCachedUser(guard),
        setCachedUser: (guard: string, user: AuthenticatedAuthUser | null) => current().setCachedUser(guard, user),
        getRememberToken: (guard: string) => current().getRememberToken(guard),
        setRememberToken: (guard: string, token?: string) => current().setRememberToken(guard, token),
        getRequestCookie: (name: string) => browser.cookies.get(name),
      },
    })
    const recordsBefore = await sessionFileCount()

    for (let request = 0; request < 3; request++) {
      await expect(storage.run(authRuntimeInternals.createMemoryAuthContext(), () => auth.check())).resolves.toBe(true)
    }

    expect(await sessionFileCount()).toBe(recordsBefore)
  })

  it('restores several guards checked concurrently into one session', async () => {
    const browser = new Browser()
    await browser.request(async () => {
      await auth.loginUsingId(1, { remember: true })
      await auth.guard('admin').loginUsingId(1, { remember: true })
    })
    browser.expireSession()

    await expect(browser.request(() => Promise.all([auth.check(), auth.guard('admin').check()]))).resolves.toEqual([true, true])
    browser.cookies.delete('holo_session_remember')
    await expect(browser.request(async () => [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])
  })

  it('creates exactly one restored session when several guards are restored in one request', async () => {
    const browser = new Browser()
    await browser.request(async () => {
      await auth.loginUsingId(1, { remember: true })
      await auth.guard('admin').loginUsingId(1, { remember: true })
    })
    browser.expireSession()
    const recordsBefore = await sessionFileCount()

    await expect(browser.request(async () => [await auth.check(), await auth.guard('admin').check()])).resolves.toEqual([true, true])

    expect(await sessionFileCount()).toBe(recordsBefore + 1)
  })

  it('keeps a pending multi-factor challenge session when another guard is restored', async () => {
    const browser = new Browser()
    await browser.request(() => auth.guard('admin').loginUsingId(1, { remember: true }))
    browser.expireSession()
    const challenge = await getSessionRuntime().create({
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          userId: 1,
          user: { id: 1, email: 'ava@app.test' },
          authenticatedAt: new Date().toISOString(),
          multiFactorChallengeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    })
    await getSessionRuntime().flash(challenge.id, 'challenge', true)
    browser.receive(getSessionRuntime().sessionCookie(challenge.id))
    const challengeCookie = browser.cookies.get('holo_session')

    await expect(browser.request(() => auth.guard('admin').check())).resolves.toBe(true)

    expect(browser.cookies.get('holo_session')).toBe(challengeCookie)
    await expect(getSessionRuntime().take(challenge.id, 'challenge')).resolves.toBe(true)
  })

  it.each([true, false])('keeps the browser on a pending multi-factor challenge when the restored guard logs out (async context: %s)', async (scoped) => {
    const browser = new Browser()
    await browser.request(() => auth.guard('admin').loginUsingId(1, { remember: true }))
    browser.expireSession()
    const challenge = await getSessionRuntime().create({
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          userId: 1,
          user: { id: 1, email: 'ava@app.test' },
          authenticatedAt: new Date().toISOString(),
          multiFactorChallengeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    })
    browser.receive(getSessionRuntime().sessionCookie(challenge.id))
    const challengeCookie = browser.cookies.get('holo_session')

    await browser.request(() => auth.guard('admin').logout(), {}, scoped)

    expect(browser.cookies.get('holo_session')).toBe(challengeCookie)
    await expect(getSessionRuntime().read(challenge.id)).resolves.toMatchObject({ id: challenge.id })
  })

  it('cycles the token on logout so every device loses remember-me while other active sessions remain', async () => {
    const laptop = new Browser()
    const phone = new Browser()
    await laptop.request(() => auth.loginUsingId(1, { remember: true }))
    await phone.request(() => auth.loginUsingId(1, { remember: true }))
    const token = users.get(1)?.remember_token

    await laptop.request(() => auth.logout())

    expect(users.get(1)?.remember_token).toEqual(expect.any(String))
    expect(users.get(1)?.remember_token).not.toBe(token)
    expect(laptop.cookies.has('holo_session_remember')).toBe(false)
    await expect(phone.request(() => auth.check())).resolves.toBe(true)

    phone.expireSession()
    await expect(phone.request(() => auth.check())).resolves.toBe(false)
  })

  it('does not create a remember token on logout for users who never chose remember me', async () => {
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1))
    await browser.request(() => auth.logout())

    expect(users.get(1)?.remember_token).toBeNull()
  })

  it('fails explicitly when the provider cannot store remember tokens', async () => {
    const { updateRememberToken: _omitted, ...withoutRemember } = provider
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), providers: { users: withoutRemember } })

    await expect(new Browser().request(() => auth.loginUsingId(1, { remember: true }))).rejects.toMatchObject({ code: 'runtime_unconfigured' })
  })

  it('keeps session records free of remember credentials', async () => {
    const browser = new Browser()
    const login = await browser.request(() => auth.loginUsingId(1, { remember: true }))

    expect(await getSessionRuntime().read(login.sessionId)).not.toHaveProperty('rememberTokenHash')
    expect(getSessionRuntime()).not.toHaveProperty('issueRememberMeToken')
    expect(getSessionRuntime()).not.toHaveProperty('consumeRememberMeToken')
  })
})

describe('remember me with other-device logout', () => {
  function revocationStore(): AuthSessionRevocationStore {
    const states = new Map<string, { generation: number, retainedSessionId?: string }>()
    return {
      async readMany(identities) {
        return identities.map(identity => ({ ...identity, generation: 0, ...states.get(`${identity.provider}:${identity.userId}`) }))
      },
      async revokeOthers(identity, current) {
        const key = `${identity.provider}:${identity.userId}`
        const state = states.get(key) ?? { generation: 0 }
        if (state.generation !== current.generation && state.retainedSessionId !== current.id) return false
        states.set(key, { generation: state.generation + 1, retainedSessionId: current.id })
        return true
      },
    }
  }

  it.each(['remember', 'switch', 'logout', 'renew'])('rejects unscoped remember-cookie writes before changing authentication (%s)', async (action) => {
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), sessionRevocations: revocationStore() })
    users.set(2, { id: 2, email: 'mina@app.test', password: 'scrypt$hash-two', remember_token: null })
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    const cookies = new Map(browser.cookies)
    const token = users.get(1)!.remember_token

    await expect(browser.request(async () => {
      if (action === 'remember') await auth.guard('admin').loginUsingId(2, { remember: true })
      if (action === 'switch') await auth.loginUsingId(2)
      if (action === 'logout') await auth.logout()
      if (action === 'renew') await auth.logoutOtherDevices()
    }, {}, 'unscoped')).rejects.toMatchObject({ code: 'runtime_unconfigured' })

    expect(browser.cookies).toEqual(cookies)
    expect(users.get(1)!.remember_token).toBe(token)
    await expect(browser.request(() => auth.user())).resolves.toMatchObject({ id: 1 })
  })

  it('cycles the token and re-issues the current browser remember cookie', async () => {
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), sessionRevocations: revocationStore() })
    const laptop = new Browser()
    const phone = new Browser()
    await laptop.request(() => auth.loginUsingId(1, { remember: true }))
    await phone.request(() => auth.loginUsingId(1, { remember: true }))
    const token = users.get(1)?.remember_token

    await laptop.request(() => auth.logoutOtherDevices())

    expect(users.get(1)?.remember_token).not.toBe(token)
    phone.expireSession()
    await expect(phone.request(() => auth.check())).resolves.toBe(false)
    laptop.expireSession()
    await expect(laptop.request(() => auth.check())).resolves.toBe(true)
  })

  it('preserves the actor remember entry after stopping impersonation and remembering another guard', async () => {
    users.set(2, { id: 2, email: 'mina@app.test', password: 'scrypt$hash-two', remember_token: null })
    const browser = new Browser()
    await browser.request(() => auth.loginUsingId(1, { remember: true }))
    await browser.request(async () => {
      await auth.impersonateById(2)
      await auth.stopImpersonating()
      await auth.guard('admin').loginUsingId(2, { remember: true })
    })

    browser.expireSession()
    await expect(browser.request(() => auth.user())).resolves.toMatchObject({ id: 1 })
  })

  it('leaves the impersonated user remember token and the actor cookie alone', async () => {
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), sessionRevocations: revocationStore() })
    users.set(2, { id: 2, email: 'mina@app.test', password: 'scrypt$hash-two', remember_token: 'mina-existing-remember-token-value' })
    const admin = new Browser()
    await admin.request(() => auth.loginUsingId(1, { remember: true }))
    const actorCookie = admin.cookies.get('holo_session_remember')

    await admin.request(async () => {
      await auth.impersonateById(2)
      await auth.logoutOtherDevices()
    })

    expect(users.get(2)?.remember_token).toBe('mina-existing-remember-token-value')
    expect(admin.cookies.get('holo_session_remember')).toBe(actorCookie)
  })

  it('rejects a remember cookie whose restoration read revocation state after another device cycled it', async () => {
    const states = revocationStore()
    authRuntimeInternals.configureRuntime({ ...authRuntimeInternals.getRuntimeBindings(), sessionRevocations: states })
    const laptop = new Browser()
    const phone = new Browser()
    await laptop.request(() => auth.loginUsingId(1, { remember: true }))
    await phone.request(() => auth.loginUsingId(1, { remember: true }))
    laptop.expireSession()

    let reads = 0
    let markArrived!: () => void
    const arrived = new Promise<void>(resolve => { markArrived = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      sessionRevocations: {
        async readMany(identities) {
          if (reads++ === 0) {
            markArrived()
            await gate
          }
          return states.readMany(identities)
        },
        revokeOthers: (identity, current) => states.revokeOthers(identity, current),
      },
    })

    const restoring = laptop.request(() => auth.check())
    await arrived
    await phone.request(() => auth.logoutOtherDevices())
    release()

    await expect(restoring).resolves.toBe(false)
    expect(await sessionFileCount()).toBeGreaterThanOrEqual(0)
  })
})
