import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, defineEventHandler, getResponseHeader, readRawBody, toNodeListener, toWebHandler, toWebRequest } from 'h3'
import { NextRequest } from 'next/server.js'
import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, csrf, defineSecurityConfig, resetSecurityRuntime } from '../src'
import { csrfProtection as nextCsrfProtection } from '../src/next/server'
import { csrfProtection as nuxtCsrfProtection } from '../src/nuxt/server'
import { memoryCsrfSessions, TEST_SESSION_COOKIE, type MemoryCsrfSessions } from './support/csrf-session'

function configureSecurity(
  enabled = true,
  trustedProxies: readonly string[] | '*' = [],
  sessions: MemoryCsrfSessions = memoryCsrfSessions(),
): MemoryCsrfSessions {
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled, except: ['/webhooks/*'] }, trustedProxies }),
    csrfSigningKey: 'native-middleware-test-key',
    csrfSession: sessions,
  })
  return sessions
}

function isSessionCookie(setCookie: string): boolean {
  return setCookie.startsWith(`${TEST_SESSION_COOKIE}=`)
}

afterEach(() => {
  resetSecurityRuntime()
})

describe('native csrf middleware', () => {
  it('preserves web request bodies for handlers after Nuxt CSRF validation', async () => {
    configureSecurity(true, [], memoryCsrfSessions({ 'browser-a': 'session-token' }))
    const source = new Request('http://localhost/page', { headers: { cookie: 'browser=browser-a' } })
    const token = await csrf.token(source)
    expect(token).toBe('session-token')
    const xsrfCookie = (await csrf.cookie(source, token)).split(';', 1)[0]
    if (!xsrfCookie) throw new Error('Missing CSRF cookie')
    const cookie = `browser=browser-a; ${xsrfCookie}`
    const app = createApp()
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(async event => ({ body: await readRawBody(event) })))
    const fetch = toWebHandler(app)
    for (const [contentType, body] of [
      ['application/json', JSON.stringify({ title: 'Guide' })],
      ['application/x-www-form-urlencoded', new URLSearchParams({ _token: token, title: 'Guide' }).toString()],
    ] as const) {
      const response = await fetch(new Request(source.url, {
        body,
        headers: { cookie, 'content-type': contentType, 'x-csrf-token': token },
        method: 'POST',
      }))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual({ body })
    }
  })
  it('renders the stored session token in Nuxt handlers on the first visit', async () => {
    const sessions = configureSecurity()
    const app = createApp()
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(async event => ({ token: await csrf.token(toWebRequest(event)) })))

    const response = await toWebHandler(app)(new Request('http://localhost/page'))

    expect(await response.json()).toEqual({ token: sessions.tokens.get('guest-1') })
  })

  it('serves credentialed CORS preflight and preserves CORS headers on CSRF rejection', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      cors: { paths: ['/api/*'], origins: ['https://frontend.test'], credentials: true },
      csrfSigningKey: 'native-middleware-test-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })
    const middleware = nextCsrfProtection()
    const preflight = await middleware(new NextRequest('https://api.test/api/login', {
      method: 'OPTIONS',
      headers: { Origin: 'https://frontend.test', 'Access-Control-Request-Method': 'POST' },
    }))
    expect(preflight?.status).toBe(204)
    expect(preflight?.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test')
    expect(preflight?.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    const denied = await middleware(new NextRequest('https://api.test/api/login', {
      method: 'POST', headers: { Origin: 'https://frontend.test', cookie: 'browser=browser-a' },
    }))
    expect(denied?.status).toBe(419)
    expect(denied?.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test')
    const untrusted = await middleware(new NextRequest('https://api.test/api/login', {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.test', 'Access-Control-Request-Method': 'POST' },
    }))
    expect(untrusted?.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it.each([
    { 'x-forwarded-proto': 'wss' },
    { 'x-forwarded-host': 'a b' },
  ])('answers malformed trusted proxy headers %j with a bad request', async (headers) => {
    configureSecurity(true, '*')
    for (const method of ['GET', 'HEAD']) {
      const nextResponse = await nextCsrfProtection()(new NextRequest('https://app.test/page', { method, headers }))
      expect(nextResponse?.status).toBe(400)
      const app = createApp()
      app.use(nuxtCsrfProtection())
      app.use(defineEventHandler(() => 'handled'))
      const nuxtResponse = await toWebHandler(app)(new Request('https://app.test/page', { method, headers }))
      expect(nuxtResponse.status).toBe(400)
    }
  })

  it('uses Next native cookies and continuation responses', async () => {
    const sessions = configureSecurity()
    const middleware = nextCsrfProtection()
    const issued = await middleware(new NextRequest('https://app.test/page'))
    expect(issued?.headers.get('x-middleware-next')).toBe('1')
    const allSetCookies = issued?.headers.getSetCookie() ?? []
    expect(allSetCookies).toHaveLength(3)
    expect(allSetCookies.filter(isSessionCookie)).toEqual(['browser=guest-1; Path=/; HttpOnly; SameSite=Lax'])
    const setCookies = allSetCookies.filter(cookie => !isSessionCookie(cookie))
    expect(setCookies).toHaveLength(2)
    for (const cookie of setCookies) {
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=lax')
      expect(cookie).not.toContain('HttpOnly')
    }
    const cookieHeader = allSetCookies.map(cookie => cookie.split(';')[0]).join('; ')
    expect(await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: cookieHeader },
    }))).toBeUndefined()
    const tokenCookie = setCookies.find(cookie => cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
    const configurationCookie = setCookies.find(cookie => !cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
    const stale = await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: `browser=guest-1; ${tokenCookie}; HOLO-CSRF-CONFIG=stale` },
    }))
    expect(stale?.headers.getSetCookie()).toHaveLength(1)
    expect(stale?.headers.getSetCookie()[0]).not.toContain('XSRF-TOKEN=')
    const forged = await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: `browser=guest-1; XSRF-TOKEN=forged; ${configurationCookie}` },
    }))
    expect(forged?.headers.getSetCookie()).toHaveLength(1)
    expect(forged?.headers.getSetCookie()[0]).toContain('XSRF-TOKEN=')
    const sessionless = await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: `${tokenCookie}; ${configurationCookie}` },
    }))
    const sessionlessCookies = sessionless?.headers.getSetCookie() ?? []
    expect(sessionlessCookies.filter(isSessionCookie)).toEqual(['browser=guest-2; Path=/; HttpOnly; SameSite=Lax'])
    expect(sessionlessCookies.filter(cookie => cookie.startsWith('XSRF-TOKEN='))).toHaveLength(1)
    expect(sessions.writes).toEqual(['guest-1', 'guest-2'])
    expect(await middleware(new NextRequest('https://app.test/page', {
      method: 'HEAD', headers: { cookie: cookieHeader },
    }))).toBeUndefined()
    const token = decodeURIComponent(tokenCookie.slice('XSRF-TOKEN='.length))
    expect(await middleware(new NextRequest('https://app.test/page', {
      method: 'POST',
      headers: { cookie: cookieHeader },
      body: new URLSearchParams({ _token: token }),
    }))).toBeUndefined()
    const denied = await middleware(new NextRequest('https://app.test/page', { method: 'POST' }))
    expect(denied?.status).toBe(419)
    const crossSession = await middleware(new NextRequest('https://app.test/page', {
      method: 'POST',
      headers: { cookie: `browser=guest-2; ${tokenCookie}` },
      body: new URLSearchParams({ _token: token }),
    }))
    expect(crossSession?.status).toBe(419)
    expect(await middleware(new NextRequest('https://app.test/webhooks/provider', { method: 'POST' }))).toBeUndefined()
    configureSecurity(false)
    expect(await middleware(new NextRequest('https://app.test/page'))).toBeUndefined()
    resetSecurityRuntime()
    await expect(middleware(new NextRequest('https://app.test/page', { method: 'POST' }))).rejects.toThrow(/Security runtime/)

  })

  it('writes H3 cookies before rendering and validates native unsafe requests', async () => {
    configureSecurity()
    const app = createApp()
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(event => ({ cookiesBeforeRendering: Boolean(getResponseHeader(event, 'set-cookie')) })))
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const url = `http://127.0.0.1:${address.port}/page`
    try {
      const response = await fetch(url)
      expect(await response.json()).toEqual({ cookiesBeforeRendering: true })
      const allCookies = response.headers.getSetCookie()
      expect(allCookies).toHaveLength(3)
      expect(allCookies.filter(isSessionCookie)).toEqual(['browser=guest-1; Path=/; HttpOnly; SameSite=Lax'])
      const cookies = allCookies.filter(cookie => !isSessionCookie(cookie))
      expect(cookies).toHaveLength(2)
      expect(cookies.every(cookie => !cookie.includes('Secure') && !cookie.includes('HttpOnly'))).toBe(true)
      const cookieHeader = allCookies.map(cookie => cookie.split(';')[0]).join('; ')
      const current = await fetch(url, { headers: { cookie: cookieHeader } })
      expect(current.headers.getSetCookie()).toEqual([])
      expect(await current.json()).toEqual({ cookiesBeforeRendering: false })
      const configurationCookie = cookies.find(cookie => !cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
      const forged = await fetch(url, { headers: { cookie: `browser=guest-1; XSRF-TOKEN=forged; ${configurationCookie}` } })
      expect(forged.headers.getSetCookie()).toHaveLength(1)
      expect(forged.headers.getSetCookie()[0]).toContain('XSRF-TOKEN=')
      const head = await fetch(url, { method: 'HEAD' })
      expect(head.headers.getSetCookie()).toHaveLength(3)
      expect(head.headers.getSetCookie().filter(isSessionCookie)).toEqual(['browser=guest-2; Path=/; HttpOnly; SameSite=Lax'])
      expect((await fetch(url, { method: 'OPTIONS' })).status).toBe(200)
      expect((await fetch(url, { method: 'POST' })).status).toBe(419)
      const tokenCookie = cookies.find(cookie => cookie.startsWith('XSRF-TOKEN='))
      const token = decodeURIComponent(tokenCookie?.split(';')[0]?.slice('XSRF-TOKEN='.length) ?? '')
      const accepted = await fetch(url, {
        method: 'POST',
        headers: { cookie: cookieHeader, 'x-csrf-token': token },
      })
      expect(accepted.status).toBe(200)
      expect(accepted.headers.getSetCookie()).toEqual([])
      const form = await fetch(url, {
        method: 'POST',
        headers: { cookie: cookieHeader },
        body: new URLSearchParams({ _token: token }),
      })
      expect(form.status).toBe(200)
      const crossSession = await fetch(url, {
        method: 'POST',
        headers: { cookie: `browser=guest-2; ${tokenCookie?.split(';')[0] ?? ''}`, 'x-csrf-token': token },
      })
      expect(crossSession.status).toBe(419)
      expect((await fetch(url.replace('/page', '/webhooks/provider'), { method: 'POST' })).status).toBe(200)
      expect((await fetch(url.replace('/page', '/broadcasting/auth'), { method: 'POST' })).status).toBe(200)
      configureSecurity(false)
      const disabled = await fetch(url)
      expect(disabled.headers.getSetCookie()).toEqual([])

    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
