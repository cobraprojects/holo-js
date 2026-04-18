import type { SecurityRateLimitHitResult, SecurityRateLimitStore } from '../contracts'

type MemoryRateLimitBucket = {
  key: string
  attempts: number
  expiresAt: Date
}

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
  const maxBuckets = options.maxBuckets
  if (typeof maxBuckets !== 'undefined' && (!Number.isInteger(maxBuckets) || maxBuckets < 1)) {
    throw new TypeError('[@holo-js/security] Memory rate-limit store maxBuckets must be an integer greater than or equal to 1.')
  }

  const pruneIntervalMs = typeof options.pruneIntervalMs === 'number' ? options.pruneIntervalMs : 60_000
  if (!Number.isInteger(pruneIntervalMs) || pruneIntervalMs < 1) {
    throw new TypeError('[@holo-js/security] Memory rate-limit store pruneIntervalMs must be an integer greater than or equal to 1.')
  }

  const pruneExpiredBuckets = (): void => {
    const now = resolveNow()

    for (const [key, bucket] of buckets) {
      if (isExpired(bucket, now)) {
        buckets.delete(key)
      }
    }
  }

  const pruneTimer = setInterval(pruneExpiredBuckets, pruneIntervalMs)
  pruneTimer.unref?.()

  const evictOldestBucket = (): void => {
    const oldestKey = buckets.keys().next().value as string | undefined
    if (oldestKey) {
      buckets.delete(oldestKey)
    }
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

      if (!active && typeof maxBuckets === 'number') {
        while (buckets.size >= maxBuckets) {
          evictOldestBucket()
        }
      }

      if (active) {
        buckets.delete(key)
      }

      buckets.set(key, bucket)

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
