import { normalizeSecurityConfig, type HoloSecurityConfig, type NormalizedHoloSecurityConfig } from '@holo-js/config'
import type {
  SecurityLimiterConfig,
  SecurityRateLimitFileConfig,
  SecurityRateLimitKeyResolver,
  SecurityRateLimitMemoryConfig,
  SecurityRateLimitRedisConfig,
} from '@holo-js/config'

export type {
  HoloSecurityConfig,
  HoloSecurityCsrfConfig,
  HoloSecurityRateLimitConfig,
  NormalizedHoloSecurityConfig,
  NormalizedHoloSecurityCsrfConfig,
  NormalizedHoloSecurityRateLimitConfig,
  NormalizedSecurityLimiterConfig,
  SecurityLimiterConfig,
  SecurityRateLimitContext,
  SecurityRateLimitDriver,
  SecurityRateLimitFileConfig,
  SecurityRateLimitKeyResolver,
  SecurityRateLimitMemoryConfig,
  SecurityRateLimitRedisConfig,
} from '@holo-js/config'

export interface SecurityRuntimeBindings {
  readonly config: HoloSecurityConfig | NormalizedHoloSecurityConfig
  readonly rateLimitStore?: SecurityRateLimitStore
  readonly csrfSigningKey?: string
  readonly defaultKeyResolver?: SecurityDefaultRateLimitKeyResolver
}

export interface SecurityRuntimeFacade {
  readonly config: NormalizedHoloSecurityConfig
  readonly rateLimitStore?: SecurityRateLimitStore
  readonly csrfSigningKey?: string
  readonly defaultKeyResolver?: SecurityDefaultRateLimitKeyResolver
}

export interface SecurityClientConfig {
  readonly csrf: {
    readonly field: string
    readonly cookie: string
  }
}

export interface SecurityClientBindings {
  readonly config?: {
    readonly csrf?: Partial<SecurityClientConfig['csrf']>
  }
}

export interface SecurityCsrfField {
  readonly name: string
  readonly value: string
}

export interface SecurityProtectOptions {
  readonly csrf?: boolean
  readonly throttle?: string
}

export interface SecurityRateLimitCallOptions {
  readonly request?: Request
  readonly key?: string
  readonly values?: Readonly<Record<string, unknown>>
}

export interface SecurityClearRateLimitOptions {
  readonly limiter?: string
  readonly key?: string
  readonly all?: boolean
}

export interface SecurityCsrfFacade {
  token(request: Request): Promise<string>
  field(request: Request): Promise<SecurityCsrfField>
  cookie(request: Request, token?: string): Promise<string>
  verify(request: Request): Promise<void>
}

export interface SecurityRateLimitBucketSnapshot {
  readonly limiter: string
  readonly key: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly remainingAttempts: number
  readonly expiresAt: Date
}

export interface SecurityRateLimitHitResult {
  readonly limited: boolean
  readonly snapshot: SecurityRateLimitBucketSnapshot
  readonly retryAfterSeconds: number
}

export interface SecurityRateLimitStore {
  hit(key: string, options: { readonly maxAttempts: number, readonly decaySeconds: number }): Promise<SecurityRateLimitHitResult>
  clear(key: string): Promise<boolean>
  clearByPrefix(prefix: string): Promise<number>
  clearAll(): Promise<number>
  close?(): Promise<void> | void
}

export interface SecurityDefaultRateLimitKeyResolver {
  (request: Request): string | number | null | undefined | Promise<string | number | null | undefined>
}

export class SecurityCsrfError extends Error {
  readonly status = 419

  constructor(message = 'CSRF token mismatch.') {
    super(message)
    this.name = 'SecurityCsrfError'
  }
}

export class SecurityRateLimitError extends Error {
  readonly status = 429
  readonly retryAfterSeconds?: number
  readonly snapshot?: SecurityRateLimitBucketSnapshot

  constructor(
    message = 'Too many attempts. Please try again later.',
    options: { retryAfterSeconds?: number, snapshot?: SecurityRateLimitBucketSnapshot } = {},
  ) {
    super(message)
    this.name = 'SecurityRateLimitError'
    this.retryAfterSeconds = options.retryAfterSeconds
    this.snapshot = options.snapshot
  }
}

export interface SecurityRateLimitRedisDriverAdapter {
  connect?(): Promise<void>
  increment(
    key: string,
    options: { readonly decaySeconds: number },
  ): Promise<{ readonly attempts: number, readonly ttlSeconds: number }>
  del(key: string): Promise<number>
  clearByPrefix?(prefix: string): Promise<number>
  clearAll?(): Promise<number>
  close?(): Promise<void>
}

export interface SecurityRateLimitStoreFactoryOptions {
  readonly projectRoot?: string
  readonly redisAdapter?: SecurityRateLimitRedisDriverAdapter
}

