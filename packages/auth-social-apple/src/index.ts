import { authRuntimeInternals } from '@holo-js/auth'
import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialRedirectContext,
} from '@holo-js/auth-social'
import { socialAuthInternals } from '@holo-js/auth-social'

const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_TOKEN_CLOCK_SKEW_MS = 60_000

type JwkKey = Parameters<typeof authRuntimeInternals.jwt.verifyJwtSignatureWithJwk>[1]
const APPLE_JWKS_CACHE = new Map<string, Promise<readonly JwkKey[]>>()
let appleJwksCacheFetch: typeof fetch | undefined

async function readAppleUserPayload(request: Request): Promise<{
  readonly email?: string
  readonly firstName?: string
  readonly lastName?: string
} | undefined> {
  if (request.method.toUpperCase() !== 'POST') {
    return undefined
  }

  const formData = await request.clone().formData().catch(() => undefined)
  const userValue = formData?.get('user')
  if (typeof userValue !== 'string' || !userValue.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(userValue) as {
      readonly email?: unknown
      readonly name?: {
        readonly firstName?: unknown
        readonly lastName?: unknown
      }
    }

    return {
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      firstName: typeof parsed.name?.firstName === 'string' ? parsed.name.firstName : undefined,
      lastName: typeof parsed.name?.lastName === 'string' ? parsed.name.lastName : undefined,
    }
  } catch {
    return undefined
  }
}

function parseJwt(token: string): {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: Buffer
  readonly signingInput: Buffer
} {
  return authRuntimeInternals.jwt.parseJwt(token, {
    errorPrefix: '[@holo-js/auth-social-apple] Apple id_token',
    malformedMessage: '[@holo-js/auth-social-apple] Apple id_token was malformed.',
  })
}

function verifyJwtSignatureWithJwk(
  token: ReturnType<typeof parseJwt>,
  jwk: JwkKey,
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  if (algorithm !== 'RS256') {
    throw new Error(`[@holo-js/auth-social-apple] Unsupported Apple id_token algorithm "${algorithm || 'unknown'}".`)
  }

  return authRuntimeInternals.jwt.verifyJwtSignatureWithJwk(token, jwk, {
    unsupportedAlgorithmMessage: unsupportedAlgorithm => `[@holo-js/auth-social-apple] Unsupported Apple id_token algorithm "${unsupportedAlgorithm}".`,
  })
}

async function fetchAppleJwks(): Promise<readonly JwkKey[]> {
  if (appleJwksCacheFetch !== globalThis.fetch) {
    APPLE_JWKS_CACHE.clear()
    appleJwksCacheFetch = globalThis.fetch
  }

  return authRuntimeInternals.jwt.fetchCachedJwks(APPLE_JWKS_URL, {
    cache: APPLE_JWKS_CACHE,
    requestUrl: APPLE_JWKS_URL,
    errorMessage: '[@holo-js/auth-social-apple] Failed to load Apple JWKS.',
  })
}

function hasExpectedAudience(audience: unknown, clientId: string): boolean {
  if (typeof audience === 'string') {
    return audience === clientId
  }

  return Array.isArray(audience) && audience.includes(clientId)
}

async function verifyAppleIdToken(
  token: string,
  clientId: string | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const normalizedClientId = clientId?.trim()
  if (!normalizedClientId) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token verification requires clientId to be configured.')
  }

  const parsed = parseJwt(token)
  const headerKid = typeof parsed.header.kid === 'string' ? parsed.header.kid : undefined
  const keys = await fetchAppleJwks()
  const key = headerKid
    ? keys.find(candidate => candidate.kid === headerKid)
    : keys[0]

  if (!key || !verifyJwtSignatureWithJwk(parsed, key)) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token signature verification failed.')
  }

  if (parsed.payload.iss !== APPLE_ISSUER) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token issuer was invalid.')
  }

  if (!hasExpectedAudience(parsed.payload.aud, normalizedClientId)) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token audience was invalid.')
  }

  if (typeof parsed.payload.exp !== 'number') {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token did not include "exp".')
  }

  if ((parsed.payload.exp * 1000) <= Date.now()) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token has expired.')
  }

  if (typeof parsed.payload.iat !== 'number' || !Number.isFinite(parsed.payload.iat)) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token did not include "iat".')
  }

  if ((parsed.payload.iat * 1000) > Date.now() + APPLE_TOKEN_CLOCK_SKEW_MS) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token was issued in the future.')
  }

  const nbf = typeof parsed.payload.nbf === 'number' ? parsed.payload.nbf : undefined
  if (typeof nbf === 'number' && (nbf * 1000) > Date.now() + APPLE_TOKEN_CLOCK_SKEW_MS) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token is not valid yet.')
  }

  return parsed.payload
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const response = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: socialAuthInternals.createAuthorizationCodeTokenBody(context),
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-apple] Apple token exchange failed.')
  }

  return await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
}

function normalizeProfile(
  payload: Readonly<Record<string, unknown>>,
  userPayload?: {
    readonly email?: string
    readonly firstName?: string
    readonly lastName?: string
  },
): SocialProviderProfile {
  const id = typeof payload.sub === 'string' ? payload.sub : ''
  if (!id) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token did not include "sub".')
  }

  const givenName = typeof payload.given_name === 'string'
    ? payload.given_name
    : userPayload?.firstName ?? ''
  const familyName = typeof payload.family_name === 'string'
    ? payload.family_name
    : userPayload?.lastName ?? ''
  const fullName = `${givenName} ${familyName}`.trim()

  return {
    id,
    email: typeof payload.email === 'string' ? payload.email : userPayload?.email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: fullName || undefined,
  }
}

export const appleSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const url = new URL('https://appleid.apple.com/auth/authorize')
    const scopes = context.config.scopes?.length ? context.config.scopes : ['name', 'email']
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('response_mode', 'form_post')
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', context.state)
    url.searchParams.set('code_challenge', context.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const idToken = typeof tokenPayload.id_token === 'string' ? tokenPayload.id_token : ''
    if (!idToken) {
      throw new Error('[@holo-js/auth-social-apple] Apple token response did not include "id_token".')
    }
    const userPayload = await readAppleUserPayload(context.request)
    const claims = await verifyAppleIdToken(idToken, context.config.clientId)

    return {
      profile: normalizeProfile(claims, userPayload),
      tokens: socialAuthInternals.normalizeOAuthTokens(tokenPayload, {
        includeScope: false,
        extra: {
          idToken: tokenPayload.id_token,
        },
      }),
    }
  },
})

export default appleSocialProvider
