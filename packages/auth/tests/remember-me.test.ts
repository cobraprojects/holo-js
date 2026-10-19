import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, resetAuthRuntime, type AuthProviderAdapter, type AuthSessionRevocationStore } from '../src'
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

  async request<TValue>(callback: () => Promise<TValue>, bindings: Partial<Parameters<typeof configureAuthRuntime>[0]> = {}): Promise<TValue> {
    const current = authRuntimeInternals.getRuntimeBindings()
    const context = {
      ...authRuntimeInternals.createMemoryAuthContext(),
      getRequestCookie: (name: string) => this.cookies.get(name),
      appendResponseCookie: (setCookie: string) => this.receive(setCookie),
    }
    authRuntimeInternals.configureRuntime({ ...current, ...bindings, context })
    try {
      return await callback()
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
      web: [1, stored.remember_token, expect.stringMatching(/^[a-f0-9]{64}$/)],
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
})
