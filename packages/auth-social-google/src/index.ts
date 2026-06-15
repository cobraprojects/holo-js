import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialRedirectContext,
} from '@holo-js/auth-social'
import { socialAuthInternals } from '@holo-js/auth-social'

function applyScopes(url: URL, config: SocialRedirectContext['config'], fallback: readonly string[]): void {
  const configuredScopes = config.scopes ?? []
  const scopes = configuredScopes.length > 0 ? configuredScopes : fallback
  url.searchParams.set('scope', scopes.join(' '))
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: socialAuthInternals.createAuthorizationCodeTokenBody(context),
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-google] Google token exchange failed.')
  }

  return await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
}

function readAccessToken(payload: Record<string, unknown>): string {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
  if (!accessToken) {
    throw new Error('[@holo-js/auth-social-google] Google token response did not include "access_token".')
  }

  return accessToken
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
    url.searchParams.set('access_type', 'offline')
    applyScopes(url, context.config, ['openid', 'email', 'profile'])
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const accessToken = readAccessToken(tokenPayload)
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    if (!profileResponse.ok) {
      throw new Error('[@holo-js/auth-social-google] Google user info request failed.')
    }

    const profilePayload = await socialAuthInternals.readJsonResponse(profileResponse) as Record<string, unknown>
    return {
      profile: normalizeProfile(profilePayload),
      tokens: socialAuthInternals.normalizeOAuthTokens(tokenPayload, {
        includeScope: false,
        extra: {
          accessToken,
          idToken: tokenPayload.id_token,
        },
      }),
    }
  },
})

export default googleSocialProvider
