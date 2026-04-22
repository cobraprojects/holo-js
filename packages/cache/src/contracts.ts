import type {
  HoloCacheConfig,
  HoloDatabaseConfig,
  NormalizedHoloCacheConfig,
  HoloRedisConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloRedisConfig,
} from '@holo-js/config'

const cacheKeyBrand = Symbol('holo-cache-key-brand')

export type CacheKey<TValue> = Readonly<{
  readonly key: string
  readonly [cacheKeyBrand]?: TValue
}>

export type CacheKeyInput<TValue = unknown> = string | CacheKey<TValue>
export type CacheDependencyDescriptor = string
export type CacheTtlInput = number | Date
export type CacheFallbackResolver<TValue> = () => TValue | Promise<TValue>
export type CacheFallback<TValue> = TValue | CacheFallbackResolver<TValue>
export type CacheValueResolver<TValue> = () => TValue | Promise<TValue>
export type CacheFlexibleTtlInput
  = readonly [fresh: number, stale: number]
  | {
      readonly fresh: number
      readonly stale: number
    }

export interface NormalizedCacheTtl {
  readonly seconds: number
  readonly expiresAt: number
  readonly isExpired: boolean
}

export type CacheErrorCode =
  | 'CACHE_INVALID_CONFIG'
  | 'CACHE_INVALID_TTL'
  | 'CACHE_UNSUPPORTED_VALUE'
  | 'CACHE_DRIVER_RESOLUTION_FAILED'
  | 'CACHE_OPTIONAL_PACKAGE_MISSING'
  | 'CACHE_INVALID_NUMERIC_MUTATION'
  | 'CACHE_LOCK_ACQUISITION_FAILED'
  | 'CACHE_QUERY_INTEGRATION_MISUSE'
  | 'CACHE_RUNTIME_NOT_CONFIGURED'

export class CacheError extends Error {
  readonly code: CacheErrorCode

  constructor(
    code: CacheErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options)
    this.name = 'CacheError'
    this.code = code
  }
}

export class CacheConfigError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_INVALID_CONFIG', message, options)
    this.name = 'CacheConfigError'
  }
}

export class CacheInvalidTtlError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_INVALID_TTL', message, options)
    this.name = 'CacheInvalidTtlError'
  }
}

export class CacheSerializationError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_UNSUPPORTED_VALUE', message, options)
    this.name = 'CacheSerializationError'
  }
}

export class CacheDriverResolutionError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_DRIVER_RESOLUTION_FAILED', message, options)
    this.name = 'CacheDriverResolutionError'
  }
}

export class CacheOptionalPackageError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_OPTIONAL_PACKAGE_MISSING', message, options)
    this.name = 'CacheOptionalPackageError'
  }
}

export class CacheInvalidNumericMutationError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_INVALID_NUMERIC_MUTATION', message, options)
    this.name = 'CacheInvalidNumericMutationError'
  }
}

export class CacheLockAcquisitionError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_LOCK_ACQUISITION_FAILED', message, options)
    this.name = 'CacheLockAcquisitionError'
  }
}

export class CacheQueryIntegrationError extends CacheError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('CACHE_QUERY_INTEGRATION_MISUSE', message, options)
    this.name = 'CacheQueryIntegrationError'
  }
}

export class CacheRuntimeNotConfiguredError extends CacheError {
  constructor() {
    super('CACHE_RUNTIME_NOT_CONFIGURED', '[@holo-js/cache] Cache runtime is not configured yet.')
    this.name = 'CacheRuntimeNotConfiguredError'
  }
}

export interface CacheDriverGetResult {
  readonly hit: boolean
  readonly payload?: string
  readonly expiresAt?: number
}

export interface CacheDriverPutInput {
  readonly key: string
  readonly payload: string
  readonly expiresAt?: number
}

export interface CacheLockContract {
  readonly name: string
  get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue>
  release(): Promise<boolean>
  block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue>
}

export interface CacheDriverContract {
  readonly name: string
  readonly driver: string
  get(key: string): Promise<CacheDriverGetResult>
  put(input: CacheDriverPutInput): Promise<boolean>
  add(input: CacheDriverPutInput): Promise<boolean>
  forget(key: string): Promise<boolean>
  flush(): Promise<void>
  increment(key: string, amount: number): Promise<number>
  decrement(key: string, amount: number): Promise<number>
  lock(name: string, seconds: number): CacheLockContract
}

