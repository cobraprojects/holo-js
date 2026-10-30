import { once } from 'node:events'
import { createServer } from 'node:http'
import { NextRequest } from 'next/server'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import auth, { configureAuthRuntime, createAsyncAuthContext, resetAuthRuntime, type AuthProviderAdapter } from '../src'
import type NativeUser from './support/models/User'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src'
import { auth as nextAuth, authOnly, guestOnly, protectRoutes } from '../src/next/server'
import { authOnly as svelteAuthOnly, guestOnly as svelteGuestOnly } from '../src/sveltekit/server'
import { runWithNextAuthRequest } from '../src/next/request-context'
import { createNativeAuthPersistence } from './support/native-persistence'
import { createNativeSessionStore } from './support/native-session'

async function nativeAuth() {
  const persistence = await createNativeAuthPersistence()
  const context = Object.assign(createAsyncAuthContext(), { appendResponseCookie: () => undefined })
  const sessionStore = createNativeSessionStore()
  configureSessionRuntime({ appKey: 'holo-test-app-key', config: persistence.loadedConfig.session, stores: { file: sessionStore } })
  type User = ReturnType<NonNullable<Awaited<ReturnType<typeof NativeUser.find>>>['toAttributes']>
  const users = persistence.providers.users as AuthProviderAdapter<User>
  const admins = persistence.providers.admins as AuthProviderAdapter<User>
  configureAuthRuntime({ config: persistence.loadedConfig.auth, providers: { users, admins }, session: getSessionRuntime(), context })
  onTestFinished(() => { resetAuthRuntime(); resetSessionRuntime() })
  if (!users) throw new Error('Native user provider unavailable')
  const user = await users.create({ name: 'Ava', email: 'ava@app.test' })
  const login = await context.run(() => auth.loginUsingId(users.getId(user)))
  return {
    sessionStore,
    request(path: string, authenticated = false) {
      return new NextRequest(new URL(path, 'https://app.test'), { headers: authenticated ? { cookie: `holo_session=${login.sessionId}` } : {} })
    },
    run<TValue>(request: NextRequest, callback: () => TValue): TValue {
      return context.run(() => {
        context.setSessionId('web', request.cookies.get('holo_session')?.value)
        return callback()
      })
    },
  }
}

it('protects Next routes with native requests and persisted sessions while keeping concurrent visitors isolated', async () => {
  const app = await nativeAuth()
  const guest = guestOnly({ routes: ['/login'], redirectTo: '/admin', status: 302 })
  const responses = await Promise.all([false, true, false, true].map(authenticated => {
    const request = app.request('/login', authenticated)
    return app.run(request, () => guest(request))
  }))
  expect(responses[0]).toBeUndefined()
  expect(responses[2]).toBeUndefined()
  for (const response of [responses[1], responses[3]]) {
    expect(response?.status).toBe(302)
    expect(response?.headers.get('location')).toBe('https://app.test/admin')
  }
  const request = app.request('/admin', true)
  await expect(app.run(request, () => authOnly({ routes: ['/admin'], redirectTo: '/login' })(request))).resolves.toBeUndefined()
  await expect(app.run(request, () => authOnly({ guard: 'admin', routes: ['/admin'], redirectTo: '/login' })(request))).resolves.toMatchObject({ status: 303 })
  const visitor = app.request('/admin')
  const { cookies, headers, url } = visitor
  await expect(app.run(visitor, () => authOnly({ routes: ['/admin'], redirectTo: '/login' })({ cookies, headers, url }))).resolves.toMatchObject({ status: 303 })
})

it('matches literal, wildcard, global regex, and function routes through native Next guard responses', async () => {
  const app = await nativeAuth()
  const cases = [
    { routes: undefined, protected: ['/anything'], public: [] },
    { routes: ['/admin'], protected: ['/admin', '/admin/'], public: ['/admin/settings', '/administrator'] },
    { routes: ['/admin/*'], protected: ['/admin', '/admin/settings/'], public: ['/administrator', '/public'] },
    { routes: [/^\/admin$/g], protected: ['/admin', '/admin/'], public: ['/admin/settings'] },
    { routes: [(path: string) => path === '/admin'], protected: ['/admin', '/admin/'], public: ['/public'] },
  ]
  for (const entry of cases) {
    const guard = authOnly({ routes: entry.routes, redirectTo: '/login' })
    for (const path of entry.protected) {
      const request = app.request(path)
      const response = await app.run(request, () => guard(request))
      expect(response?.status).toBe(303)
      expect(response?.headers.get('location')).toBe('https://app.test/login')
    }
    for (const path of entry.public) {
      const request = app.request(path)
      await expect(app.run(request, () => guard(request))).resolves.toBeUndefined()
    }
  }
})

