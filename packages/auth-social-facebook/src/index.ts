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
  const scopes = (config.scopes ?? []).length > 0 ? config.scopes ?? [] : ['email', 'public_profile']
  url.searchParams.set('scope', scopes.join(','))
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const url = new URL('https://graph.facebook.com/oauth/access_token')
  url.searchParams.set('client_id', context.config.clientId ?? '')
  url.searchParams.set('client_secret', context.config.clientSecret ?? '')
  url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
  url.searchParams.set('code', context.code)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-facebook] Facebook token exchange failed.')
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
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + (expiresIn! * 1000)) : undefined,
    tokenType: payload.token_type,
  }
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
    profileUrl.searchParams.set('access_token', accessToken)
    const response = await fetch(profileUrl)
    if (!response.ok) {
      throw new Error('[@holo-js/auth-social-facebook] Facebook user request failed.')
    }

    const payload = await readJson(response) as Record<string, unknown>
    return {
      profile: normalizeProfile(payload),
      tokens: normalizeTokens(tokenPayload),
    }
  },
})

export default facebookSocialProvider
