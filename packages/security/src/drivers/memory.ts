import { reportError } from '@holo-js/kernel/error-reporting'
import type { SecurityRateLimitHitResult, SecurityRateLimitStore } from '../contracts'

type MemoryRateLimitBucket = {
  key: string
  attempts: number
  expiresAt: Date
}

const DEFAULT_MEMORY_MAX_BUCKETS = 10_000

export interface MemoryRateLimitStoreOptions {
  readonly now?: () => Date
  readonly maxBuckets?: number
  readonly pruneIntervalMs?: number
}

function createSnapshot(
  key: string,
  bucket: MemoryRateLimitBucket,
  maxAttempts: number,
): SecurityRateLimitHitResult['snapshot'] {
  const expiresAt = new Date(bucket.expiresAt.getTime())

  return Object.freeze({
    limiter: '',
    key,
    attempts: bucket.attempts,
    maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - bucket.attempts),
    expiresAt,
  })
}

function isExpired(bucket: MemoryRateLimitBucket, now: Date): boolean {
  return bucket.expiresAt.getTime() <= now.getTime()
}

export function createMemoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): SecurityRateLimitStore {
  const buckets = new Map<string, MemoryRateLimitBucket>()
  const resolveNow = options.now ?? (() => new Date())
  const maxBuckets = options.maxBuckets ?? DEFAULT_MEMORY_MAX_BUCKETS
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
    throw new TypeError('[@holo-js/security] Memory rate-limit store maxBuckets must be an integer greater than or equal to 1.')
  }

  const pruneIntervalMs = typeof options.pruneIntervalMs === 'number' ? options.pruneIntervalMs : 60_000
  if (!Number.isInteger(pruneIntervalMs) || pruneIntervalMs < 1) {
    throw new TypeError('[@holo-js/security] Memory rate-limit store pruneIntervalMs must be an integer greater than or equal to 1.')
  }

  let nextExpiryAt = Number.POSITIVE_INFINITY

  const pruneExpiredBuckets = (now: Date): void => {
    nextExpiryAt = Number.POSITIVE_INFINITY

    for (const [key, bucket] of buckets) {
      if (isExpired(bucket, now)) {
        buckets.delete(key)
      } else {
        nextExpiryAt = Math.min(nextExpiryAt, bucket.expiresAt.getTime())
      }
    }
  }

  const pruneTimer = setInterval(() => pruneExpiredBuckets(resolveNow()), pruneIntervalMs)
  pruneTimer.unref?.()

  let capacityReportedUntil = Number.NEGATIVE_INFINITY

  const reportCapacity = (now: Date, decaySeconds: number): void => {
    if (now.getTime() < capacityReportedUntil) {
      return
    }

    capacityReportedUntil = now.getTime() + decaySeconds * 1000
    reportError(
      new Error(`[@holo-js/security] Memory rate-limit store is at capacity (${maxBuckets} keys). New keys are limited until buckets expire. Use the redis or file rate-limit driver for high-cardinality limiters.`),
      { capability: 'security', operation: 'rate-limit memory store at capacity' },
    )
  }

  return {
    async hit(key, hitOptions) {
      const now = resolveNow()
      const existing = buckets.get(key)
      if (existing && isExpired(existing, now)) {
        buckets.delete(key)
      }

      const active = buckets.get(key)
      const bucket = active
        ? {
            ...active,
            attempts: active.attempts + 1,
          }
        : {
            key,
            attempts: 1,
            expiresAt: new Date(now.getTime() + hitOptions.decaySeconds * 1000),
          }

      if (!active && buckets.size >= maxBuckets) {
        if (now.getTime() >= nextExpiryAt) {
          pruneExpiredBuckets(now)
        }

        if (buckets.size >= maxBuckets) {
          reportCapacity(now, hitOptions.decaySeconds)
          return Object.freeze({
            limited: true,
            snapshot: createSnapshot(key, {
              key,
              attempts: hitOptions.maxAttempts + 1,
              expiresAt: new Date(now.getTime() + hitOptions.decaySeconds * 1000),
            }, hitOptions.maxAttempts),
            retryAfterSeconds: hitOptions.decaySeconds,
          })
        }
      }

      if (active) {
        buckets.delete(key)
      }

      buckets.set(key, bucket)
      nextExpiryAt = Math.min(nextExpiryAt, bucket.expiresAt.getTime())

      return Object.freeze({
        limited: bucket.attempts > hitOptions.maxAttempts,
        snapshot: createSnapshot(key, bucket, hitOptions.maxAttempts),
        retryAfterSeconds: Math.max(0, Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000)),
      })
    },
    async clear(key) {
      return buckets.delete(key)
    },
    async clearByPrefix(prefix) {
      let cleared = 0

      for (const key of buckets.keys()) {
        if (!key.startsWith(prefix)) {
          continue
        }

        buckets.delete(key)
        cleared += 1
      }

      return cleared
    },
    async clearAll() {
      const cleared = buckets.size
      buckets.clear()
      return cleared
    },
    async close() {
      clearInterval(pruneTimer)
    },
  }
}

export const memoryRateLimitDriverInternals = {
  createSnapshot,
  isExpired,
}
