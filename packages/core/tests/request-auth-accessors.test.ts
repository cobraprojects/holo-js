import { createAsyncAuthContext } from '@holo-js/auth'
import { describe, expect, it } from 'vitest'
import { createRequestAwareAuthContext } from '../src/portable/authRequestContext'

function accessors(id: string) {
  const request = new Request('https://example.test', { headers: { 'x-request-id': id } })
  return { getHeader: (name: string) => request.headers.get(name) ?? undefined }
}

describe('auth request accessor configuration', () => {
  it('updates defaults without replacing a running request and preserves concurrent request isolation', async () => {
    const context = createRequestAwareAuthContext(createAsyncAuthContext(), accessors('initial'))
    expect(await context.getRequestHeader?.('x-request-id')).toBe('initial')
    await Promise.all(['request-a', 'request-b'].map(id => context.runWithRequestAccessors(accessors(id), async () => {
      context.setRequestAccessors(accessors('updated'))
      await Promise.resolve()
      expect(await context.getRequestHeader?.('x-request-id')).toBe(id)
    })))
    expect(await context.getRequestHeader?.('x-request-id')).toBe('updated')
    context.setRequestAccessors(undefined)
    expect(await context.getRequestHeader?.('x-request-id')).toBeUndefined()
  })
})
