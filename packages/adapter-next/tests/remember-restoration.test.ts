import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RequestCookies as NextRequestCookies, ResponseCookies as NextResponseCookies } from 'next/dist/server/web/spec-extension/cookies'
import { afterEach, beforeEach, expect, it } from 'vitest'
import auth, { authRuntimeInternals, configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter } from '../../auth/src'
import { configureSessionRuntime, createFileSessionStore, getSessionRuntime, normalizeSessionConfig, resetSessionRuntime } from '../../session/src'
import { runWithNextRequest } from '../../adapter-shared/src/next/request-context'
import { adapterNextRuntimeInternals, createNextRequestContext } from '../src/runtime'

const nativeGlobals = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage }
nativeGlobals.AsyncLocalStorage ??= AsyncLocalStorage

const projectRoot = resolve(import.meta.dirname, '..')
const requireHost = createRequire(resolve(projectRoot, 'package.json'))

type StoredUser = { id: number, email: string, password: string | null, remember_token: string | null }

let users: Map<number, StoredUser>
let directory: string

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

const asyncContext = createAsyncAuthContext()

function nextStores() {
  const { workAsyncStorage } = requireHost('next/dist/server/app-render/work-async-storage.external.js') as {
    workAsyncStorage: AsyncLocalStorage<{ route: string, isStaticGeneration: boolean }>
  }
  const { workUnitAsyncStorage } = requireHost('next/dist/server/app-render/work-unit-async-storage.external.js') as {
    workUnitAsyncStorage: AsyncLocalStorage<unknown>
  }
  const { RequestCookies, ResponseCookies } = requireHost('next/dist/server/web/spec-extension/cookies.js') as {
    RequestCookies: typeof NextRequestCookies
    ResponseCookies: typeof NextResponseCookies
  }
  const { RequestCookiesAdapter } = requireHost('next/dist/server/web/spec-extension/adapters/request-cookies.js') as {
    RequestCookiesAdapter: { seal(cookies: NextRequestCookies): NextRequestCookies }
  }
  return { workAsyncStorage, workUnitAsyncStorage, RequestCookies, ResponseCookies, RequestCookiesAdapter }
}

// Runs `callback` inside a Next.js request phase. A `render` phase is a Server Component
// render, where the cookie store is read-only; an `action` phase is a Server Action or
// Route Handler, where cookies can be written.
async function inNextRequest<TValue>(
  phase: 'render' | 'action',
  cookieHeader: string | undefined,
  callback: () => Promise<TValue>,
): Promise<{ value: TValue, cookies: NextResponseCookies }> {
  const { workAsyncStorage, workUnitAsyncStorage, RequestCookies, ResponseCookies, RequestCookiesAdapter } = nextStores()
  const cookies = new ResponseCookies(new Headers())
  const requestCookies = new RequestCookies(new Headers())
  const readable = phase === 'render' ? RequestCookiesAdapter.seal(requestCookies) : requestCookies
  const store = {
    type: 'request' as const,
    phase,
    cookies: readable,
    headers: new Headers(),
    ...(phase === 'action' ? { mutableCookies: cookies, userspaceMutableCookies: cookies } : {}),
    asyncApiPromises: {
      cookies: Promise.resolve(readable),
      ...(phase === 'action' ? { mutableCookies: Promise.resolve(cookies) } : {}),
      headers: Promise.resolve(new Headers()),
    },
  }
  const request = new Request('http://localhost/admin', cookieHeader ? { headers: { cookie: cookieHeader } } : undefined)
  const value = await workAsyncStorage.run({ route: '/admin', isStaticGeneration: false }, () => workUnitAsyncStorage.run(store, () =>
    runWithNextRequest(createNextRequestContext(request), () => asyncContext.run(callback))))
  return { value, cookies }
}

async function sessionRecordCount(): Promise<number> {
  return (await readdir(directory)).filter(name => name.endsWith('.json')).length
}

async function expireSessionRecords(): Promise<void> {
  for (const name of await readdir(directory)) await unlink(join(directory, name))
}

beforeEach(async () => {
  users = new Map([[1, { id: 1, email: 'ava@app.test', password: null, remember_token: null }]])
  directory = await mkdtemp(join(tmpdir(), 'adapter-next-remember-'))
  configureSessionRuntime({
    appKey: 'adapter-next-remember-key',
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: directory } }, idleTimeout: 120, absoluteLifetime: 120, rememberMeLifetime: 43200 }),
    stores: { file: createFileSessionStore(directory) },
  })
  const accessors = adapterNextRuntimeInternals.resolveNextAuthRequestAccessors(projectRoot)
  configureAuthRuntime({
    config: {
      defaults: { guard: 'web' },
      guards: { web: { driver: 'session', provider: 'users' } },
      providers: { users: { model: 'User' } },
    },
    providers: { users: provider },
    session: getSessionRuntime(),
    context: {
      ...asyncContext,
      getRequestCookie: accessors.getCookie,
      appendResponseCookie: accessors.appendResponseCookie,
    },
  })
})

afterEach(async () => {
  resetAuthRuntime()
  resetSessionRuntime()
  await rm(directory, { recursive: true, force: true })
})

it('restores a remembered user in Server Component renders without persisting sessions, and persists in a writable request', async () => {
  const login = await inNextRequest('action', undefined, () => auth.guard('web').loginUsingId(1, { remember: true }))
  const remember = login.cookies.get('holo_session_remember')?.value
  expect(remember).toEqual(expect.any(String))
  await expireSessionRecords()
  const rememberHeader = `holo_session_remember=${remember}`

  for (let render = 0; render < 3; render++) {
    const rendered = await inNextRequest('render', rememberHeader, () => auth.check())
    expect(rendered.value).toBe(true)
  }
  expect(await sessionRecordCount()).toBe(0)

  await expect(inNextRequest('render', undefined, () => auth.guard('web').loginUsingId(1))).rejects.toThrow(/cookie/i)
  const writable = await inNextRequest('action', rememberHeader, () => auth.check())
  expect(writable.value).toBe(true)
  expect(await sessionRecordCount()).toBe(1)
  expect(writable.cookies.get('holo_session')?.value).toEqual(expect.any(String))

  await expect(inNextRequest('render', rememberHeader, () => auth.logout())).rejects.toThrow(/cookie/i)
})