export interface CacheDependencyIndex {
  register(key: string, dependencies: readonly CacheDependencyDescriptor[]): Promise<void>
  listKeys(dependency: CacheDependencyDescriptor): Promise<readonly string[]>
  listRegisteredKeys(): Promise<readonly string[]>
  removeKey(key: string): Promise<void>
  clear(): Promise<void>
}

export interface CacheQueryBridge {
  get<TValue>(key: CacheKeyInput<TValue>, options?: { driver?: string }): Promise<TValue | null>
  put<TValue>(
    key: CacheKeyInput<TValue>,
    value: TValue,
    options: {
      readonly driver?: string
      readonly ttl?: CacheTtlInput
      readonly flexible?: CacheFlexibleTtlInput
      readonly dependencies?: readonly CacheDependencyDescriptor[]
    },
  ): Promise<void>
  flexible<TValue>(
    key: CacheKeyInput<TValue>,
    ttl: CacheFlexibleTtlInput,
    callback: CacheValueResolver<TValue>,
    options?: {
      readonly driver?: string
      readonly dependencies?: readonly CacheDependencyDescriptor[]
    },
  ): Promise<Awaited<TValue>>
  forget(key: CacheKeyInput<unknown>, options?: { driver?: string }): Promise<boolean>
  invalidateDependencies(
    dependencies: readonly CacheDependencyDescriptor[],
    options?: { driver?: string },
  ): Promise<void>
}

export interface CacheRuntimeBindings {
  readonly config: HoloCacheConfig | NormalizedHoloCacheConfig
  readonly databaseConfig?: HoloDatabaseConfig | NormalizedHoloDatabaseConfig
  readonly redisConfig?: HoloRedisConfig | NormalizedHoloRedisConfig
  readonly drivers?: ReadonlyMap<string, CacheDriverContract>
  readonly dependencyIndex?: CacheDependencyIndex
  readonly queryBridge?: CacheQueryBridge
}

export interface CacheRepository {
  get<TValue>(key: CacheKey<TValue>): Promise<TValue | null>
  get<TValue>(key: CacheKeyInput<TValue>, fallback: CacheFallback<TValue>): Promise<TValue>
  get<TValue>(key: string, fallback: CacheFallback<TValue>): Promise<TValue>
  get(key: string): Promise<unknown | null>
  put<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean>
  add<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean>
  forever<TValue>(key: CacheKeyInput<TValue>, value: TValue): Promise<boolean>
  has(key: CacheKeyInput<unknown>): Promise<boolean>
  missing(key: CacheKeyInput<unknown>): Promise<boolean>
  forget(key: CacheKeyInput<unknown>): Promise<boolean>
  flush(): Promise<void>
  increment(key: CacheKeyInput<number>, amount?: number): Promise<number>
  decrement(key: CacheKeyInput<number>, amount?: number): Promise<number>
  remember<TValue>(key: CacheKeyInput<Awaited<TValue>>, ttl: CacheTtlInput, callback: CacheValueResolver<TValue>): Promise<Awaited<TValue>>
  rememberForever<TValue>(key: CacheKeyInput<Awaited<TValue>>, callback: CacheValueResolver<TValue>): Promise<Awaited<TValue>>
  flexible<TValue>(
    key: CacheKeyInput<Awaited<TValue>>,
    ttl: CacheFlexibleTtlInput,
    callback: CacheValueResolver<TValue>,
  ): Promise<Awaited<TValue>>
  lock(name: string, seconds: number): CacheLockContract
}

export interface CacheFacade extends CacheRepository {
  driver(name?: string): CacheRepository
}

type EncodedCacheValue
  = null
  | string
  | number
  | boolean
  | readonly EncodedCacheValue[]
  | {
      readonly __holo_cache_type?: 'date'
      readonly value?: string
      readonly [key: string]: EncodedCacheValue | 'date' | string | undefined
    }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeCacheStringKey(key: string): string {
  const normalized = key.trim()
  if (!normalized) {
    throw new CacheConfigError('[@holo-js/cache] Cache keys must be non-empty strings.')
  }

  return normalized
}

function encodeFiniteNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new CacheSerializationError(`[@holo-js/cache] Cache value at ${path} must be JSON-safe.`)
  }

  return value
}

function encodeDateValue(value: Date, path: string): EncodedCacheValue {
  if (Number.isNaN(value.getTime())) {
    throw new CacheSerializationError(`[@holo-js/cache] Cache value at ${path} contains an invalid Date.`)
  }

  return Object.freeze({
    __holo_cache_type: 'date',
    value: value.toISOString(),
  })
}

