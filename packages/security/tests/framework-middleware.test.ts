import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, defineEventHandler, getResponseHeader, toNodeListener } from 'h3'
import { NextRequest } from 'next/server.js'
import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, defineSecurityConfig, resetSecurityRuntime } from '../src'
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
