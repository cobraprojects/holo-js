import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHoloHttpError, requestUrlInternals, resolveRequestUrl, type HoloRequestInput } from '../src/index'

afterEach(() => {
  requestUrlInternals.configureForwardedRequestResolver(undefined)
  requestUrlInternals.provideConnectionAddress(undefined)
})

describe('client-facing request URLs', () => {
  it('uses the HTTP Host when the framework URL uses its internal hostname', async () => {
    const server = createServer((incoming, response) => {
      const request = new Request(`http://localhost${incoming.url}`, {
        headers: new Headers(Object.entries(incoming.headers).flatMap<[string, string]>(([name, value]) =>
          typeof value === 'string' ? [[name, value]] : [])),
      })
      response.end(resolveRequestUrl(request).href)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
      const origin = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${origin}/auth/presentation?theme=light`)
      expect(await response.text()).toBe(`${origin}/auth/presentation?theme=light`)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('resolves native, Next, Nuxt, and SvelteKit request inputs without reading their bodies', async () => {
    const request = new Request('https://localhost/login?next=%2Fadmin', {
      method: 'POST',
      headers: { host: 'public.example:8443' },
      body: 'email=ava',
    })
    const inputs: HoloRequestInput[] = [
      request,
      { request },
      { url: request.url, headers: request.headers },
      { req: request },
      { node: { req: { url: '/login?next=%2Fadmin', headers: { Host: 'public.example:8443' } } } },
      { web: { request } },
      { url: new URL(request.url), request },
    ]
    for (const input of inputs) {
      const url = resolveRequestUrl(input)
      expect(url.host).toBe('public.example:8443')
      expect(url.pathname + url.search).toBe('/login?next=%2Fadmin')
    }
    expect(request.bodyUsed).toBe(false)
    expect(await request.text()).toBe('email=ava')
  })

  it('ignores forwarded headers and Referer until a forwarding resolver is registered', () => {
    expect(resolveRequestUrl(new Request('http://localhost/login', {
      headers: {
        host: '127.0.0.1:43201',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'javascript',
        forwarded: 'proto=https;host=attacker.example',
        referer: 'https://attacker.example/elsewhere',
      },
    })).href).toBe('http://127.0.0.1:43201/login')
  })

  it('takes the public protocol and host from the registered resolver, which sees the headers and connection address', () => {
    const seen: Array<{ readonly host: string | undefined, readonly connectionAddress: string | undefined }> = []
    requestUrlInternals.provideConnectionAddress(() => '10.0.0.5')
    requestUrlInternals.configureForwardedRequestResolver((readHeader, connectionAddress) => {
      seen.push({ host: readHeader('x-forwarded-host'), connectionAddress })
      return { protocol: 'https', host: 'public.example:8443' }
    })
    expect(resolveRequestUrl({
      url: 'http://localhost/login?next=%2Fadmin',
      headers: [['Host', 'internal.example'], ['X-Forwarded-Host', 'public.example:8443']],
    }).href).toBe('https://public.example:8443/login?next=%2Fadmin')
    expect(seen).toEqual([{ host: 'public.example:8443', connectionAddress: '10.0.0.5' }])
  })

  it('applies the forwarded port and path prefix to the public URL', () => {
    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https', host: 'public.example:8080', port: '8443', prefix: '/blog/' }))
    expect(resolveRequestUrl({ url: 'http://localhost/login?next=%2Fadmin', headers: { host: 'internal.example' } }).href)
      .toBe('https://public.example:8443/blog/login?next=%2Fadmin')
    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https', port: '443', prefix: '/' }))
    expect(resolveRequestUrl({ url: 'http://localhost/login', headers: { host: 'internal.example:3000' } }).href)
      .toBe('https://internal.example/login')
  })

  it('keeps the framework path for routed requests while applying the public origin', () => {
    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https', host: 'public.example', port: '8443', prefix: '/blog' }))
    expect(requestUrlInternals.resolveRoutedRequestUrl({ url: 'http://localhost/login?next=%2Fadmin', headers: { host: 'internal.example' } }).href)
      .toBe('https://public.example:8443/login?next=%2Fadmin')
  })

  it('resolves the client address from the connection, or from the registered resolver', () => {
    const input = { url: 'http://localhost/login', headers: { host: 'app.test', 'x-forwarded-for': '203.0.113.66', 'x-real-ip': '203.0.113.67' } }
    expect(requestUrlInternals.resolveClientAddress(input)).toBeUndefined()
    requestUrlInternals.provideConnectionAddress(() => '198.51.100.4')
    expect(requestUrlInternals.resolveClientAddress(input)).toBe('198.51.100.4')
    requestUrlInternals.configureForwardedRequestResolver((readHeader, connectionAddress) => ({ address: `${readHeader('x-forwarded-for')} via ${connectionAddress}` }))
    expect(requestUrlInternals.resolveClientAddress(input)).toBe('203.0.113.66 via 198.51.100.4')
  })

  it('treats a failing connection address provider as an unknown connection', () => {
    let received: string | undefined = 'unset'
    requestUrlInternals.provideConnectionAddress(() => {
      throw new Error('No request in context')
    })
    requestUrlInternals.configureForwardedRequestResolver((_readHeader, connectionAddress) => {
      received = connectionAddress
      return {}
    })
    expect(resolveRequestUrl({ path: '/login', headers: { host: 'app.test' } }).href).toBe('http://app.test/login')
    expect(received).toBeUndefined()
  })

  it('retains an absolute URL without Host and defaults relative requests to HTTP', () => {
    expect(resolveRequestUrl({ url: new URL('https://example.com/login?q=1') }).href).toBe('https://example.com/login?q=1')
    expect(resolveRequestUrl({ path: '/login', headers: { host: '[::1]:43201' } }).href).toBe('http://[::1]:43201/login')
    expect(resolveRequestUrl({}).href).toBe('http://localhost/')
  })

  it('drops an internal port when the public host has no port', () => {
    expect(resolveRequestUrl({
      url: 'http://localhost:43201/login',
      headers: { host: 'public.example' },
    }).href).toBe('http://public.example/login')
    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https', host: 'public.example' }))
    expect(resolveRequestUrl({
      url: 'http://localhost:43201/login',
      headers: { host: 'localhost:43201' },
    }).href).toBe('https://public.example/login')
  })

  it.each(['', 'evil.example/path', 'user@evil.example', 'evil.example\\path', 'evil.example?query', 'evil.example#fragment', 'evil.example,other.example', 'evil.example:invalid', 'evil.example:99999'])(
    'rejects malformed Host %j', (host) => {
      expect(() => resolveRequestUrl({ headers: { host } })).toThrow(TypeError)
    },
  )

  it.each([
    { protocol: 'wss' },
    { host: 'a b' },
    { host: 'app.test,evil.test' },
    { port: '' },
    { port: 'abc' },
    { port: '65536' },
    { prefix: 'blog' },
    { prefix: '//attacker.example' },
    { prefix: '/blog?next=/' },
  ])('reports malformed forwarded values %j as a bad request', (forwarded) => {
    requestUrlInternals.configureForwardedRequestResolver(() => forwarded)
    let thrown: unknown
    try {
      resolveRequestUrl({ headers: { host: 'app.test' } })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect(normalizeHoloHttpError(thrown)?.status).toBe(400)
  })

  it('rejects unsafe protocols and URL credentials', () => {
    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'javascript' }))
    expect(() => resolveRequestUrl({ headers: { host: 'app.test' } })).toThrow('protocols must be http or https')
    expect(() => resolveRequestUrl({ url: 'https://user:password@app.test/' })).toThrow(TypeError)
    expect(() => resolveRequestUrl({ url: 'javascript:alert(1)' })).toThrow(TypeError)
  })
})
