import { afterEach, describe, expect, it, vi } from 'vitest'
import { authRuntimeInternals } from '../src'

const JWKS_URL = 'https://issuer.test/.well-known/jwks.json'
const originalFetch = globalThis.fetch

type JwksCache = Parameters<typeof authRuntimeInternals.jwt.resolveCachedJwk>[0]

function createJwksProvider(): { healthy: boolean, requests: number } {
  const provider = { healthy: true, requests: 0 }
  globalThis.fetch = vi.fn(async () => {
    provider.requests += 1
    return provider.healthy
      ? new Response(JSON.stringify({ keys: [{ kid: 'old-key' }] }), { status: 200 })
      : new Response('unavailable', { status: 503 })
  }) as typeof fetch
  return provider
}

function resolveKey(cache: JwksCache, kid: string) {
  return authRuntimeInternals.jwt.resolveCachedJwk(cache, JWKS_URL, {
    requestUrl: JWKS_URL,
    kid,
    errorMessage: 'Failed to load JWKS.',
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('JWKS cache failure grace period', () => {
  it('keeps verifying with the last good key within the grace period after a failed refresh', async () => {
    const provider = createJwksProvider()
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })

    provider.healthy = false
    vi.setSystemTime(new Date('2030-01-01T00:05:00Z'))
    await expect(resolveKey(cache, 'rotated-key')).resolves.toBeUndefined()
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })
    expect(provider.requests).toBe(2)
  })

  it('fails closed after repeated failures once the grace period since the last successful fetch has passed', async () => {
    const provider = createJwksProvider()
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })

    provider.healthy = false
    vi.setSystemTime(new Date('2030-01-01T00:06:00Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })
    vi.setSystemTime(new Date('2030-01-01T00:10:01Z'))
    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
    vi.setSystemTime(new Date('2030-01-01T00:10:02Z'))
    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
  })

  it('does not extend the grace period when refreshes keep failing', async () => {
    const provider = createJwksProvider()
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })

    provider.healthy = false
    for (let minute = 1; minute <= 9; minute += 1) {
      vi.setSystemTime(new Date(Date.parse('2030-01-01T00:00:00Z') + minute * 60_000))
      await expect(resolveKey(cache, 'rotated-key')).resolves.toBeUndefined()
    }
    expect(provider.requests).toBe(10)

    vi.setSystemTime(new Date('2030-01-01T00:09:59Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })

    vi.setSystemTime(new Date('2030-01-01T00:10:01Z'))
    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
  })
})
