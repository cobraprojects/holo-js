import { createPublicKey, type JsonWebKey, verify as verifySignature } from 'node:crypto'

export type AuthRuntimeJwkKey = Readonly<JsonWebKey> & {
  readonly kid?: string
}

export type AuthRuntimeParsedJwt = {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: Buffer
  readonly signingInput: Buffer
}

function decodeJwtSegment<TValue>(value: string, label: string, errorPrefix: string): TValue {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TValue
  } catch {
    throw new Error(`${errorPrefix} ${label} was not valid JSON.`)
  }
}

function parseJwt(
  token: string,
  options: { readonly errorPrefix: string, readonly malformedMessage: string },
): AuthRuntimeParsedJwt {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new Error(options.malformedMessage)
  }

  return {
    header: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[0], 'header', options.errorPrefix),
    payload: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[1], 'payload', options.errorPrefix),
    signature: Buffer.from(segments[2], 'base64url'),
    signingInput: Buffer.from(`${segments[0]}.${segments[1]}`, 'utf8'),
  }
}

function getJwtStringClaim(token: string, claim: string, options: {
  readonly errorPrefix: string
  readonly malformedMessage: string
}): string | undefined {
  try {
    const value = parseJwt(token, options).payload[claim]
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return undefined
  }
}

function verifyJwtSignatureWithJwk(
  token: AuthRuntimeParsedJwt,
  jwk: AuthRuntimeJwkKey,
  options: { readonly unsupportedAlgorithmMessage: (algorithm: string) => string },
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  const key = createPublicKey({ key: jwk, format: 'jwk' })

  switch (algorithm) {
    case 'RS256':
      return verifySignature('RSA-SHA256', token.signingInput, key, token.signature)
    case 'RS384':
      return verifySignature('RSA-SHA384', token.signingInput, key, token.signature)
    case 'RS512':
      return verifySignature('RSA-SHA512', token.signingInput, key, token.signature)
    default:
      throw new Error(options.unsupportedAlgorithmMessage(algorithm || 'unknown'))
  }
}

const JWKS_MAX_AGE_MS = 10 * 60 * 1000
const JWKS_REFRESH_INTERVAL_MS = 60 * 1000
const JWKS_FAILURE_GRACE_MS = 10 * 60 * 1000

type AuthRuntimeJwksSnapshot = {
  readonly keys: readonly AuthRuntimeJwkKey[]
  readonly fetchedAt: number
}

type AuthRuntimeJwksCacheEntry = {
  readonly snapshot: Promise<AuthRuntimeJwksSnapshot>
  loadedAt: number
  expiresAt: number
}

type AuthRuntimeJwksCache = Map<string, AuthRuntimeJwksCacheEntry>

function findJwk(keys: readonly AuthRuntimeJwkKey[], kid: string | undefined): AuthRuntimeJwkKey | undefined {
  return kid
    ? keys.find(candidate => candidate.kid === kid)
    : keys[0]
}

async function fetchJwks(options: {
  readonly requestUrl: string
  readonly errorMessage: string
}): Promise<readonly AuthRuntimeJwkKey[]> {
  const response = await fetch(options.requestUrl, {
    headers: {
      accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(options.errorMessage)
  }

  const payload = await response.json() as { keys?: readonly AuthRuntimeJwkKey[] }
  return payload.keys ?? []
}

function loadJwks(
  cache: AuthRuntimeJwksCache,
  cacheKey: string,
  options: {
    readonly requestUrl: string
    readonly errorMessage: string
  },
): AuthRuntimeJwksCacheEntry {
  const previous = cache.get(cacheKey)
  const entry: AuthRuntimeJwksCacheEntry = {
    loadedAt: Date.now(),
    expiresAt: Number.POSITIVE_INFINITY,
    snapshot: fetchJwks(options).then(
      keys => {
        entry.expiresAt = entry.loadedAt + JWKS_MAX_AGE_MS
        return { keys, fetchedAt: entry.loadedAt }
      },
      async error => {
        entry.loadedAt = Date.now()
        const previousSnapshot = await previous?.snapshot.catch(() => undefined)
        if (previousSnapshot && entry.loadedAt - previousSnapshot.fetchedAt < JWKS_FAILURE_GRACE_MS) {
          entry.expiresAt = Math.min(
            entry.loadedAt + JWKS_REFRESH_INTERVAL_MS,
            previousSnapshot.fetchedAt + JWKS_FAILURE_GRACE_MS,
          )
          return previousSnapshot
        }

        entry.expiresAt = entry.loadedAt + JWKS_REFRESH_INTERVAL_MS
        throw error
      },
    ),
  }

  cache.set(cacheKey, entry)
  return entry
}

function resolveCacheEntry(
  cache: AuthRuntimeJwksCache,
  cacheKey: string,
  options: {
    readonly requestUrl: string
    readonly errorMessage: string
  },
): AuthRuntimeJwksCacheEntry {
  const existing = cache.get(cacheKey)
  if (!existing || Date.now() >= existing.expiresAt) {
    return loadJwks(cache, cacheKey, options)
  }

  return existing
}

async function resolveCachedJwk(
  cache: AuthRuntimeJwksCache,
  cacheKey: string,
  options: {
    readonly requestUrl: string
    readonly kid: string | undefined
    readonly errorMessage: string
  },
): Promise<AuthRuntimeJwkKey | undefined> {
  const entry = resolveCacheEntry(cache, cacheKey, options)
  const key = findJwk((await entry.snapshot).keys, options.kid)
  if (key || Date.now() - entry.loadedAt < JWKS_REFRESH_INTERVAL_MS) {
    return key
  }

  const latest = cache.get(cacheKey)
  const refreshed = latest && latest !== entry
    ? latest
    : loadJwks(cache, cacheKey, options)
  return findJwk((await refreshed.snapshot).keys, options.kid)
}

export const authJwtInternals = {
  getJwtStringClaim,
  parseJwt,
  resolveCachedJwk,
  verifyJwtSignatureWithJwk,
}
