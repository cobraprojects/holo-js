import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthClerkProviderConfig } from '@holo-js/auth'

export type JwkKey = Parameters<typeof authRuntimeInternals.jwt.verifyJwtSignatureWithJwk>[1]

export const CLERK_API_BASE_URL = 'https://api.clerk.com'
const clerkJwksCache = new Map<string, Promise<readonly JwkKey[]>>()

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
  return authRuntimeInternals.jwt.fetchCachedJwks(jwksUrl, {
    cache: clerkJwksCache,
    requestUrl: jwksUrl,
    refresh: options.refresh,
    errorMessage: `[@holo-js/auth-clerk] Failed to load Clerk JWKS from "${jwksUrl}".`,
  })
}
