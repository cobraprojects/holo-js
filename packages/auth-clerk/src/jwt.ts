import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthClerkProviderConfig } from '@holo-js/auth'

export type JwkKey = Parameters<typeof authRuntimeInternals.jwt.verifyJwtSignatureWithJwk>[1]

export const CLERK_API_BASE_URL = 'https://api.clerk.com'
const clerkJwksCache: Parameters<typeof authRuntimeInternals.jwt.resolveCachedJwk>[0] = new Map()

export function parseJwt(token: string): {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: Buffer
  readonly signingInput: Buffer
} {
  return authRuntimeInternals.jwt.parseJwt(token, {
    errorPrefix: '[@holo-js/auth-clerk] Clerk token',
    malformedMessage: '[@holo-js/auth-clerk] Clerk token was not a valid JWT.',
  })
}

export function verifyJwtSignatureWithJwk(
  token: ReturnType<typeof parseJwt>,
  jwk: JwkKey,
): boolean {
  return authRuntimeInternals.jwt.verifyJwtSignatureWithJwk(token, jwk, {
    unsupportedAlgorithmMessage: algorithm => `[@holo-js/auth-clerk] Unsupported Clerk JWT algorithm "${algorithm}".`,
  })
}

export function resetClerkJwksCache(): void {
  clerkJwksCache.clear()
}

export function resolveClerkJwksUrl(config: AuthClerkProviderConfig): string {
  const frontendApi = config.frontendApi?.trim()
  if (frontendApi) {
    return `${frontendApi.replace(/\/$/, '')}/.well-known/jwks.json`
  }

  const apiUrl = config.apiUrl?.trim() || CLERK_API_BASE_URL
  return `${apiUrl.replace(/\/$/, '')}/v1/jwks`
}

export async function resolveClerkJwk(jwksUrl: string, kid: string | undefined): Promise<JwkKey | undefined> {
  return authRuntimeInternals.jwt.resolveCachedJwk(clerkJwksCache, jwksUrl, {
    requestUrl: jwksUrl,
    kid,
    errorMessage: `[@holo-js/auth-clerk] Failed to load Clerk JWKS from "${jwksUrl}".`,
  })
}