class PendingSecurityLimiterDefinition<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  constructor(
    readonly maxAttempts: number,
    readonly decaySeconds: number,
  ) {}

  by(key: SecurityRateLimitKeyResolver<TValues>): SecurityLimiterConfig<TValues> {
    if (typeof key !== 'function') {
      throw new TypeError('[@holo-js/security] Rate limiter key resolvers must be functions.')
    }

    return Object.freeze({
      maxAttempts: this.maxAttempts,
      decaySeconds: this.decaySeconds,
      key,
    })
  }

  define(): SecurityLimiterConfig<TValues> {
    return Object.freeze({
      maxAttempts: this.maxAttempts,
      decaySeconds: this.decaySeconds,
    })
  }
}

function normalizeLimiterAttempts(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`[@holo-js/security] ${label} must be an integer greater than or equal to 1.`)
  }

  return value
}

function normalizeLimiterWindowSeconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`[@holo-js/security] ${label} must be an integer greater than or equal to 1.`)
  }

  return value
}

export const limit = Object.freeze({
  perMinute(maxAttempts: number) {
    return new PendingSecurityLimiterDefinition(
      normalizeLimiterAttempts(maxAttempts, 'Rate limiter maxAttempts'),
      normalizeLimiterWindowSeconds(60, 'Rate limiter decaySeconds'),
    )
  },
  perHour(maxAttempts: number) {
    return new PendingSecurityLimiterDefinition(
      normalizeLimiterAttempts(maxAttempts, 'Rate limiter maxAttempts'),
      normalizeLimiterWindowSeconds(3600, 'Rate limiter decaySeconds'),
    )
  },
})

export function ip(request: Request, trustedProxy = false): string {
  if (!trustedProxy) {
    return 'unknown'
  }

  const forwarded = request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim()
  if (forwarded) {
    return forwarded
  }

  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) {
    return realIp
  }

  return 'unknown'
}

function normalizeLimiterIntegerInput(value: number | string | undefined, label: string): number {
  if (typeof value === 'undefined') {
    throw new TypeError(`[@holo-js/security] ${label} is required.`)
  }

  const normalized = typeof value === 'number'
    ? value
    : (() => {
        const trimmed = value.trim()
        if (!trimmed) {
          return Number.NaN
        }

        return Number(trimmed)
      })()

  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    throw new TypeError(`[@holo-js/security] ${label} must be an integer greater than or equal to 1.`)
  }

  if (normalized < 1) {
    throw new TypeError(`[@holo-js/security] ${label} must be an integer greater than or equal to 1.`)
  }

  return normalized
}

export function defineRateLimiter<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
>(
  definition: SecurityLimiterConfig<TValues>,
): SecurityLimiterConfig<TValues> {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('[@holo-js/security] Rate limiter definitions must be objects.')
  }

  const normalizedDefinition = {
    ...definition,
    maxAttempts: normalizeLimiterIntegerInput(definition.maxAttempts, 'Rate limiter maxAttempts'),
    decaySeconds: normalizeLimiterIntegerInput(definition.decaySeconds, 'Rate limiter decaySeconds'),
  }

  if (normalizedDefinition.key !== undefined && typeof normalizedDefinition.key !== 'function') {
    throw new TypeError('[@holo-js/security] Rate limiter key resolvers must be functions.')
  }

  return Object.freeze(normalizedDefinition)
}

export function defineSecurityRuntimeBindings(
  bindings: SecurityRuntimeBindings,
): Readonly<{
  config: NormalizedHoloSecurityConfig
  rateLimitStore?: SecurityRateLimitStore
  csrfSigningKey?: string
  defaultKeyResolver?: SecurityDefaultRateLimitKeyResolver
}> {
  return Object.freeze({
    config: normalizeSecurityConfig(bindings.config),
    rateLimitStore: bindings.rateLimitStore,
    csrfSigningKey: bindings.csrfSigningKey,
    defaultKeyResolver: bindings.defaultKeyResolver,
  })
}

export function createMemoryRateLimitStoreConfig(
  config: SecurityRateLimitMemoryConfig = {},
): Readonly<SecurityRateLimitMemoryConfig> {
  return Object.freeze({
    ...config,
  })
}

export function createFileRateLimitStoreConfig(
  config: SecurityRateLimitFileConfig = {},
): Readonly<SecurityRateLimitFileConfig> {
  return Object.freeze({
    ...config,
  })
}

export function createRedisRateLimitStoreConfig(
  config: SecurityRateLimitRedisConfig = {},
): Readonly<SecurityRateLimitRedisConfig> {
  return Object.freeze({
    ...config,
  })
}

export const securityInternals = {
  PendingSecurityLimiterDefinition,
  normalizeLimiterAttempts,
  normalizeLimiterWindowSeconds,
}
