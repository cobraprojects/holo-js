import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishesWithoutTheClock, useFakeClock } from '../../../tests/support/fake-clock'

describe('finishesWithoutTheClock', () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown): void => { unhandled.push(reason) }

  beforeEach(() => {
    unhandled.length = 0
    process.prependListener('unhandledRejection', record)
    useFakeClock()
  })

  afterEach(() => {
    vi.useRealTimers()
    process.off('unhandledRejection', record)
  })

  it('surfaces a rejected operation as its own failure, not as an unhandled rejection', async () => {
    const failure = new Error('release failed')
    await expect(finishesWithoutTheClock((async () => {
      await Promise.resolve()
      throw failure
    })(), 'A failing release')).rejects.toBe(failure)
    await new Promise(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
  })
})
