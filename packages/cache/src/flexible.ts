import {
  CacheInvalidTtlError,
  type CacheFlexibleTtlInput,
  type CacheLockContract,
} from './contracts'

export type FlexibleEnvelope<TValue> = {
  readonly __holo_cache_flexible: true
  readonly value: TValue
  readonly freshUntil: number
  readonly staleUntil: number
}

export type NormalizedFlexibleTtl = {
  readonly freshSeconds: number
  readonly staleSeconds: number
}

type FlexibleEnvelopeState = 'fresh' | 'stale' | 'expired'

type FlexibleResolverOptions<TValue> = {
  readonly ttl: CacheFlexibleTtlInput
  readonly read: () => Promise<unknown>
  readonly refresh: (ttl: NormalizedFlexibleTtl) => Promise<TValue>
  readonly createLock: (ttl: NormalizedFlexibleTtl) => CacheLockContract
  readonly blockSeconds?: (ttl: NormalizedFlexibleTtl) => number
  readonly now?: () => number
}

export function normalizeFlexibleTtl(ttl: CacheFlexibleTtlInput): NormalizedFlexibleTtl {
  const freshSeconds = 'fresh' in ttl ? ttl.fresh : ttl[0]
  const staleSeconds = 'stale' in ttl ? ttl.stale : ttl[1]

  if (!Number.isInteger(freshSeconds) || freshSeconds < 0) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Flexible fresh TTL must be an integer greater than or equal to 0.')
  }

  if (!Number.isInteger(staleSeconds) || staleSeconds < freshSeconds) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Flexible stale TTL must be an integer greater than or equal to the fresh TTL.')
  }

  return Object.freeze({
    freshSeconds,
    staleSeconds,
  })
}

export function createFlexibleEnvelope<TValue>(
  ttl: NormalizedFlexibleTtl,
  value: TValue,
  now = Date.now(),
): FlexibleEnvelope<TValue> {
  return Object.freeze({
    __holo_cache_flexible: true,
    value,
    freshUntil: now + (ttl.freshSeconds * 1000),
    staleUntil: now + (ttl.staleSeconds * 1000),
  })
}

export function isFlexibleEnvelope<TValue>(value: unknown): value is FlexibleEnvelope<TValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const envelope = value as Partial<FlexibleEnvelope<TValue>>
  return envelope.__holo_cache_flexible === true
    && typeof envelope.freshUntil === 'number'
    && Number.isFinite(envelope.freshUntil)
    && typeof envelope.staleUntil === 'number'
    && Number.isFinite(envelope.staleUntil)
    && 'value' in envelope
}

export function resolveFlexibleEnvelopeState(
  envelope: FlexibleEnvelope<unknown>,
  now = Date.now(),
): FlexibleEnvelopeState {
  if (now <= envelope.freshUntil) {
    return 'fresh'
  }

  if (now <= envelope.staleUntil) {
    return 'stale'
  }

  return 'expired'
}

export async function resolveFlexibleCachedValue<TValue>(
  options: FlexibleResolverOptions<TValue>,
): Promise<TValue> {
  const normalizedTtl = normalizeFlexibleTtl(options.ttl)
  const cached = await options.read()
  const now = options.now?.() ?? Date.now()

  if (isFlexibleEnvelope<TValue>(cached)) {
    const state = resolveFlexibleEnvelopeState(cached, now)
    if (state === 'fresh') {
      return cached.value
    }

    if (state === 'stale') {
      const refreshLock = options.createLock(normalizedTtl)
      void refreshLock.get(async () => {
        await options.refresh(normalizedTtl)
        return true
      }).catch(() => undefined)

      return cached.value
    }
  }

  const refreshLock = options.createLock(normalizedTtl)
  const refreshed = await refreshLock.block(
    options.blockSeconds?.(normalizedTtl) ?? 1,
    async () => options.refresh(normalizedTtl),
  )

  if (refreshed !== false) {
    return refreshed as TValue
  }

  const retried = await options.read()
  if (
    isFlexibleEnvelope<TValue>(retried)
    && resolveFlexibleEnvelopeState(retried) !== 'expired'
  ) {
    return retried.value
  }

  return options.refresh(normalizedTtl)
}
