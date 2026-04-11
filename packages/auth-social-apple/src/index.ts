import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialProviderTokens,
  SocialRedirectContext,
} from '@holo-js/auth-social'

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) as unknown : {}
}

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

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.')
  if (segments.length < 2 || !segments[1]) {
    throw new Error('[@holo-js/auth-social-apple] Apple id_token was malformed.')
  }

  return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as Record<string, unknown>
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code: context.code,
    client_id: context.config.clientId ?? '',
    client_secret: context.config.clientSecret ?? '',
    redirect_uri: context.config.redirectUri ?? '',
    grant_type: 'authorization_code',
    code_verifier: context.codeVerifier,
  })

  const response = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-apple] Apple token exchange failed.')
  }

  return await readJson(response) as Record<string, unknown>
}

function normalizeTokens(payload: Record<string, unknown>): SocialProviderTokens {
  const expiresIn = typeof payload.expires_in === 'number'
    ? payload.expires_in
    : typeof payload.expires_in === 'string'
      ? Number.parseInt(payload.expires_in, 10)
      : undefined

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + (expiresIn! * 1000)) : undefined,
    idToken: payload.id_token,
    tokenType: payload.token_type,
  }
}

function normalizeProfile(
  idToken: string,
  userPayload?: {
    readonly email?: string
    readonly firstName?: string
    readonly lastName?: string
  },
): SocialProviderProfile {
  const payload = decodeJwtPayload(idToken)
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
    const scopes = (context.config.scopes ?? []).length > 0 ? context.config.scopes ?? [] : ['name', 'email']
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

    return {
      profile: normalizeProfile(idToken, userPayload),
      tokens: normalizeTokens(tokenPayload),
    }
  },
})

export default appleSocialProvider
