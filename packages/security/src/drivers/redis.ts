import type { SecurityRateLimitHitResult, SecurityRateLimitRedisDriverAdapter, SecurityRateLimitStore } from '../contracts'

export interface RedisRateLimitStoreOptions {
  readonly now?: () => Date
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`[@holo-js/security] Redis rate-limit adapter ${label} must be a non-negative integer.`)
  }

  return value
}

function createSnapshot(
  key: string,
  attempts: number,
  maxAttempts: number,
  expiresAt: Date,
): SecurityRateLimitHitResult['snapshot'] {
  return Object.freeze({
    limiter: '',
    key,
    attempts,
    maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - attempts),
    expiresAt,
  })
}

export function createRedisRateLimitStore(
  adapter: SecurityRateLimitRedisDriverAdapter,
  options: RedisRateLimitStoreOptions = {},
): SecurityRateLimitStore {
  const resolveNow = options.now ?? (() => new Date())

  return {
    async hit(key, hitOptions) {
      const result = await adapter.increment(key, {
        decaySeconds: hitOptions.decaySeconds,
      })
      const attempts = assertNonNegativeInteger(result.attempts, 'attempts')
      const ttlSeconds = assertNonNegativeInteger(result.ttlSeconds, 'ttlSeconds')
      const now = resolveNow()
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)

      return Object.freeze({
        limited: attempts > hitOptions.maxAttempts,
        snapshot: createSnapshot(key, attempts, hitOptions.maxAttempts, expiresAt),
        retryAfterSeconds: ttlSeconds,
      })
    },
    async clear(key) {
      const deleted = await adapter.del(key)
      return assertNonNegativeInteger(deleted, 'del() result') > 0
    },
    async clearByPrefix(prefix) {
      if (typeof adapter.clearByPrefix !== 'function') {
        return 0
      }

      const cleared = await adapter.clearByPrefix(prefix)
      return assertNonNegativeInteger(cleared, 'clearByPrefix() result')
    },
    async clearAll() {
      if (typeof adapter.clearAll !== 'function') {
        return 0
      }

      const cleared = await adapter.clearAll()
      return assertNonNegativeInteger(cleared, 'clearAll() result')
    },
  }
}

export const redisRateLimitDriverInternals = {
  assertNonNegativeInteger,
  createSnapshot,
}
