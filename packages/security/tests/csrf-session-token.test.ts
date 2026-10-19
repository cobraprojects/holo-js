import { afterEach, describe, expect, it } from 'vitest'
import {
  configureSecurityRuntime,
  csrf,
  defineSecurityConfig,
  resetSecurityRuntime,
  SecurityCsrfError,
  type SecurityCsrfSessionAccessor,
} from '../src'
import { csrfProtection } from '../src/sveltekit/server'
import { flipCiphertextBit } from './support/ciphertext'
import { memoryCsrfSessions as memorySessions } from './support/csrf-session'

const appKey = 'csrf-session-token-key'

function configure(sessions?: SecurityCsrfSessionAccessor): void {
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled: true } }),
    csrfSigningKey: appKey,
    ...(sessions ? { csrfSession: sessions } : {}),
  })
}

function xsrfCookieOf(setCookie: string): string {
  return decodeURIComponent(setCookie.split(';', 1)[0]!.slice('XSRF-TOKEN='.length))
}

function post(browser: string, options: {
  readonly field?: string
  readonly csrfHeader?: string
  readonly xsrfHeader?: string
  readonly xsrfCookie?: string
} = {}): Request {
  return new Request('https://app.test/profile', {
    method: 'POST',
    headers: {
      cookie: [`browser=${browser}`, ...(options.xsrfCookie ? [`XSRF-TOKEN=${encodeURIComponent(options.xsrfCookie)}`] : [])].join('; '),
      ...(options.csrfHeader ? { 'X-CSRF-TOKEN': options.csrfHeader } : {}),
      ...(options.xsrfHeader ? { 'X-XSRF-TOKEN': options.xsrfHeader } : {}),
    },
    ...(options.field ? { body: new URLSearchParams({ _token: options.field }) } : {}),
  })
}

afterEach(() => {
  resetSecurityRuntime()
})

