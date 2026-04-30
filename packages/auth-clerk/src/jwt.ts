import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type { AuthClerkProviderConfig } from '@holo-js/config'

export type JwkKey = Readonly<Record<string, unknown>> & {
  readonly kid?: string
}

export const CLERK_API_BASE_URL = 'https://api.clerk.com'
const clerkJwksCache = new Map<string, Promise<readonly JwkKey[]>>()

function decodeJwtSegment<T>(value: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    throw new Error(`[@holo-js/auth-clerk] Clerk token ${label} was not valid JSON.`)
  }
}

export function parseJwt(token: string): {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: Buffer
  readonly signingInput: Buffer
} {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new Error('[@holo-js/auth-clerk] Clerk token was not a valid JWT.')
  }

  return {
    header: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[0], 'header'),
    payload: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[1], 'payload'),
    signature: Buffer.from(segments[2], 'base64url'),
    signingInput: Buffer.from(`${segments[0]}.${segments[1]}`, 'utf8'),
  }
}

export function verifyJwtSignatureWithJwk(
  token: ReturnType<typeof parseJwt>,
  jwk: JwkKey,
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })

  switch (algorithm) {
    case 'RS256':
      return verifySignature('RSA-SHA256', token.signingInput, key, token.signature)
    case 'RS384':
      return verifySignature('RSA-SHA384', token.signingInput, key, token.signature)
    case 'RS512':
      return verifySignature('RSA-SHA512', token.signingInput, key, token.signature)
    default:
      throw new Error(`[@holo-js/auth-clerk] Unsupported Clerk JWT algorithm "${algorithm || 'unknown'}".`)
  }
}

export function verifyJwtSignatureWithPem(
  token: ReturnType<typeof parseJwt>,
  pem: string,
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  const key = createPublicKey(pem.replace(/\\n/g, '\n'))

  switch (algorithm) {
    case 'RS256':
      return verifySignature('RSA-SHA256', token.signingInput, key, token.signature)
    case 'RS384':
      return verifySignature('RSA-SHA384', token.signingInput, key, token.signature)
    case 'RS512':
      return verifySignature('RSA-SHA512', token.signingInput, key, token.signature)
    default:
      throw new Error(`[@holo-js/auth-clerk] Unsupported Clerk JWT algorithm "${algorithm || 'unknown'}".`)
  }
}

export function resolveClerkJwksUrl(config: AuthClerkProviderConfig): string {
  const frontendApi = config.frontendApi?.trim()
  if (frontendApi) {
    return `${frontendApi.replace(/\/$/, '')}/.well-known/jwks.json`
  }

  const apiUrl = config.apiUrl?.trim() || CLERK_API_BASE_URL
  return `${apiUrl.replace(/\/$/, '')}/v1/jwks`
}

export async function fetchClerkJwks(
  jwksUrl: string,
  options: { readonly refresh?: boolean } = {},
): Promise<readonly JwkKey[]> {
  if (options.refresh) {
    clerkJwksCache.delete(jwksUrl)
  }

  const existing = clerkJwksCache.get(jwksUrl)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    const response = await fetch(jwksUrl, {
      headers: {
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`[@holo-js/auth-clerk] Failed to load Clerk JWKS from "${jwksUrl}".`)
    }

    const payload = await response.json() as { keys?: readonly JwkKey[] }
    return payload.keys ?? []
  })()

  clerkJwksCache.set(jwksUrl, pending)
  try {
    return await pending
  } catch (error) {
    clerkJwksCache.delete(jwksUrl)
    throw error
  }
}
