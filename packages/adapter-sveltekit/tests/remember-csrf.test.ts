import { expect, it, onTestFinished } from 'vitest'
import { configureAuthRuntime, createAsyncAuthContext, getAuthRuntime, resetAuthRuntime, type AuthProviderAdapter } from '../../auth/src'
import * as sessions from '../../session/src'
import { configureSecurityRuntime, csrfInternals, defineSecurityConfig, resetSecurityRuntime } from '../../security/src'
import { csrfProtection } from '../../security/src/sveltekit/server'
import { adapterSvelteKitInternals } from '../src'
import { runWithSvelteKitRequestEvent } from '../../adapter-shared/src/sveltekit/request-context'
import { createRequestAwareAuthContext } from '../../core/src/portable/authRequestContext'
import { createCsrfSessionAccessor } from '../../core/src/portable/csrfSession'
import { createNativeAuthPersistence } from '../../auth/tests/support/native-persistence'
import type NativeUser from '../../auth/tests/support/models/User'
import { createNativeSessionStore } from '../../auth/tests/support/native-session'

it('restores a remembered SvelteKit browser with a usable CSRF session and revokes its current credentials on logout', async () => {
  const persistence = await createNativeAuthPersistence()
  sessions.configureSessionRuntime({
    appKey: 'sveltekit-csrf-test-key',
    config: persistence.loadedConfig.session,
    stores: { file: createNativeSessionStore() },
  })
  const accessors = adapterSvelteKitInternals.resolveSvelteKitAuthRequestAccessors()
  const context = createRequestAwareAuthContext(createAsyncAuthContext())
  type User = ReturnType<NonNullable<Awaited<ReturnType<typeof NativeUser.find>>>['toAttributes']>
  const users = persistence.providers.users as AuthProviderAdapter<User>
  const admins = persistence.providers.admins as AuthProviderAdapter<User>
  configureAuthRuntime({ ...persistence, providers: { users, admins }, config: persistence.loadedConfig.auth, session: sessions.getSessionRuntime(), context })
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled: true } }),
    csrfSigningKey: 'sveltekit-csrf-test-key',
    csrfSession: createCsrfSessionAccessor(sessions, () => persistence.loadedConfig.session.cookie.name),
  })
  onTestFinished(() => { resetSecurityRuntime(); resetAuthRuntime(); sessions.resetSessionRuntime() })
  const auth = getAuthRuntime()
  const provider = users
  if (!provider) throw new Error('The users provider is required')
  const user = await provider.create({ name: 'Remembered', email: 'remember@app.test', password: await auth.hashPassword('secret-secret') })
  const browser = new Map<string, string>()
  const sessionName = persistence.loadedConfig.session.cookie.name
  const cookieHeader = () => [...browser].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
  const request = async (method: 'GET' | 'POST', resolve: () => Promise<Response>, secure = false) => {
    const incoming = new Request('http://127.0.0.1:43313/admin', {
      method,
      headers: { cookie: cookieHeader(), ...(secure ? { 'X-XSRF-TOKEN': browser.get('XSRF-TOKEN') ?? '' } : {}) },
    })
    const current = new Map(browser)
    const writes = new Map<string, string>()
    const event = {
      url: new URL(incoming.url), request: incoming,
      cookies: {
        get: (name: string) => current.get(name),
        set(name: string, value: string) { current.set(name, value); writes.set(name, value) },
        delete(name: string) { current.delete(name); writes.set(name, '') },
      },
    }
    const response = await runWithSvelteKitRequestEvent(event, () => context.runWithRequestAccessors(accessors, () => csrfProtection()({ event, resolve })))
    for (const cookie of response.headers.getSetCookie()) {
      for (const [name, value] of Object.entries(sessions.parseCookieHeader(cookie.split(';', 1)[0]))) browser.set(name, value)
    }
    for (const [name, value] of writes) browser.set(name, value)
    return response
  }
  await request('GET', async () => new Response('login'))
  expect((await request('POST', async () => {
    await auth.loginUsingId(provider.getId(user), { remember: true })
    return new Response(null, { status: 303 })
  }, true)).status).toBe(303)
  browser.delete(sessionName)
  expect((await request('GET', async () => {
    expect(await auth.check()).toBe(true)
    return new Response('admin')
  })).status).toBe(200)
  const restored = new Map(browser)
  const restoredId = sessions.getSessionRuntime().decryptCookie(sessionName, restored.get(sessionName) ?? '')
  const record = await sessions.getSessionRuntime().read(restoredId ?? '')
  const csrfMatchesRestoredSession = typeof record?.data._token === 'string' && record.data._token === csrfInternals.decryptCsrfToken(restored.get('XSRF-TOKEN') ?? '')
  expect((await request('POST', async () => {
    await auth.logout()
    return new Response(null, { status: 303 })
  }, true)).status).toBe(303)
  expect(csrfMatchesRestoredSession).toBe(true)
  expect(await sessions.getSessionRuntime().read(restoredId ?? '')).toBeNull()
  browser.clear()
  for (const [name, value] of restored) browser.set(name, value)
  await request('GET', async () => {
    expect(await auth.check()).toBe(false)
    return new Response('login')
  })
})
