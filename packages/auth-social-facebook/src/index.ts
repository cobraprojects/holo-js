import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialRedirectContext,
} from '@holo-js/auth-social'
import { socialAuthInternals } from '@holo-js/auth-social'

function applyScopes(url: URL, config: SocialRedirectContext['config']): void {
  const configuredScopes = config.scopes
  const scopes = configuredScopes && configuredScopes.length > 0 ? configuredScopes : ['email', 'public_profile']
  url.searchParams.set('scope', scopes.join(','))
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const response = await fetch('https://graph.facebook.com/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: socialAuthInternals.createAuthorizationCodeTokenBody(context, {
      includeCodeVerifier: false,
      includeGrantType: false,
    }),
  })
  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-facebook] Facebook token exchange failed.')
  }

  return await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
}

function normalizeProfile(payload: Record<string, unknown>): SocialProviderProfile {
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (!id) {
    throw new Error('[@holo-js/auth-social-facebook] Facebook user profile did not include "id".')
  }

  const pictureData = payload.picture && typeof payload.picture === 'object' && 'data' in payload.picture
    ? (payload.picture as { data?: { url?: string } }).data
    : undefined

  return {
    id,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: false,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    avatar: typeof pictureData?.url === 'string' ? pictureData.url : undefined,
  }
}

export const facebookSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const url = new URL('https://www.facebook.com/dialog/oauth')
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', context.state)
    applyScopes(url, context.config)
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const accessToken = String(tokenPayload.access_token ?? '')
    const profileUrl = new URL('https://graph.facebook.com/me')
    profileUrl.searchParams.set('fields', 'id,name,email,picture')
    const response = await fetch(profileUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error('[@holo-js/auth-social-facebook] Facebook user request failed.')
    }

    const payload = await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
    return {
      profile: normalizeProfile(payload),
      tokens: socialAuthInternals.normalizeOAuthTokens(tokenPayload, {
        includeRefreshToken: false,
        includeScope: false,
      }),
    }
  },
})

export default facebookSocialProvider
