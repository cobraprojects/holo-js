import { describe, expect, it, vi } from 'vitest'
import { adapterNextRealtimeInternals } from '../src/realtime'

describe('Next realtime internals', () => {
  it('ignores non-HTTP errors and notifies removable listeners for HTTP errors', () => {
    const listener = vi.fn()
    const unsubscribe = adapterNextRealtimeInternals.subscribeRealtimeError(listener)
    adapterNextRealtimeInternals.emitRealtimeError(new Error('ordinary'))
    expect(listener).not.toHaveBeenCalled()
    adapterNextRealtimeInternals.emitRealtimeError({ status: 403, message: 'Denied' })
    expect(listener).toHaveBeenCalledOnce()
    expect(adapterNextRealtimeInternals.getRealtimeErrorSnapshot()).toMatchObject({
      message: 'Denied', digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
    })
    expect(adapterNextRealtimeInternals.consumeRealtimeError()).toMatchObject({ message: 'Denied' })
    expect(adapterNextRealtimeInternals.getRealtimeErrorSnapshot()).toBeUndefined()
    unsubscribe()
    adapterNextRealtimeInternals.emitRealtimeError({ status: 404, message: 'Missing' })
    expect(listener).toHaveBeenCalledOnce()
    adapterNextRealtimeInternals.consumeRealtimeError()
  })

  it('wraps query, mutation, and subscription transport failures', async () => {
    const failure = { status: 500, message: 'Transport failed' }
    const onError = vi.fn()
    const unsubscribe = vi.fn()
    const transport = adapterNextRealtimeInternals.createErrorHandlingRealtimeTransport({
      query: vi.fn().mockRejectedValue(failure),
      mutate: vi.fn().mockRejectedValue(failure),
      subscribe(_name, _args, _listener, handleError) {
        handleError(failure)
        return unsubscribe
      },
    })
    await expect(transport.query('posts.list', {})).rejects.toBe(failure)
    adapterNextRealtimeInternals.consumeRealtimeError()
    await expect(transport.mutate('posts.update', {})).rejects.toBe(failure)
    adapterNextRealtimeInternals.consumeRealtimeError()
    expect(transport.subscribe('posts.list', {}, vi.fn(), onError)).toBe(unsubscribe)
    expect(onError).toHaveBeenCalledWith(failure)
    adapterNextRealtimeInternals.consumeRealtimeError()
  })
})
