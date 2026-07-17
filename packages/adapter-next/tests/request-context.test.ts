import { describe, expect, it, vi } from 'vitest'
import { getCurrentNextRequest, runWithNextRequest, setNextAuthRequestRunner } from '../src/request-context'

describe('Next request context', () => {
  it('isolates requests and delegates through an installed runtime runner', async () => {
    const request = { headers: new Headers(), cookies: { get: () => undefined } }
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
