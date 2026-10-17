import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeHoloHttpError, resolveRequestUrl, type HoloRequestInput } from '../src/index'

afterEach(() => vi.unstubAllEnvs())

describe('client-facing request URLs', () => {
  it('uses the HTTP Host when the framework URL uses its internal hostname', async () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'false')
    const server = createServer((incoming, response) => {
      const request = new Request(`http://localhost${incoming.url}`, {
        headers: new Headers(Object.entries(incoming.headers).flatMap(([name, value]) =>
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

  it('ignores untrusted forwarded headers and Referer', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'false')
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

  it('honors explicitly trusted proxy host and protocol with the original path and query', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'true')
    expect(resolveRequestUrl({
      url: 'http://localhost/login?next=%2Fadmin',
      headers: {
        host: 'internal.example',
        'x-forwarded-host': 'public.example:8443, internal.example',
        'x-forwarded-proto': 'https, http',
      },
    }).href).toBe('https://public.example:8443/login?next=%2Fadmin')
  })

  it('trusts only the RFC 7239 Forwarded header when proxy trust is "forwarded"', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'forwarded')
    expect(resolveRequestUrl({
      path: '/login',
      headers: [['Forwarded', 'for=192.0.2.1;proto="https";host="[::1]:8443"']],
    }).href).toBe('https://[::1]:8443/login')
    expect(resolveRequestUrl({
      path: '/login',
      headers: {
        host: 'app.test',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
      },
    }).href).toBe('http://app.test/login')
  })

  it('reads quoted Forwarded values whole, including separators inside quotes', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'forwarded')
    expect(() => resolveRequestUrl({ path: '/login', headers: { forwarded: 'for=192.0.2.1;host="app.test,evil.test";proto=https' } })).toThrow('Request hosts must be a valid hostname')
    expect(resolveRequestUrl({ path: '/login', headers: { forwarded: 'for="[2001:db8::1]:4711";host="app.test:8443";proto="https"' } }).href).toBe('https://app.test:8443/login')
  })

  it('ignores Forwarded segments without a value', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'forwarded')
    expect(resolveRequestUrl({
      path: '/login',
      headers: { host: 'app.test', forwarded: 'hostx;protox' },
    }).href).toBe('http://app.test/login')
  })

  it.each(['true', 'x-forwarded'])('trusts only X-Forwarded headers when proxy trust is %j', (trustProxy) => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', trustProxy)
    expect(resolveRequestUrl({
      url: 'http://localhost/login',
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        forwarded: 'proto=http;host=attacker.example',
      },
    }).href).toBe('https://app.test/login')
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
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'true')
    expect(resolveRequestUrl({
      url: 'http://localhost:43201/login',
      headers: { host: 'localhost:43201', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' },
    }).href).toBe('https://public.example/login')
  })

  it.each(['', 'evil.example/path', 'user@evil.example', 'evil.example\\path', 'evil.example?query', 'evil.example#fragment', 'evil.example,other.example', 'evil.example:invalid', 'evil.example:99999'])(
    'rejects malformed Host %j', (host) => {
      expect(() => resolveRequestUrl({ headers: { host } })).toThrow(TypeError)
    },
  )

  it.each([
    { 'x-forwarded-proto': 'wss' },
    { 'x-forwarded-host': 'a b' },
  ])('reports malformed trusted proxy headers %j as a bad request', (headers) => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'true')
    let thrown: unknown
    try {
      resolveRequestUrl({ headers: { host: 'app.test', ...headers } })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect(normalizeHoloHttpError(thrown)?.status).toBe(400)
  })

  it('rejects unsafe protocols and URL credentials', () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'true')
    expect(() => resolveRequestUrl({ headers: { host: 'app.test', 'x-forwarded-proto': 'javascript' } })).toThrow('protocols must be http or https')
    expect(() => resolveRequestUrl({ url: 'https://user:password@app.test/' })).toThrow(TypeError)
    expect(() => resolveRequestUrl({ url: 'javascript:alert(1)' })).toThrow(TypeError)
  })
})
