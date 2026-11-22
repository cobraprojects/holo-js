import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter } from '../src'
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

let directory: string

class Browser {
  readonly cookies = new Map<string, string>()

  async request<TValue>(callback: () => Promise<TValue>): Promise<TValue> {
    const current = authRuntimeInternals.getRuntimeBindings()
    const requestCookies = new Map(this.cookies)
    const requestContext = createAsyncAuthContext()
    authRuntimeInternals.configureRuntime({
      ...current,
      context: {
        ...requestContext,
        getRequestCookie: (name: string) => requestCookies.get(name),
        appendResponseCookie: (setCookie: string) => this.receive(setCookie),
      },
    })
    try {
      return await requestContext.run(callback)
    } finally {
      authRuntimeInternals.configureRuntime(current)
    }
  }

  expireSession(): void {
    this.cookies.delete('holo_session')
  }

  private receive(setCookie: string): void {
    const [pair] = setCookie.split(';', 1)
    const [name, value] = Object.entries(parseCookieHeader(pair!))[0]!
    if (!value || /max-age=0/i.test(setCookie)) this.cookies.delete(name)
    else this.cookies.set(name, value)
  }
}

async function signedInAdmin(): Promise<Browser> {
  const browser = new Browser()
  await browser.request(() => auth.guard('admin').loginUsingId(1))
  return browser
}

beforeEach(async () => {
  users.clear()
  users.set(1, { id: 1, email: 'admin@app.test', password: null, remember_token: null })
  users.set(2, { id: 2, email: 'customer@app.test', password: null, remember_token: null })
  users.set(3, { id: 3, email: 'other@app.test', password: null, remember_token: null })
  directory = await mkdtemp(join(tmpdir(), 'auth-impersonation-'))
  configureSessionRuntime({
    appKey: 'impersonation-app-key',
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: directory } }, idleTimeout: 120, absoluteLifetime: 120, rememberMeLifetime: 43200 }),
    stores: { file: createFileSessionStore(directory) },
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
    },
    providers: { users: provider },
    context: authRuntimeInternals.createMemoryAuthContext(),
    session: getSessionRuntime(),
  })
})

afterEach(async () => {
  resetAuthRuntime()
  resetSessionRuntime()
  await rm(directory, { recursive: true, force: true })
})

describe('impersonation as the first auth call in a request', () => {
  it('reads the impersonation state from the request session', async () => {
    const browser = await signedInAdmin()
    await browser.request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await expect(browser.request(() => auth.guard('web').impersonation())).resolves.toMatchObject({
      guard: 'web',
      actorGuard: 'admin',
      user: { id: 2 },
      actor: { id: 1 },
      originalUser: null,
    })
  })

  it('stops impersonating and removes the guard payload', async () => {
    const browser = await signedInAdmin()
    await browser.request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await expect(browser.request(() => auth.guard('web').stopImpersonating())).resolves.toBeNull()
    await expect(browser.request(() => auth.guard('web').user())).resolves.toBeNull()
    await expect(browser.request(() => auth.guard('admin').user())).resolves.toMatchObject({ id: 1 })
  })

  it('saves the customer signed in on the target guard as the original and restores them on stop', async () => {
    const browser = await signedInAdmin()
    await browser.request(() => auth.guard('web').loginUsingId(3))
    await browser.request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await expect(browser.request(() => auth.guard('web').impersonation())).resolves.toMatchObject({
      user: { id: 2 },
      originalUser: { id: 3 },
    })
    await expect(browser.request(() => auth.guard('web').stopImpersonating())).resolves.toMatchObject({ id: 3 })
    await expect(browser.request(() => auth.guard('web').user())).resolves.toMatchObject({ id: 3 })
  })

  it('rejects a second impersonation while one is active', async () => {
    const browser = await signedInAdmin()
    await browser.request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await expect(browser.request(() => auth.guard('web').impersonateById(3, { actorGuard: 'admin' })))
      .rejects.toMatchObject({ code: 'impersonation_already_active' })
  })

  it('keeps the other guards signed in when the actor is restored from remember me', async () => {
    const browser = new Browser()
    await browser.request(() => auth.guard('admin').loginUsingId(1, { remember: true }))
    browser.expireSession()
    await browser.request(() => auth.guard('support').loginUsingId(3))

    await browser.request(() => auth.guard('web').impersonateById(2, { actorGuard: 'admin' }))

    await expect(browser.request(() => auth.guard('support').user())).resolves.toMatchObject({ id: 3 })
    await expect(browser.request(() => auth.guard('web').impersonation())).resolves.toMatchObject({
      user: { id: 2 },
      actor: { id: 1 },
    })
  })
})