function encodeArrayValue(value: readonly unknown[], path: string): EncodedCacheValue {
  const encodedEntries: EncodedCacheValue[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new CacheSerializationError(`[@holo-js/cache] Cache value at ${path}[${index}] must not be sparse.`)
    }

    encodedEntries.push(encodeCacheValue(value[index], `${path}[${index}]`))
  }

  return Object.freeze(encodedEntries)
}

function encodeObjectValue(value: Record<string, unknown>, path: string): EncodedCacheValue {
  const encodedEntries: Record<string, EncodedCacheValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'undefined') {
      throw new CacheSerializationError(`[@holo-js/cache] Cache value at ${path}.${key} must be JSON-safe.`)
    }

    encodedEntries[key] = encodeCacheValue(entry, `${path}.${key}`)
  }

  return Object.freeze(encodedEntries)
}

function encodeCacheValue(value: unknown, path: string): EncodedCacheValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return encodeFiniteNumber(value, path)
  }

  if (value instanceof Date) {
    return encodeDateValue(value, path)
  }

  if (Array.isArray(value)) {
    return encodeArrayValue(value, path)
  }

  if (isPlainObject(value)) {
    return encodeObjectValue(value, path)
  }

  throw new CacheSerializationError(`[@holo-js/cache] Cache value at ${path} must be JSON-safe.`)
}

function decodeCacheValue(value: unknown, path: string): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => decodeCacheValue(entry, `${path}[${index}]`)))
  }

  if (isPlainObject(value)) {
    if (value.__holo_cache_type === 'date') {
      if (typeof value.value !== 'string') {
        throw new CacheSerializationError(`[@holo-js/cache] Cache payload at ${path} is malformed.`)
      }

      const decoded = new Date(value.value)
      if (Number.isNaN(decoded.getTime())) {
        throw new CacheSerializationError(`[@holo-js/cache] Cache payload at ${path} contains an invalid Date.`)
      }

      return decoded
    }

    const decodedEntries: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      decodedEntries[key] = decodeCacheValue(entry, `${path}.${key}`)
    }

    return Object.freeze(decodedEntries)
  }

  throw new CacheSerializationError(`[@holo-js/cache] Cache payload at ${path} is malformed.`)
}

export function defineCacheKey<TValue>(key: string): CacheKey<TValue> {
  return Object.freeze({
    key: normalizeCacheStringKey(key),
  }) as CacheKey<TValue>
}

export function isCacheKey(value: unknown): value is CacheKey<unknown> {
  return !!value
    && typeof value === 'object'
    && 'key' in value
    && typeof (value as { key?: unknown }).key === 'string'
}

export function resolveCacheKey<TValue>(key: CacheKeyInput<TValue>): string {
  return normalizeCacheStringKey(typeof key === 'string' ? key : key.key)
}

export function normalizeCacheTtl(
  ttl: CacheTtlInput,
  options: { now?: number | Date } = {},
): NormalizedCacheTtl {
  const now = options.now instanceof Date
    ? options.now.getTime()
    : options.now ?? Date.now()

  if (ttl instanceof Date) {
    const expiresAt = ttl.getTime()
    if (Number.isNaN(expiresAt)) {
      throw new CacheInvalidTtlError('[@holo-js/cache] Cache TTL Date must be valid.')
    }

    const remainingMilliseconds = Math.max(0, expiresAt - now)
    return Object.freeze({
      seconds: Math.floor(remainingMilliseconds / 1000),
      expiresAt,
      isExpired: expiresAt <= now,
    })
  }

  if (!Number.isInteger(ttl)) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Cache TTL seconds must be an integer.')
  }

  if (ttl < 0) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Cache TTL seconds must be greater than or equal to 0.')
  }

  return Object.freeze({
    seconds: ttl,
    expiresAt: now + (ttl * 1000),
    isExpired: ttl === 0,
  })
}

export function serializeCacheValue<TValue>(value: TValue): string {
  const payload = encodeCacheValue(value, '$')
  return JSON.stringify(payload)
}

export function deserializeCacheValue<TValue>(payload: string): TValue {
  try {
    return decodeCacheValue(JSON.parse(payload) as unknown, '$') as TValue
  } catch (error) {
    if (error instanceof CacheSerializationError) {
      throw error
    }

    throw new CacheSerializationError('[@holo-js/cache] Cache payload is not valid JSON.', {
      cause: error,
    })
  }
}

export const cacheContractsInternals = {
  decodeCacheValue,
  encodeCacheValue,
  isPlainObject,
  normalizeCacheStringKey,
}
