import type { SecurityRateLimitHitResult, SecurityRateLimitStore } from '../contracts'

type MemoryRateLimitBucket = {
  key: string
  attempts: number
  expiresAt: Date
}

export interface MemoryRateLimitStoreOptions {
  readonly now?: () => Date
}

function createSnapshot(
  key: string,
  bucket: MemoryRateLimitBucket,
  maxAttempts: number,
): SecurityRateLimitHitResult['snapshot'] {
  return Object.freeze({
    limiter: '',
    key,
    attempts: bucket.attempts,
    maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - bucket.attempts),
    expiresAt: bucket.expiresAt,
  })
}

function isExpired(bucket: MemoryRateLimitBucket, now: Date): boolean {
  return bucket.expiresAt.getTime() <= now.getTime()
}

export function createMemoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): SecurityRateLimitStore {
  const buckets = new Map<string, MemoryRateLimitBucket>()
  const resolveNow = options.now ?? (() => new Date())

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
  }
}

export const memoryRateLimitDriverInternals = {
  createSnapshot,
  isExpired,
}
