import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialRedirectContext,
} from '@holo-js/auth-social'
import { socialAuthInternals } from '@holo-js/auth-social'

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: socialAuthInternals.createAuthorizationCodeTokenBody(context, {
      includeCodeVerifier: false,
    }),
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-linkedin] LinkedIn token exchange failed.')
  }

  return await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
}

function normalizeProfile(payload: Record<string, unknown>): SocialProviderProfile {
  const id = typeof payload.sub === 'string' ? payload.sub : ''
  if (!id) {
    throw new Error('[@holo-js/auth-social-linkedin] LinkedIn user info did not include "sub".')
  }

  return {
    id,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    avatar: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

export const linkedinSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const scopes = (context.config.scopes ?? []).length > 0 ? context.config.scopes ?? [] : ['openid', 'profile', 'email']
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', context.state)
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const accessToken = String(tokenPayload.access_token ?? '')
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error('[@holo-js/auth-social-linkedin] LinkedIn user info request failed.')
    }

    const payload = await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
    return {
      profile: normalizeProfile(payload),
      tokens: socialAuthInternals.normalizeOAuthTokens(tokenPayload, {
        includeRefreshToken: false,
        includeScope: false,
        includeTokenType: false,
      }),
    }
  },
})

export default linkedinSocialProvider
