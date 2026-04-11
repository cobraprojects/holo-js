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

function applyScopes(url: URL, config: SocialRedirectContext['config']): void {
  const scopes = (config.scopes ?? []).length > 0 ? config.scopes ?? [] : ['identify', 'email']
  url.searchParams.set('scope', scopes.join(' '))
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

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-discord] Discord token exchange failed.')
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
    tokenType: payload.token_type,
    scope: payload.scope,
  }
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

    const payload = await readJson(response) as Record<string, unknown>
    return {
      profile: normalizeProfile(payload),
      tokens: normalizeTokens(tokenPayload),
    }
  },
})

export default discordSocialProvider
