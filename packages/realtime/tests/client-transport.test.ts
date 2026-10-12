import { afterEach, describe, expect, it, vi } from 'vitest'
import { realtimeClientInternals, resetRealtimeClientRuntime } from '../src/client'
import { createWireError, RealtimeAuthorizationError, RealtimeClientError } from '../src/client/errors'

afterEach(() => {
  resetRealtimeClientRuntime()
  vi.restoreAllMocks()
})

describe('@holo-js/realtime broadcast client transport', () => {
  it('reports transport availability without escalating non-errors', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handledErrors: unknown[] = []

    realtimeClientInternals.getRealtimeClientState().framework = {
      handleError: error => handledErrors.push(error),
    }

    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError('missing')).toBe(false)
    realtimeClientInternals.handleRealtimeConnectionError('missing')

    expect(consoleWarn).toHaveBeenCalledWith(`[@holo-js/realtime] ${realtimeClientInternals.unavailableTransportMessage}`)
    expect(handledErrors).toEqual(['missing'])
  })

  it('recognizes availability errors and normalizes wire errors', () => {
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error(realtimeClientInternals.missingTransportMessage),
    )).toBe(true)
    expect(realtimeClientInternals.isRealtimeTransportAvailabilityError(
      new Error('Realtime broadcast config failed with HTTP 503.'),
    )).toBe(true)

    const authorizationError = createWireError({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })
    expect(authorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(authorizationError).toMatchObject({
      code: 'forbidden',
      kind: 'authorization',
      message: 'No access',
      name: 'ForbiddenError',
      status: 403,
    })

    const defaultAuthorizationError = createWireError({
      kind: 'authorization',
      message: 'No access',
    })
    expect(defaultAuthorizationError).toBeInstanceOf(RealtimeAuthorizationError)
    expect(defaultAuthorizationError).toMatchObject({
      kind: 'authorization',
      message: 'No access',
      name: 'RealtimeAuthorizationError',
    })

    const fallbackError = createWireError({
      kind: 'invalid',
      message: 1,
      status: 200,
    })
    expect(fallbackError).toBeInstanceOf(RealtimeClientError)
    expect(fallbackError).toMatchObject({
      kind: 'runtime',
      message: realtimeClientInternals.unavailableTransportMessage,
      status: undefined,
    })
  })

})
