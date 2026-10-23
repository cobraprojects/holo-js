import { HoloRequestUrlError, requestUrlInternals, resolveRequestUrl } from '@holo-js/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureSecurityRuntime,
  createMemoryRateLimitStore,
  defineSecurityConfig,
  ip,
  limit,
  normalizeSecurityConfig,
  rateLimit,
  resetSecurityRuntime,
  type HoloSecurityConfig,
} from '../src'

const cloudflareRange = '173.245.48.0/20'

function trustProxies(trustedProxies: HoloSecurityConfig['trustedProxies'], connectionAddress?: string): void {
  requestUrlInternals.provideConnectionAddress(connectionAddress === undefined ? undefined : () => connectionAddress)
  configureSecurityRuntime({
    config: defineSecurityConfig({ trustedProxies, rateLimit: { limiters: { login: limit.perMinute(1).define() } } }),
    rateLimitStore: createMemoryRateLimitStore(),
  })
}

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost/login', { headers: { host: 'internal.test', ...headers } })
}

afterEach(() => {
  resetSecurityRuntime()
  requestUrlInternals.provideConnectionAddress(undefined)
})

describe('trusted proxies', () => {
  it('identifies visitors by their connection address and ignores forwarded headers by default', () => {
    trustProxies(undefined, '198.51.100.4')
    const spoofed = request({ 'x-forwarded-for': '203.0.113.66', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test' })
    expect(ip(spoofed)).toBe('198.51.100.4')
    expect(resolveRequestUrl(spoofed).href).toBe('http://internal.test/login')
  })

  it('reports how to configure trusted proxies when the framework does not expose the connection address', () => {
    trustProxies(undefined)
    expect(() => ip(request({ 'x-forwarded-for': '203.0.113.66' }))).toThrow(
      '[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set TRUSTED_PROXIES to your proxy\'s addresses, or to * when the app is reachable only through your proxy. See https://docs.holo-js.com/basics/security/cors-and-proxies#trusted-proxies',
    )
  })

  it('takes the address appended by a trusted proxy, not the one the client supplied', () => {
    trustProxies(['127.0.0.1'], '127.0.0.1')
    const appended = request({
      'x-forwarded-for': '203.0.113.66, 192.0.2.10',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'app.test',
    })
    expect(ip(appended)).toBe('192.0.2.10')
    expect(resolveRequestUrl(appended).href).toBe('https://app.test/login')
  })

  it('ignores forwarded headers from a client that connects directly instead of through a trusted proxy', () => {
    trustProxies(['127.0.0.1'], '198.51.100.4')
    const direct = request({ 'x-forwarded-for': '203.0.113.66', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test' })
    expect(ip(direct)).toBe('198.51.100.4')
    expect(resolveRequestUrl(direct).href).toBe('http://internal.test/login')
  })

  it('skips every trusted hop, including CIDR ranges, to reach the visitor behind a CDN and a local proxy', () => {
    trustProxies(['127.0.0.1', cloudflareRange], '::ffff:127.0.0.1')
    expect(ip(request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10, 173.245.48.7' }))).toBe('192.0.2.10')
  })

  it('trusts only the directly connected proxy with "*"', () => {
    trustProxies('*', '10.0.0.8')
    expect(ip(request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }))).toBe('192.0.2.10')
    expect(ip(request({}))).toBe('10.0.0.8')
  })

  it('resolves a direct Next.js visitor to loopback under "*", because Next fills in X-Forwarded-For from the socket', () => {
    trustProxies('*')
    expect(ip(request({ 'x-forwarded-for': '::ffff:127.0.0.1' }))).toBe('127.0.0.1')
    expect(ip(request({ 'x-forwarded-for': '::1' }))).toBe('::1')
  })

  it('trusts the proxy in front of a framework that does not expose the connection address', () => {
    trustProxies('*')
    expect(ip(request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }))).toBe('192.0.2.10')
  })

  it('ignores the RFC 7239 Forwarded header, like Laravel', () => {
    trustProxies('*', '10.0.0.8')
    const forwarded = request({ forwarded: 'for=203.0.113.66;proto=https;host=attacker.test' })
    expect(ip(forwarded)).toBe('10.0.0.8')
    expect(resolveRequestUrl(forwarded).href).toBe('http://internal.test/login')
    expect(ip(request({ 'x-forwarded-for': '192.0.2.10', forwarded: 'for=203.0.113.66' }))).toBe('192.0.2.10')
  })

  it('ignores forwarded headers when the connection address is unknown unless every proxy is trusted', () => {
    trustProxies(['127.0.0.1'])
    const spoofed = request({ 'x-forwarded-for': '203.0.113.66', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test' })
    expect(() => ip(spoofed)).toThrow(
      '[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set TRUSTED_PROXIES to your proxy\'s addresses, or to * when the app is reachable only through your proxy. See https://docs.holo-js.com/basics/security/cors-and-proxies#trusted-proxies',
    )
    expect(resolveRequestUrl(spoofed).href).toBe('http://internal.test/login')
  })

  it('does not treat forwarded addresses as trusted proxies with "*"', () => {
    trustProxies('*', '10.0.0.8')
    expect(ip(request({ 'x-forwarded-for': '203.0.113.66, 10.0.0.8' }))).toBe('203.0.113.66')
    expect(ip(request({ 'x-forwarded-for': '10.0.0.8' }))).toBe('10.0.0.8')
  })

  it.each([
    ['2001:db8::1', '203.0.113.9, 2001:0db8:0:0:0:0:0:1'],
    ['2001:0DB8::0001', '203.0.113.9, [2001:db8::1]:443'],
    ['::ffff:10.0.0.8', '203.0.113.9, 10.0.0.8'],
    ['10.0.0.8', '203.0.113.9, ::ffff:10.0.0.8'],
  ])('with "*" recognizes the connecting proxy %s however its address is written in X-Forwarded-For %s', (connectionAddress, forwardedFor) => {
    trustProxies('*', connectionAddress)
    expect(ip(request({ 'x-forwarded-for': forwardedFor }))).toBe('203.0.113.9')
  })

  it.each([
    ['[2001:db8::7]:4711', '2001:db8::7'],
    ['192.0.2.43:47011', '192.0.2.43'],
    ['2001:db8::7', '2001:db8::7'],
    ['192.0.2.43, _hidden, unknown', '192.0.2.43'],
    ['_hidden', '10.0.0.8'],
  ])('identifies the X-Forwarded-For client %s as %s, dropping ports and entries that are not addresses', (forwardedFor, address) => {
    trustProxies('*', '10.0.0.8')
    expect(ip(request({ 'x-forwarded-for': forwardedFor }))).toBe(address)
  })

  it('returns the first trusted address when every hop is trusted', () => {
    trustProxies(['10.0.0.0/8'], '10.0.0.8')
    expect(ip(request({ 'x-forwarded-for': '10.0.0.3, 10.0.0.4' }))).toBe('10.0.0.3')
  })

  it('takes the protocol, host, port, and prefix from the first X-Forwarded value, like Laravel', () => {
    trustProxies('*', '10.0.0.8')
    expect(resolveRequestUrl(request({
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'app.test, attacker.test',
      'x-forwarded-port': '8443, 80',
      'x-forwarded-prefix': '/blog/, /other',
    })).href).toBe('https://app.test:8443/blog/login')
    expect(resolveRequestUrl(request({ 'x-forwarded-host': 'app.test:8080' })).href).toBe('http://app.test:8080/login')
    expect(resolveRequestUrl(request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.test' })).href).toBe('https://app.test/login')
    expect(resolveRequestUrl(request({ 'x-forwarded-port': '8080' })).href).toBe('http://internal.test:8080/login')
  })

  it.each([['on', 'https'], ['ssl', 'https'], ['1', 'https'], ['HTTPS', 'https'], ['wss', 'http'], ['http', 'http']])(
    'treats X-Forwarded-Proto %s as %s, like Laravel', (proto, protocol) => {
      trustProxies('*', '10.0.0.8')
      expect(resolveRequestUrl(request({ 'x-forwarded-proto': proto })).protocol).toBe(`${protocol}:`)
    },
  )

  it.each([{ 'x-forwarded-host': 'bad host' }, { 'x-forwarded-port': 'abc' }, { 'x-forwarded-prefix': '//attacker.test' }])(
    'answers 400 for a malformed trusted header %j', (headers) => {
      trustProxies('*', '10.0.0.8')
      expect(() => resolveRequestUrl(request(headers))).toThrow(HoloRequestUrlError)
    },
  )

  it('rate limits each visitor separately by default', async () => {
    trustProxies(['127.0.0.1'], '127.0.0.1')
    await rateLimit('login', { request: request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }) })
    const second = await rateLimit('login', { request: request({ 'x-forwarded-for': '203.0.113.99, 192.0.2.11' }) })
    expect(second.snapshot.key).toBe('ip:192.0.2.11')
    await expect(rateLimit('login', { request: request({ 'x-forwarded-for': '198.51.100.1, 192.0.2.10' }) }))
      .rejects.toMatchObject({ status: 429 })
  })

  it('fails closed with the configuration error when a default IP key has no known client address', async () => {
    trustProxies(undefined)
    const spoofed = request({ 'x-forwarded-for': '203.0.113.66' })
    await expect(rateLimit('login', { request: spoofed })).rejects.toThrow(
      '[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set TRUSTED_PROXIES to your proxy\'s addresses, or to * when the app is reachable only through your proxy. See https://docs.holo-js.com/basics/security/cors-and-proxies#trusted-proxies',
    )
    await expect(rateLimit('login', { request: spoofed })).rejects.not.toMatchObject({ status: 429 })
  })

  it('rate limits by the full IPv6 address, not its network prefix', async () => {
    trustProxies('*', '10.0.0.8')
    const first = await rateLimit('login', { request: request({ 'x-forwarded-for': '2001:db8::1' }) })
    const neighbour = await rateLimit('login', { request: request({ 'x-forwarded-for': '2001:db8::2' }) })
    expect(first.snapshot.key).toBe('ip:2001:db8::1')
    expect(neighbour.snapshot.key).toBe('ip:2001:db8::2')
  })

  it('defaults to trusting no proxies and rejects entries that are not addresses or ranges', () => {
    expect(normalizeSecurityConfig({}).trustedProxies).toEqual([])
    expect(normalizeSecurityConfig({ trustedProxies: ['10.0.0.0/8', '::1'] }).trustedProxies).toEqual(['10.0.0.0/8', '::1'])
    expect(() => normalizeSecurityConfig({ trustedProxies: ['cloudflare'] })).toThrow(
      '[@holo-js/security] trustedProxies entries must be IP addresses or CIDR ranges, received "cloudflare".',
    )
    expect(() => normalizeSecurityConfig({ trustedProxies: ['10.0.0.0/33'] })).toThrow('received "10.0.0.0/33"')
  })
})
