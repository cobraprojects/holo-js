import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialProviderTokens,
  SocialRedirectContext,
} from '@holo-js/auth-social'

function applyScopes(url: URL, config: SocialRedirectContext['config'], fallback: readonly string[]): void {
  const scopes = (config.scopes ?? []).length > 0 ? config.scopes ?? [] : fallback
  url.searchParams.set('scope', scopes.join(' '))
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) as unknown : {}
}

async function exchangeToken(
  context: SocialCallbackContext,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code: context.code,
    client_id: context.config.clientId ?? '',
    client_secret: context.config.clientSecret ?? '',
    redirect_uri: context.config.redirectUri ?? '',
    grant_type: 'authorization_code',
    code_verifier: context.codeVerifier,
  })

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-google] Google token exchange failed.')
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

function normalizeProfile(payload: Record<string, unknown>): SocialProviderProfile {
  const id = typeof payload.sub === 'string' ? payload.sub : ''
  if (!id) {
    throw new Error('[@holo-js/auth-social-google] Google user profile did not include "sub".')
  }

  return {
    id,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    avatar: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

export const googleSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', context.state)
    url.searchParams.set('code_challenge', context.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    applyScopes(url, context.config, ['openid', 'email', 'profile'])
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context, 'https://oauth2.googleapis.com/token')
    const accessToken = String(tokenPayload.access_token ?? '')
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    if (!profileResponse.ok) {
      throw new Error('[@holo-js/auth-social-google] Google user info request failed.')
    }

    const profilePayload = await readJson(profileResponse) as Record<string, unknown>
    return {
      profile: normalizeProfile(profilePayload),
      tokens: normalizeTokens(tokenPayload),
    }
  },
})

export default googleSocialProvider
