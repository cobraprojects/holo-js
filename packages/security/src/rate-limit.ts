import type { NormalizedSecurityLimiterConfig } from '@holo-js/config'
import {
  SecurityRateLimitError,
  ip,
  type SecurityClearRateLimitOptions,
  type SecurityRateLimitCallOptions,
  type SecurityRateLimitHitResult,
} from './contracts'
import { getSecurityRuntime } from './runtime'

function encodeBucketPart(value: string): string {
  return encodeURIComponent(value)
}

function createLimiterPrefix(limiter: string): string {
  return `limiter:${encodeBucketPart(limiter)}|`
}

function createBucketKey(limiter: string, key: string): string {
  return `${createLimiterPrefix(limiter)}${encodeBucketPart(key)}`
}

function getRateLimitStore() {
  const store = getSecurityRuntime().rateLimitStore
  if (!store) {
    throw new Error('[@holo-js/security] Rate-limit store is not configured yet.')
  }

  return store
}

function resolveLimiterConfig(name: string): NormalizedSecurityLimiterConfig {
  const limiter = getSecurityRuntime().config.rateLimit.limiters[name]
  if (!limiter) {
    throw new Error(`[@holo-js/security] Rate limiter "${name}" is not defined in config/security.ts.`)
  }

  return limiter
}

function normalizeResolvedLimiterKey(
  value: string | number | null | undefined,
  label: string,
): string {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  throw new TypeError(`[@holo-js/security] ${label} must resolve a non-empty string key.`)
}

export async function defaultRateLimitKey(request: Request): Promise<string> {
  const runtimeDefaultKey = await getSecurityRuntime().defaultKeyResolver?.(request)
  if (typeof runtimeDefaultKey !== 'undefined' && runtimeDefaultKey !== null) {
    return normalizeResolvedLimiterKey(runtimeDefaultKey, 'Default rate limiter key resolver')
  }

  return `ip:${ip(request, true)}`
}

async function resolveLimiterKey(
  name: string,
  limiter: NormalizedSecurityLimiterConfig,
  options: SecurityRateLimitCallOptions,
): Promise<string> {
  if (typeof options.key === 'string' && options.key.length > 0) {
    return options.key
  }

  if (limiter.key) {
    if (!options.request) {
      throw new TypeError(`[@holo-js/security] Rate limiter "${name}" requires a request when using its configured key resolver.`)
    }

    const resolved = await limiter.key({
      request: options.request,
      values: options.values,
    })
    return normalizeResolvedLimiterKey(resolved, `Rate limiter "${name}"`)
  }

  if (options.request) {
    return await defaultRateLimitKey(options.request)
  }

  throw new TypeError(`[@holo-js/security] Rate limiter "${name}" requires either an explicit key or a request for the default key resolver.`)
}

export async function rateLimit(name: string, options: SecurityRateLimitCallOptions): Promise<SecurityRateLimitHitResult> {
  const limiter = resolveLimiterConfig(name)
  const resolvedKey = await resolveLimiterKey(name, limiter, options)
  const bucketKey = createBucketKey(name, resolvedKey)
  const result = await getRateLimitStore().hit(bucketKey, {
    maxAttempts: limiter.maxAttempts,
    decaySeconds: limiter.decaySeconds,
  })

  const snapshot = Object.freeze({
    limiter: name,
    key: resolvedKey,
    attempts: result.snapshot.attempts,
    maxAttempts: limiter.maxAttempts,
    remainingAttempts: Math.max(0, limiter.maxAttempts - result.snapshot.attempts),
    expiresAt: result.snapshot.expiresAt,
  })
  const normalizedResult = Object.freeze({
    limited: result.limited,
    snapshot,
    retryAfterSeconds: result.retryAfterSeconds,
  }) satisfies SecurityRateLimitHitResult

  if (normalizedResult.limited) {
    throw new SecurityRateLimitError(undefined, {
      retryAfterSeconds: normalizedResult.retryAfterSeconds,
      snapshot,
    })
  }

  return normalizedResult
}

export async function clearRateLimit(options: SecurityClearRateLimitOptions): Promise<boolean | number> {
  const store = getRateLimitStore()

  if (options.all && (options.limiter || options.key)) {
    throw new TypeError('[@holo-js/security] clearRateLimit(...) must use either { all: true } or a scoped limiter/key pair, not both.')
  }

  if (options.all) {
    return await store.clearAll()
  }

  if (!options.limiter) {
    throw new TypeError('[@holo-js/security] clearRateLimit(...) requires a limiter name unless { all: true } is used.')
  }

  if (typeof options.key === 'string' && options.key.length > 0) {
    return await store.clear(createBucketKey(options.limiter, options.key))
  }

  return await store.clearByPrefix(createLimiterPrefix(options.limiter))
}

export const rateLimitInternals = {
  createBucketKey,
  createLimiterPrefix,
  encodeBucketPart,
  defaultRateLimitKey,
  getRateLimitStore,
  normalizeResolvedLimiterKey,
  resolveLimiterConfig,
  resolveLimiterKey,
}
