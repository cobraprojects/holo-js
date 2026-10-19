import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter } from '../src'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, normalizeSessionConfig, parseCookieHeader, resetSessionRuntime } from '../../session/src'

const user = { id: 1, email: 'user@app.test' }
let rememberToken: string | null = null
const provider: AuthProviderAdapter<typeof user> = {
  async create() { return user },
  async findByCredentials() { return user },
  async findById(id) { return { ...user, id: Number(id) } },
  getId(value) { return value.id },
  getRememberToken() { return rememberToken },
  async updateRememberToken(_value, token) { rememberToken = token },
  serialize(value) { return value },
}
const context = createAsyncAuthContext()
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'auth-cookie-encryption-'))
  configureSessionRuntime({
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: directory } } }),
    stores: { file: createFileSessionStore(directory) },
    appKey: 'auth-cookie-encryption-key',
  })
  configureAuthRuntime({
    config: { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' } }, providers: { users: { model: 'User' } } },
    providers: { users: provider },
    context,
    session: getSessionRuntime(),
  })
})

afterEach(async () => {
  resetAuthRuntime()
  resetSessionRuntime()
  await rm(directory, { recursive: true, force: true })
})

function browserCookies(setCookies: readonly string[]): Readonly<Record<string, string>> {
  return parseCookieHeader(setCookies.map(setCookie => setCookie.split(';', 1)[0]).join('; '))
}

async function checkWithCookies(cookies: Readonly<Record<string, string>>): Promise<boolean> {
  const bindings = authRuntimeInternals.getRuntimeBindings()
  authRuntimeInternals.configureRuntime({
    ...bindings,
    context: { ...authRuntimeInternals.createMemoryAuthContext(), getRequestCookie: (name: string) => cookies[name] },
  })
  try {
    return await auth.check()
  } finally {
    authRuntimeInternals.configureRuntime(bindings)
  }
}

it('authenticates the next request from the encrypted session and remember cookies it issued', async () => {
  const login = await context.run(() => auth.loginUsingId(1, { remember: true }))
  const cookies = browserCookies(login.cookies)

  expect(cookies.holo_session).not.toBe(login.sessionId)
  expect(cookies.holo_session_remember).not.toBe(login.rememberToken)
  await expect(checkWithCookies({ holo_session: cookies.holo_session! })).resolves.toBe(true)
  await expect(checkWithCookies({ holo_session_remember: cookies.holo_session_remember! })).resolves.toBe(true)
})

function flipCiphertextBit(value: string): string {
  const payload = Buffer.from(value, 'base64url')
  payload[payload.length - 1] = payload[payload.length - 1]! ^ 1
  return payload.toString('base64url')
}

it('treats tampered or plaintext Holo cookies as a guest', async () => {
  const login = await context.run(() => auth.loginUsingId(1, { remember: true }))
  const cookies = browserCookies(login.cookies)
  const tampered = flipCiphertextBit(cookies.holo_session!)

  await expect(checkWithCookies({ holo_session: tampered })).resolves.toBe(false)
  await expect(checkWithCookies({ holo_session: login.sessionId })).resolves.toBe(false)
  await expect(checkWithCookies({ holo_session_remember: login.rememberToken! })).resolves.toBe(false)
  await expect(checkWithCookies({ holo_session_remember: cookies.holo_session! })).resolves.toBe(false)
})
