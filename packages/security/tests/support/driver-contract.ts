import { describe, expect, it } from 'vitest'
import type { SecurityRateLimitStore } from '../../src'

export interface RateLimitDriverContractOptions {
  readonly label: string
  createStore(): Promise<SecurityRateLimitStore> | SecurityRateLimitStore
  cleanup?(): Promise<void> | void
  advancePastExpiry?(): Promise<void> | void
  supportsPersistence?: boolean
  recreateStore?(): Promise<SecurityRateLimitStore> | SecurityRateLimitStore
}

export function runRateLimitDriverContractSuite(options: RateLimitDriverContractOptions): void {
  describe(`${options.label} rate-limit driver contract`, () => {
    it('increments, limits, reports retry timing, and clears exact buckets', async () => {
      const store = await options.createStore()

      const first = await store.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const second = await store.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const third = await store.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      expect(first).toMatchObject({
        limited: false,
        snapshot: {
          key: 'limiter:login|user:1',
          attempts: 1,
          maxAttempts: 2,
          remainingAttempts: 1,
        },
        retryAfterSeconds: 60,
      })
      expect(second.snapshot.remainingAttempts).toBe(0)
      expect(third).toMatchObject({
        limited: true,
        snapshot: {
          attempts: 3,
          remainingAttempts: 0,
        },
      })

      await expect(store.clear('limiter:login|user:1')).resolves.toBe(true)
      await expect(store.clear('limiter:login|user:1')).resolves.toBe(false)
      await options.cleanup?.()
    })

    it('clears limiter namespaces and all buckets', async () => {
      const store = await options.createStore()

      await store.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await store.hit('limiter:login|user:2', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await store.hit('limiter:register|user:3', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(2)
      await expect(store.clearAll()).resolves.toBe(1)
      await options.cleanup?.()
    })

    it('resets expired buckets on the next hit', async () => {
      const store = await options.createStore()

      const first = await store.hit('limiter:login|user:expiry', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      expect(first.snapshot.attempts).toBe(1)

      if (options.advancePastExpiry) {
        await options.advancePastExpiry()
      }

      const expired = await store.hit('limiter:login|user:expiry', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      expect(expired.snapshot.attempts).toBe(options.advancePastExpiry ? 1 : 2)
      await options.cleanup?.()
    })

    if (options.supportsPersistence && options.recreateStore) {
      it('persists buckets across store re-instantiation', async () => {
        const firstStore = await options.createStore()

        await firstStore.hit('limiter:login|user:persisted', {
          maxAttempts: 2,
          decaySeconds: 60,
        })

        const secondStore = await options.recreateStore()
        const next = await secondStore.hit('limiter:login|user:persisted', {
          maxAttempts: 2,
          decaySeconds: 60,
        })

        expect(next.snapshot.attempts).toBe(2)
        await options.cleanup?.()
      })
    }
  })
}