it('continues identical Next redirects and performs cross-origin redirects with the same pathname', async () => {
  const app = await nativeAuth()
  const request = app.request('/login', true)
  await expect(app.run(request, () => guestOnly({ routes: ['/login'], redirectTo: '/login' })(request))).resolves.toBeUndefined()
  const response = await app.run(request, () => guestOnly({ routes: ['/login'], redirectTo: 'https://other.test/login' })(request))
  expect(response?.status).toBe(303)
  expect(response?.headers.get('location')).toBe('https://other.test/login')
  const composed = protectRoutes(guestOnly({ routes: ['/public'], redirectTo: '/login' }), authOnly({ routes: ['/login'], redirectTo: '/login' }))
  await expect(app.run(request, () => composed(request))).resolves.toBeUndefined()
})

it('denies protected routes and reports the failure when the actual persisted session can no longer be loaded', async () => {
  const reports: HoloErrorReportContext[] = []
  errorReportingInternals.configure({ report: (_error, context) => { reports.push(context) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  const app = await nativeAuth()
  const request = app.request('/admin', true)
  const records = (await readdir(app.sessionStore.path)).filter(filename => filename.endsWith('.json'))
  expect(records).toHaveLength(1)
  const record = records[0]
  if (!record) throw new Error('No persisted session available')
  await writeFile(join(app.sessionStore.path, record), 'Invalid persisted session')
  await expect(app.run(request, () => runWithNextAuthRequest(request, () => nextAuth()))).resolves.toEqual({ authenticated: false, guard: 'web', provider: null, user: null })
  const response = await app.run(request, () => authOnly({ routes: ['/admin'], redirectTo: '/login' })(request))
  expect(response?.status).toBe(303)
  expect(response?.headers.get('location')).toBe('https://app.test/login')
  const svelteResponse = await app.run(request, () => svelteAuthOnly({ routes: ['/admin'], redirectTo: '/login' })({
    event: { url: request.nextUrl },
    resolve: () => new Response('Protected content'),
  }))
  expect(svelteResponse.status).toBe(303)
  expect(svelteResponse.headers.get('location')).toBe('https://app.test/login')
  expect(reports).toEqual([
    { capability: 'auth', operation: 'next.resolveState' },
    { capability: 'auth', operation: 'next.resolveState' },
    { capability: 'auth', operation: 'sveltekit.resolveState' },
  ])
})

it('uses persisted auth with SvelteKit guard matching, continuation, and cross-origin redirects', async () => {
  const app = await nativeAuth()
  const resolve = () => new Response('Native continuation')
  for (const route of ['/admin/*', /^\/admin$/g, (path: string) => path === '/admin']) {
    const guard = svelteAuthOnly({ routes: [route], redirectTo: '/login' })
    for (const path of ['/admin', '/admin/']) {
      const request = app.request(path)
      const response = await app.run(request, () => guard({ event: { url: request.nextUrl }, resolve }))
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('https://app.test/login')
    }
    const request = app.request('/public')
    const response = await app.run(request, () => guard({ event: { url: request.nextUrl }, resolve }))
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('Native continuation')
  }
  const request = app.request('/login', true)
  const continued = await app.run(request, () => svelteGuestOnly({ routes: ['/login'], redirectTo: '/login' })({ event: { url: request.nextUrl }, resolve }))
  expect(continued.status).toBe(200)
  const redirected = await app.run(request, () => svelteGuestOnly({ routes: ['/login'], redirectTo: 'https://other.test/login' })({ event: { url: request.nextUrl }, resolve }))
  expect(redirected.status).toBe(303)
  expect(redirected.headers.get('location')).toBe('https://other.test/login')
})

it('deduplicates Svelte client refreshes over real HTTP outside component initialization and refreshes persisted auth again', async () => {
  const app = await nativeAuth()
  const { configureAuthClient, resetAuthClient } = await import('../src/client')
  const { useAuth } = await import('../src/sveltekit/client')
  let requests = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const cookie = app.request('/', true).headers.get('cookie')
  if (!cookie) throw new Error('Native authenticated session cookie unavailable')
  const server = createServer((incoming, outgoing) => {
    requests++
    const request = new NextRequest('https://app.test/api/auth/user', { headers: { cookie: incoming.headers.cookie ?? '' } })
    void app.run(request, async () => {
      await gate
      const user = await auth.user()
      const provider = await auth.provider()
      outgoing.setHeader('content-type', 'application/json')
      outgoing.end(JSON.stringify({ authenticated: user !== null, guard: 'web', provider, user }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    release()
    resetAuthClient()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Native auth HTTP port unavailable')
  configureAuthClient({ endpoint: `http://127.0.0.1:${address.port}/api/auth/user`, headers: { cookie } })
  const current = useAuth()
  expect(current.authenticated).toBe(false)
  expect(current.provider).toBeNull()
  expect(current.user).toBeNull()
  const firstRequest = once(server, 'request')
  const first = current.refreshUser()
  const second = current.refreshUser()
  await firstRequest
  release()
  await expect(first).resolves.toMatchObject({ email: 'ava@app.test' })
  await expect(second).resolves.toMatchObject({ email: 'ava@app.test' })
  expect(requests).toBe(1)
  expect(current.authenticated).toBe(true)
  expect(current.provider).toBe('users')
  await expect(current.refreshUser()).resolves.toMatchObject({ email: 'ava@app.test' })
  expect(requests).toBe(2)
})
