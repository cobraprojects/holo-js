import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, defineEventHandler, getResponseHeader, readRawBody, toNodeListener, toWebHandler } from 'h3'
import { NextRequest } from 'next/server.js'
import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, csrf, defineSecurityConfig, resetSecurityRuntime } from '../src'
import { csrfProtection as nextCsrfProtection } from '../src/next/server'
import { csrfProtection as nuxtCsrfProtection } from '../src/nuxt/server'

function configureSecurity(enabled = true): void {
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled, except: ['/webhooks/*'] } }),
    csrfSigningKey: 'native-middleware-test-key',
  })
}

afterEach(resetSecurityRuntime)

describe('native csrf middleware', () => {
  it('preserves web request bodies for handlers after Nuxt CSRF validation', async () => {
    configureSecurity()
    const source = new Request('http://localhost/page')
    const token = await csrf.token(source)
    const cookie = (await csrf.cookie(source, token)).split(';', 1)[0]
    if (!cookie) throw new Error('Missing CSRF cookie')
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
  it('serves credentialed CORS preflight and preserves CORS headers on CSRF rejection', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      cors: { paths: ['/api/*'], origins: ['https://frontend.test'], credentials: true },
      csrfSigningKey: 'native-middleware-test-key',
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
      method: 'POST', headers: { Origin: 'https://frontend.test' },
    }))
    expect(denied?.status).toBe(419)
    expect(denied?.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test')
    const untrusted = await middleware(new NextRequest('https://api.test/api/login', {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.test', 'Access-Control-Request-Method': 'POST' },
    }))
    expect(untrusted?.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('uses Next native cookies and continuation responses', async () => {
    configureSecurity()
    const middleware = nextCsrfProtection()
    const issued = await middleware(new NextRequest('https://app.test/page'))
    expect(issued?.headers.get('x-middleware-next')).toBe('1')
    const setCookies = issued?.headers.getSetCookie() ?? []
    expect(setCookies).toHaveLength(2)
    for (const cookie of setCookies) {
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=lax')
      expect(cookie).not.toContain('HttpOnly')
    }
    const cookieHeader = setCookies.map(cookie => cookie.split(';')[0]).join('; ')
    expect(await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: cookieHeader },
    }))).toBeUndefined()
    const tokenCookie = setCookies.find(cookie => cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
    const configurationCookie = setCookies.find(cookie => !cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
    const stale = await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: `${tokenCookie}; HOLO-CSRF-CONFIG=stale` },
    }))
    expect(stale?.headers.getSetCookie()).toHaveLength(1)
    expect(stale?.headers.getSetCookie()[0]).not.toContain('XSRF-TOKEN=')
    const forged = await middleware(new NextRequest('https://app.test/page', {
      headers: { cookie: `XSRF-TOKEN=forged; ${configurationCookie}` },
    }))
    expect(forged?.headers.getSetCookie()).toHaveLength(1)
    expect(forged?.headers.getSetCookie()[0]).toContain('XSRF-TOKEN=')
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
      const cookies = response.headers.getSetCookie()
      expect(cookies).toHaveLength(2)
      expect(cookies.every(cookie => !cookie.includes('Secure') && !cookie.includes('HttpOnly'))).toBe(true)
      const cookieHeader = cookies.map(cookie => cookie.split(';')[0]).join('; ')
      const current = await fetch(url, { headers: { cookie: cookieHeader } })
      expect(current.headers.getSetCookie()).toEqual([])
      expect(await current.json()).toEqual({ cookiesBeforeRendering: false })
      const configurationCookie = cookies.find(cookie => !cookie.startsWith('XSRF-TOKEN='))?.split(';')[0] ?? ''
      const forged = await fetch(url, { headers: { cookie: `XSRF-TOKEN=forged; ${configurationCookie}` } })
      expect(forged.headers.getSetCookie()).toHaveLength(1)
      expect(forged.headers.getSetCookie()[0]).toContain('XSRF-TOKEN=')
      const head = await fetch(url, { method: 'HEAD' })
      expect(head.headers.getSetCookie()).toHaveLength(2)
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
