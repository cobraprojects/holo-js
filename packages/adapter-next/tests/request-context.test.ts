import { NextRequest } from 'next/server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { getCurrentNextRequest, runWithNextRequest, setNextAuthRequestRunner } from '../src/request-context'

describe('Next request context', () => {
  it('isolates requests and delegates through an installed runtime runner', async () => {
    const request = new NextRequest('https://app.test/request')
    expect(getCurrentNextRequest()).toBeUndefined()
    await runWithNextRequest(request, async () => {
      expect(getCurrentNextRequest()).toBe(request)
    })

    const runner = vi.fn()
    setNextAuthRequestRunner(<TValue>(callback: () => TValue): TValue => {
      runner()
      return callback()
    })
    expect(runWithNextRequest(request, () => 'result')).toBe('result')
    expect(runner).toHaveBeenCalledOnce()
  })
})

for (const first of ['auth', 'adapter'] as const) {
  it(`shares isolated request context when ${first} initializes first`, async () => {
    vi.resetModules()
    delete (globalThis as typeof globalThis & { __holoNextRequestStore?: unknown }).__holoNextRequestStore
    const auth = first === 'auth' ? await import('../../auth/src/next/request-context') : undefined
    const adapter = await import('../src/request-context')
    const authContext = auth ?? await import('../../auth/src/next/request-context')
    const outer = new NextRequest('https://app.test/outer', { headers: { cookie: 'holo_session=outer' } })
    const inner = new NextRequest('https://app.test/inner', { headers: { cookie: 'holo_session=inner' } })
    let release!: () => void
    const suspended = new Promise<void>(resolve => { release = resolve })
    const pending = authContext.runWithNextAuthRequest(outer, async () => {
      await suspended
      expect(adapter.getCurrentNextRequest()).toBe(outer)
      expect(adapter.getCurrentNextRequest()?.cookies.get('holo_session')?.value).toBe('outer')
      await expect(adapter.runWithNextRequest(inner, async () => {
        await Promise.resolve()
        expect(authContext.getCurrentNextAuthRequest()).toBe(inner)
        expect(authContext.getCurrentNextAuthRequest()?.cookies.get('holo_session')?.value).toBe('inner')
        throw new Error('nested failure')
      })).rejects.toThrow('nested failure')
      expect(authContext.getCurrentNextAuthRequest()).toBe(outer)
    })
    await adapter.runWithNextRequest(inner, async () => {
      release()
      await pending
      expect(authContext.getCurrentNextAuthRequest()).toBe(inner)
    })
    expect(adapter.getCurrentNextRequest()).toBeUndefined()
    expect(authContext.getCurrentNextAuthRequest()).toBeUndefined()
  })
}

it('preserves callback result inference and cleans up synchronous exceptions', () => {
  const request = new NextRequest('https://app.test/request')
  const result = runWithNextRequest(request, () => ({ status: 'ok' as const }))
  expectTypeOf(result).toEqualTypeOf<{ status: 'ok' }>()
  const promise = runWithNextRequest(request, async () => ({ status: 'ok' as const }))
  expectTypeOf(promise).toEqualTypeOf<Promise<{ status: 'ok' }>>()
  expect(() => runWithNextRequest(request, () => { throw new Error('failure') })).toThrow('failure')
  expect(getCurrentNextRequest()).toBeUndefined()
})

it('isolates Edge requests with native global asynchronous storage', async () => {
  vi.resetModules()
  delete (globalThis as typeof globalThis & { __holoNextRequestStore?: unknown }).__holoNextRequestStore
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage)
  try {
    const edge = await import('../../adapter-shared/src/next/request-context')
    const requests = [
      new NextRequest('https://app.test/request'),
      new NextRequest('https://app.test/request'),
    ]
    await Promise.all(requests.map(request => edge.runWithNextRequest(request, async () => {
      await Promise.resolve()
      expect(edge.getCurrentNextRequest()).toBe(request)
    })))
    expect(edge.getCurrentNextRequest()).toBeUndefined()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('reports unsupported request isolation without native asynchronous storage', async () => {
  vi.resetModules()
  delete (globalThis as typeof globalThis & { __holoNextRequestStore?: unknown }).__holoNextRequestStore
  vi.stubGlobal('AsyncLocalStorage', undefined)
  try {
    const edge = await import('../../adapter-shared/src/next/request-context')
    const request = new NextRequest('https://app.test/request')
    expect(() => edge.runWithNextRequest(request, () => 'unsafe')).toThrow('requires native AsyncLocalStorage')
  } finally {
    vi.unstubAllGlobals()
  }
})
