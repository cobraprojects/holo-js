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
      '[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set trustedProxies in config/security.ts so Holo can read it from your proxy.',
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

  it('trusts the proxy in front of a framework that does not expose the connection address', () => {
    trustProxies('*')
    expect(ip(request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }))).toBe('192.0.2.10')
  })

  it('reads the RFC 7239 Forwarded header the same way', () => {
    trustProxies('*', '10.0.0.8')
    const forwarded = request({ forwarded: 'for=203.0.113.66;host=attacker.test, for="[2001:db8::7]:4711";proto=https;host="app.test:8443"' })
    expect(ip(forwarded)).toBe('2001:db8::7')
    expect(resolveRequestUrl(forwarded).href).toBe('https://app.test:8443/login')
  })

  it.each([
    ['for="[2001:db8::7]:4711"', '2001:db8::7'],
    ['for=192.0.2.43:47011', '192.0.2.43'],
    ['for=_hidden', '_hidden'],
    ['proto=https', '10.0.0.8'],
  ])('identifies the Forwarded client %s as %s, without ports and falling back to the proxy', (forwarded, address) => {
    trustProxies('*', '10.0.0.8')
    expect(ip(request({ forwarded }))).toBe(address)
  })

  it('rejects requests whose Forwarded and X-Forwarded headers disagree', () => {
    trustProxies('*', '10.0.0.8')
    const conflicting = request({ 'x-forwarded-for': '192.0.2.10', forwarded: 'for=203.0.113.66' })
    expect(() => ip(conflicting)).toThrow(HoloRequestUrlError)
    expect(() => resolveRequestUrl(conflicting)).toThrow('Forwarded and X-Forwarded headers must describe the same client.')
  })

  it('rate limits each visitor separately by default', async () => {
    trustProxies(['127.0.0.1'], '127.0.0.1')
    await rateLimit('login', { request: request({ 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }) })
    const second = await rateLimit('login', { request: request({ 'x-forwarded-for': '203.0.113.99, 192.0.2.11' }) })
    expect(second.snapshot.key).toBe('ip:192.0.2.11')
    await expect(rateLimit('login', { request: request({ 'x-forwarded-for': '198.51.100.1, 192.0.2.10' }) }))
      .rejects.toMatchObject({ status: 429 })
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