describe('session-stored CSRF token', () => {
  it('stores a new token in the session on the first page visit and reuses it afterwards', async () => {
    const sessions = memorySessions()
    configure(sessions)
    const request = new Request('https://app.test/profile')
    let renderedToken: string | undefined

    const response = await csrfProtection()({
      event: { url: new URL(request.url), request, cookies: { get: () => undefined, set: () => undefined } },
      resolve: async () => {
        renderedToken = await csrf.token(request)
        return new Response('page')
      },
    })

    expect(sessions.tokens.get('guest-1')).toBe(renderedToken)
    expect(response.headers.getSetCookie()).toContain('browser=guest-1; Path=/; HttpOnly; SameSite=Lax')
    await expect(csrf.token(new Request('https://app.test/next', { headers: { cookie: 'browser=guest-1' } }))).resolves.toBe(renderedToken)
    expect(sessions.writes).toEqual(['guest-1'])
  })

  it('lets a session cookie set by the page override the new guest session cookie', async () => {
    const sessions = memorySessions()
    configure(sessions)
    const request = new Request('https://app.test/auth/callback')

    const response = await csrfProtection()({
      event: { url: new URL(request.url), request, cookies: { get: () => undefined, set: () => undefined } },
      resolve: () => new Response('signed in', { headers: { 'Set-Cookie': 'browser=signed-in; Path=/; HttpOnly' } }),
    })

    expect(response.headers.getSetCookie().filter(cookie => cookie.startsWith('browser='))).toEqual([
      'browser=guest-1; Path=/; HttpOnly; SameSite=Lax',
      'browser=signed-in; Path=/; HttpOnly',
    ])
  })

  it('stores a token read before the middleware ran instead of skipping the session write', async () => {
    const sessions = memorySessions()
    configure(sessions)
    const request = new Request('https://app.test/profile')
    const earlyToken = await csrf.token(request)

    await csrfProtection()({
      event: { url: new URL(request.url), request, cookies: { get: () => undefined, set: () => undefined } },
      resolve: () => new Response('page'),
    })

    expect(sessions.tokens.get('guest-1')).toBe(earlyToken)
  })

  it('issues the XSRF-TOKEN cookie as the encrypted session token', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configure(sessions)
    const writes: Array<{ name: string, value: string }> = []
    const request = new Request('https://app.test/profile', { headers: { cookie: 'browser=browser-a' } })

    await csrfProtection()({
      event: { url: new URL(request.url), request, cookies: { get: () => undefined, set: (name, value) => writes.push({ name, value }) } },
      resolve: () => new Response('page'),
    })

    const xsrf = writes.find(write => write.name === 'XSRF-TOKEN')!.value
    await expect(csrf.verify(post('browser-a', { xsrfHeader: xsrf }))).resolves.toBeUndefined()
    expect(sessions.writes).toEqual([])
  })

  it('accepts the plain session token in _token or X-CSRF-TOKEN and the encrypted cookie in X-XSRF-TOKEN', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configure(sessions)
    const encrypted = xsrfCookieOf(await csrf.cookie(post('browser-a')))

    await expect(csrf.verify(post('browser-a', { field: 'session-token-a' }))).resolves.toBeUndefined()
    await expect(csrf.verify(post('browser-a', { csrfHeader: 'session-token-a' }))).resolves.toBeUndefined()
    await expect(csrf.verify(post('browser-a', { xsrfHeader: encrypted }))).resolves.toBeUndefined()
  })

  it('accepts the encrypted cookie value in _token or X-CSRF-TOKEN only for the session it belongs to', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    sessions.tokens.set('browser-b', 'session-token-b')
    configure(sessions)
    const encryptedA = xsrfCookieOf(await csrf.cookie(post('browser-a')))

    await expect(csrf.verify(post('browser-a', { field: encryptedA }))).resolves.toBeUndefined()
    await expect(csrf.verify(post('browser-a', { csrfHeader: encryptedA }))).resolves.toBeUndefined()
    await expect(csrf.verify(post('browser-b', { field: encryptedA, xsrfCookie: encryptedA }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-b', { csrfHeader: encryptedA, xsrfCookie: encryptedA }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('rejects forged or undecryptable token values', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configure(sessions)
    const encrypted = xsrfCookieOf(await csrf.cookie(post('browser-a')))
    const tampered = flipCiphertextBit(encrypted)

    await expect(csrf.verify(post('browser-a', { field: tampered }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-a', { csrfHeader: tampered }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-a', { xsrfHeader: tampered }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-a', { xsrfHeader: 'session-token-a' }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-a', { field: 'wrong', xsrfHeader: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)

    configureSecurityRuntime({ config: defineSecurityConfig({ csrf: { enabled: true } }), csrfSigningKey: 'another-key', csrfSession: sessions })
    await expect(csrf.verify(post('browser-a', { field: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('accepts _token from a JSON body or the query string like Laravel request input', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configure(sessions)
    const encrypted = xsrfCookieOf(await csrf.cookie(post('browser-a')))
    const json = (body: unknown, query = '') => new Request(`https://app.test/profile${query}`, {
      method: 'POST',
      headers: { cookie: 'browser=browser-a', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    await expect(csrf.verify(json({ _token: 'session-token-a', title: 'Guide' }))).resolves.toBeUndefined()
    await expect(csrf.verify(json({ _token: encrypted }))).resolves.toBeUndefined()
    await expect(csrf.verify(json({ title: 'Guide' }, '?_token=session-token-a'))).resolves.toBeUndefined()
    await expect(csrf.verify(json({ _token: 'wrong' }, '?_token=session-token-a'))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(json({ _token: ['session-token-a'] }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(json('session-token-a'))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('reads the session token once per request', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configure(sessions)
    const request = new Request('https://app.test/profile', { headers: { cookie: 'browser=browser-a' } })

    await csrfProtection()({
      event: { url: new URL(request.url), request, cookies: { get: () => undefined, set: () => undefined } },
      resolve: async () => {
        await csrf.input(request)
        await csrf.input(request)
        await csrf.token(request)
        return new Response('page')
      },
    })

    expect(sessions.reads).toEqual(['browser-a'])
  })

  it('keeps X-XSRF-TOKEN encrypted-only when the app configures it as the CSRF header', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('browser-a', 'session-token-a')
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true, header: 'x-xsrf-token' } }),
      csrfSigningKey: appKey,
      csrfSession: sessions,
    })
    const encrypted = xsrfCookieOf(await csrf.cookie(post('browser-a')))

    await expect(csrf.verify(post('browser-a', { xsrfHeader: 'session-token-a' }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('browser-a', { xsrfHeader: encrypted }))).resolves.toBeUndefined()
  })

  it('rejects a token planted by another browser or subdomain', async () => {
    const sessions = memorySessions()
    sessions.tokens.set('victim', 'victim-token')
    sessions.tokens.set('attacker', 'attacker-token')
    configure(sessions)
    const attackerCookie = xsrfCookieOf(await csrf.cookie(post('attacker')))

    await expect(csrf.verify(post('victim', { xsrfCookie: attackerCookie, xsrfHeader: attackerCookie }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('victim', { xsrfCookie: attackerCookie, field: 'attacker-token' }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post('no-session', { xsrfCookie: attackerCookie, xsrfHeader: attackerCookie }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('requires a session accessor for CSRF tokens', async () => {
    configure()

    await expect(csrf.token(new Request('https://app.test/profile'))).rejects.toThrow('session')
    await expect(csrf.verify(post('browser-a', { field: 'token' }))).rejects.toThrow('session')
  })
})
