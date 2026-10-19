import { describe, expect, it } from 'vitest'
import type { SecurityRateLimitStore } from '../../src'

export interface RateLimitDriverContractOptions {
  readonly label: string
  readonly decaySeconds?: number
  createStore(): Promise<SecurityRateLimitStore> | SecurityRateLimitStore
  cleanup?(): Promise<void> | void
  advanceSeconds(seconds: number): Promise<void> | void
  supportsPersistence?: boolean
  recreateStore?(): Promise<SecurityRateLimitStore> | SecurityRateLimitStore
}

const CONTRACT_TEST_TIMEOUT_MS = 15_000

export function runRateLimitDriverContractSuite(options: RateLimitDriverContractOptions): void {
  const decaySeconds = options.decaySeconds ?? 60

  describe(`${options.label} rate-limit driver contract`, () => {
    it('increments, limits, reports retry timing, and clears exact buckets', async () => {
      try {
        const store = await options.createStore()

        const first = await store.hit('limiter:login|user:1', {
          maxAttempts: 2,
          decaySeconds,
        })
        const second = await store.hit('limiter:login|user:1', {
          maxAttempts: 2,
          decaySeconds,
        })
        const third = await store.hit('limiter:login|user:1', {
          maxAttempts: 2,
          decaySeconds,
        })

        expect(first).toMatchObject({
          limited: false,
          snapshot: {
            key: 'limiter:login|user:1',
            attempts: 1,
            maxAttempts: 2,
            remainingAttempts: 1,
          },
          retryAfterSeconds: decaySeconds,
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
      } finally {
        await options.cleanup?.()
      }
    }, CONTRACT_TEST_TIMEOUT_MS)

    it('clears limiter namespaces and all buckets', async () => {
      try {
        const store = await options.createStore()

        await store.hit('limiter:login|user:1', {
          maxAttempts: 2,
          decaySeconds,
        })
        await store.hit('limiter:login|user:2', {
          maxAttempts: 2,
          decaySeconds,
        })
        await store.hit('limiter:register|user:3', {
          maxAttempts: 2,
          decaySeconds,
        })

        await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(2)
        await expect(store.clearAll()).resolves.toBe(1)
      } finally {
        await options.cleanup?.()
      }
    }, CONTRACT_TEST_TIMEOUT_MS)

    it('keeps one fixed window from the first hit and does not extend it on rejected hits', async () => {
      try {
        const store = await options.createStore()
        const rejectedAfterSeconds = decaySeconds - 1
        const hit = () => store.hit('limiter:login|user:window', {
          maxAttempts: 1,
          decaySeconds,
        })

        expect(await hit()).toMatchObject({
          limited: false,
          snapshot: { attempts: 1 },
          retryAfterSeconds: decaySeconds,
        })

        await options.advanceSeconds(rejectedAfterSeconds)
        expect(await hit()).toMatchObject({
          limited: true,
          snapshot: { attempts: 2 },
          retryAfterSeconds: 1,
        })

        await options.advanceSeconds(2)
        expect(await hit()).toMatchObject({
          limited: false,
          snapshot: { attempts: 1 },
          retryAfterSeconds: decaySeconds,
        })
      } finally {
        await options.cleanup?.()
      }
    }, CONTRACT_TEST_TIMEOUT_MS)

    it('resets expired buckets on the next hit', async () => {
      try {
        const store = await options.createStore()

        const first = await store.hit('limiter:login|user:expiry', {
          maxAttempts: 2,
          decaySeconds,
        })
        expect(first.snapshot.attempts).toBe(1)

        await options.advanceSeconds(decaySeconds + 1)

        const expired = await store.hit('limiter:login|user:expiry', {
          maxAttempts: 2,
          decaySeconds,
        })

        expect(expired.snapshot.attempts).toBe(1)
        await expect(store.clear('limiter:login|user:expiry')).resolves.toBe(true)
      } finally {
        await options.cleanup?.()
      }
    }, CONTRACT_TEST_TIMEOUT_MS)

    if (options.supportsPersistence && options.recreateStore) {
      it('persists buckets across store re-instantiation', async () => {
        try {
          const firstStore = await options.createStore()

          await firstStore.hit('limiter:login|user:persisted', {
            maxAttempts: 2,
            decaySeconds,
          })

          const secondStore = await options.recreateStore()
          const next = await secondStore.hit('limiter:login|user:persisted', {
            maxAttempts: 2,
            decaySeconds,
          })

          expect(next.snapshot.attempts).toBe(2)
        } finally {
          await options.cleanup?.()
        }
      }, CONTRACT_TEST_TIMEOUT_MS)
    }
  })
}
