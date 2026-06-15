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

async function fetchCachedJwks(
  cacheKey: string,
  options: {
    readonly cache: Map<string, Promise<readonly AuthRuntimeJwkKey[]>>
    readonly requestUrl: string
    readonly refresh?: boolean
    readonly errorMessage: string
  },
): Promise<readonly AuthRuntimeJwkKey[]> {
  if (options.refresh) {
    options.cache.delete(cacheKey)
  }

  const existing = options.cache.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = (async () => {
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
  })()

  options.cache.set(cacheKey, pending)
  try {
    return await pending
  } catch (error) {
    options.cache.delete(cacheKey)
    throw error
  }
}

export const authJwtInternals = {
  fetchCachedJwks,
  getJwtStringClaim,
  parseJwt,
  verifyJwtSignatureWithJwk,
}
