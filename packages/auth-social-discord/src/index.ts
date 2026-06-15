import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialRedirectContext,
} from '@holo-js/auth-social'
import { socialAuthInternals } from '@holo-js/auth-social'

function applyScopes(url: URL, config: SocialRedirectContext['config']): void {
  const scopes = config.scopes && config.scopes.length > 0 ? config.scopes : ['identify', 'email']
  url.searchParams.set('scope', scopes.join(' '))
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: socialAuthInternals.createAuthorizationCodeTokenBody(context),
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-discord] Discord token exchange failed.')
  }

  return await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
}

function normalizeProfile(payload: Record<string, unknown>): SocialProviderProfile {
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (!id) {
    throw new Error('[@holo-js/auth-social-discord] Discord user profile did not include "id".')
  }

  return {
    id,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.verified === true,
    name: typeof payload.global_name === 'string'
      ? payload.global_name
      : typeof payload.username === 'string'
        ? payload.username
        : undefined,
    avatar: typeof payload.avatar === 'string' ? `https://cdn.discordapp.com/avatars/${id}/${payload.avatar}.png` : undefined,
  }
}

export const discordSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const url = new URL('https://discord.com/oauth2/authorize')
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', context.state)
    url.searchParams.set('code_challenge', context.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    applyScopes(url, context.config)
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const accessToken = String(tokenPayload.access_token ?? '')
    const response = await fetch('https://discord.com/api/users/@me', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error('[@holo-js/auth-social-discord] Discord user request failed.')
    }

    const payload = await socialAuthInternals.readJsonResponse(response) as Record<string, unknown>
    return {
      profile: normalizeProfile(payload),
      tokens: socialAuthInternals.normalizeOAuthTokens(tokenPayload),
    }
  },
})

export default discordSocialProvider
