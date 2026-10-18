import { requestUrlInternals } from '@holo-js/kernel'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { authOnly } from '../../auth/src/sveltekit/server'
import { getCurrentSvelteKitRequestEvent } from '../../adapter-shared/src/sveltekit/request-context'
import { runWithSvelteKitRequestEvent } from '../src'

function createEvent(value: string) {
  return {
    url: new URL('https://app.test/login'),
    request: new Request('https://app.test/login', { headers: { 'x-request-id': value } }),
    cookies: { get: () => value, set() {} },
  }
}

describe('SvelteKit request context', () => {
  it('shares isolated context across standalone auth and adapter scopes, restoring nested failures', async () => {
    const guard = authOnly({ redirectTo: '/login', routes: ['/protected'] })
    const first = createEvent('first')
    const second = createEvent('second')
    let releaseFirst: () => void = () => {}
    const waiting = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstResponse = guard({ event: first, resolve: async (event) => {
      expect(getCurrentSvelteKitRequestEvent()?.cookies.get('session')).toBe('first')
      await waiting
      await expect(runWithSvelteKitRequestEvent(second, async () => {
        expect(getCurrentSvelteKitRequestEvent()?.request.headers.get('x-request-id')).toBe('second')
        throw new Error('nested failure')
      })).rejects.toThrow('nested failure')
      expect(getCurrentSvelteKitRequestEvent()?.request).toBe(event.request)
      return new Response('first')
    } })
    const secondResponse = runWithSvelteKitRequestEvent(second, async () => guard({
      event: { ...second },
      resolve: async () => {
        await Promise.resolve()
        expect(getCurrentSvelteKitRequestEvent()?.cookies.get('session')).toBe('second')
        releaseFirst()
        return new Response('second')
      },
    }))
    expect(await (await firstResponse).text()).toBe('first')
    expect(await (await secondResponse).text()).toBe('second')
    expect(getCurrentSvelteKitRequestEvent()).toBeUndefined()
    expectTypeOf(runWithSvelteKitRequestEvent(first, () => 'value' as const)).toEqualTypeOf<'value'>()
  })

  it('exposes each request\'s client address to Holo while it is handled', async () => {
    const withAddress = (value: string, address: () => string) => ({ ...createEvent(value), getClientAddress: address })
    const seen = await Promise.all([
      runWithSvelteKitRequestEvent(withAddress('first', () => '203.0.113.5'), async () => {
        await Promise.resolve()
        return requestUrlInternals.currentConnectionAddress()
      }),
      runWithSvelteKitRequestEvent(withAddress('second', () => '198.51.100.9'), () => requestUrlInternals.currentConnectionAddress()),
      runWithSvelteKitRequestEvent(withAddress('prerendered', () => {
        throw new Error('Cannot call getClientAddress() during prerendering')
      }), () => requestUrlInternals.currentConnectionAddress()),
    ])
    expect(seen).toEqual(['203.0.113.5', '198.51.100.9', undefined])
    expect(requestUrlInternals.currentConnectionAddress()).toBeUndefined()
  })
})
