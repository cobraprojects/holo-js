import {
  deserializeCacheValue,
  normalizeCacheTtl,
  resolveCacheKey,
  serializeCacheValue,
  type CacheDependencyIndex,
  type CacheDriverPutInput,
  type CacheKeyInput,
  type CacheTtlInput,
} from './contracts'
import { getCacheRuntime, resolveConfiguredDriver } from './runtime-shared'

export function resolveDriverContext(driverName?: string) {
  const runtime = getCacheRuntime()
  const configuredDriverName = driverName?.trim() || runtime.config.default
  return {
    driverName: configuredDriverName,
    driver: resolveConfiguredDriver(runtime, configuredDriverName),
    prefix: runtime.config.drivers[configuredDriverName]?.prefix ?? runtime.config.prefix,
  }
}

type CacheEntryContext = ReturnType<typeof resolveDriverContext>

export function resolveNormalizedKey(context: CacheEntryContext, key: CacheKeyInput<unknown>): string {
  return `${context.prefix}${resolveCacheKey(key)}`
}

export function createIndexedKey(key: CacheKeyInput<unknown>, driverName?: string): string {
  const context = resolveDriverContext(driverName)
  return `${context.driverName}\u0000${resolveNormalizedKey(context, key)}`
}

export function createCacheEntry(
  context: CacheEntryContext,
  key: CacheKeyInput<unknown>,
  value: unknown,
  ttl?: CacheTtlInput,
): CacheDriverPutInput {
  return {
    key: resolveNormalizedKey(context, key),
    payload: serializeCacheValue(value),
    expiresAt: typeof ttl === 'undefined' ? undefined : normalizeCacheTtl(ttl).expiresAt,
  }
}

export async function readCachePayload(key: CacheKeyInput<unknown>, driverName?: string): Promise<string | undefined> {
  const context = resolveDriverContext(driverName)
  const entry = await context.driver.get(resolveNormalizedKey(context, key))
  return entry.hit ? entry.payload : undefined
}

export async function readCacheEntry<TValue>(key: CacheKeyInput<TValue>, driverName?: string): Promise<
  | { readonly hit: true, readonly value: TValue }
  | { readonly hit: false }
> {
  const payload = await readCachePayload(key, driverName)
  return typeof payload === 'string'
    ? { hit: true, value: deserializeCacheValue<TValue>(payload) }
    : { hit: false }
}

export function writeCacheEntry(
  key: CacheKeyInput<unknown>,
  value: unknown,
  ttl?: CacheTtlInput,
  driverName?: string,
): Promise<boolean> {
  const context = resolveDriverContext(driverName)
  return context.driver.put(createCacheEntry(context, key, value, ttl))
}

export function createCacheLock(name: string, seconds: number, driverName?: string) {
  const context = resolveDriverContext(driverName)
  return context.driver.lock(resolveNormalizedKey(context, name), seconds)
}

export async function forgetNormalizedCacheEntry(
  context: CacheEntryContext,
  normalizedKey: string,
  dependencyIndex?: CacheDependencyIndex,
): Promise<boolean> {
  const forgotten = await context.driver.forget(normalizedKey)
  await dependencyIndex?.removeKey(`${context.driverName}\u0000${normalizedKey}`)
  return forgotten
}

export function forgetCacheEntry(
  key: CacheKeyInput<unknown>,
  driverName?: string,
  dependencyIndex?: CacheDependencyIndex,
): Promise<boolean> {
  const context = resolveDriverContext(driverName)
  return forgetNormalizedCacheEntry(context, resolveNormalizedKey(context, key), dependencyIndex)
}
