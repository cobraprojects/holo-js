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

function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason))
  })
}

function createStreamedResponse(totalBytes: number): Response {
  let remaining = totalBytes
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = Math.min(64 * 1024, remaining)
      remaining -= size
      if (size === 0) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(size))
    },
  }))
}

describe('JWKS fetch bounds', () => {
  it('fails a hanging JWKS fetch once the timeout elapses even when fetch ignores the abort signal', async () => {
    let requests = 0
    globalThis.fetch = vi.fn(() => {
      requests += 1
      return new Promise<Response>(() => {})
    }) as typeof fetch
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

    let outcome: string | undefined
    const pending = resolveKey(cache, 'old-key').then(
      () => { outcome = 'resolved' },
      () => { outcome = 'rejected' },
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(outcome).toBe('rejected')

    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
    expect(requests).toBe(1)
  })

  it('counts a timed-out refresh as a failed refresh covered by the failure grace period', async () => {
    let isHanging = false
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!isHanging) {
        return new Response(JSON.stringify({ keys: [{ kid: 'old-key' }] }), { status: 200 })
      }
      return hangUntilAborted(init?.signal)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })

    isHanging = true
    vi.setSystemTime(new Date('2030-01-01T00:05:00Z'))
    const refresh = resolveKey(cache, 'rotated-key')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(refresh).resolves.toBeUndefined()
    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date('2030-01-01T00:10:00Z'))
    const expired = resolveKey(cache, 'old-key').then(() => 'resolved', () => 'rejected')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(expired).resolves.toBe('rejected')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails a JWKS body that stalls mid-stream once the timeout elapses', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]))
      },
    }))) as typeof fetch
    const cache: JwksCache = new Map()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

    const refresh = resolveKey(cache, 'old-key').then(() => 'resolved', () => 'rejected')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(refresh).resolves.toBe('rejected')
  })

  it('accepts a JWKS response that starts with a UTF-8 byte order mark', async () => {
    globalThis.fetch = vi.fn(async () => new Response('\uFEFF{"keys":[{"kid":"old-key"}]}', { status: 200 })) as typeof fetch
    const cache: JwksCache = new Map()

    await expect(resolveKey(cache, 'old-key')).resolves.toMatchObject({ kid: 'old-key' })
  })

  it('rejects a JWKS response that declares a body larger than the size limit', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"keys":[]}', {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    })) as typeof fetch
    const cache: JwksCache = new Map()

    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
  })

  it('cancels a JWKS body that declares a size over the limit instead of leaving it open', async () => {
    let cancelled = false
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    }), {
      status: 200,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    })) as typeof fetch
    const cache: JwksCache = new Map()

    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
    expect(cancelled).toBe(true)
  })

  it('rejects a JWKS response body that grows past the size limit without a declared length', async () => {
    globalThis.fetch = vi.fn(async () => createStreamedResponse(1024 * 1024 + 1)) as typeof fetch
    const cache: JwksCache = new Map()

    await expect(resolveKey(cache, 'old-key')).rejects.toThrow('Failed to load JWKS.')
  })
})
