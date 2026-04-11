import type {
  SocialCallbackContext,
  SocialProviderProfile,
  SocialProviderRuntime,
  SocialProviderTokens,
  SocialRedirectContext,
} from '@holo-js/auth-social'

function applyScopes(url: URL, config: SocialRedirectContext['config']): void {
  const scopes = (config.scopes ?? []).length > 0 ? config.scopes ?? [] : ['read:user', 'user:email']
  url.searchParams.set('scope', scopes.join(' '))
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) as unknown : {}
}

async function exchangeToken(context: SocialCallbackContext): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code: context.code,
    client_id: context.config.clientId ?? '',
    client_secret: context.config.clientSecret ?? '',
    redirect_uri: context.config.redirectUri ?? '',
  })

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    throw new Error('[@holo-js/auth-social-github] GitHub token exchange failed.')
  }

  return await readJson(response) as Record<string, unknown>
}

function normalizeTokens(payload: Record<string, unknown>): SocialProviderTokens {
  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    refreshTokenExpiresIn: payload.refresh_token_expires_in,
    tokenType: payload.token_type,
    scope: payload.scope,
  }
}

function normalizeProfile(
  profilePayload: Record<string, unknown>,
  emailsPayload: readonly Record<string, unknown>[],
): SocialProviderProfile {
  const id = profilePayload.id
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error('[@holo-js/auth-social-github] GitHub user profile did not include "id".')
  }

  const primaryVerified = emailsPayload.find(entry => entry.primary === true && entry.verified === true)
    ?? emailsPayload.find(entry => entry.verified === true)
  const fallbackEmail = typeof profilePayload.email === 'string' ? profilePayload.email : undefined

  return {
    id: String(id),
    email: typeof primaryVerified?.email === 'string' ? primaryVerified.email : fallbackEmail,
    emailVerified: primaryVerified?.verified === true,
    name: typeof profilePayload.name === 'string'
      ? profilePayload.name
      : typeof profilePayload.login === 'string'
        ? profilePayload.login
        : undefined,
    avatar: typeof profilePayload.avatar_url === 'string' ? profilePayload.avatar_url : undefined,
  }
}

export const githubSocialProvider: SocialProviderRuntime = Object.freeze({
  buildAuthorizationUrl(context: SocialRedirectContext) {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', context.config.clientId ?? '')
    url.searchParams.set('redirect_uri', context.config.redirectUri ?? '')
    url.searchParams.set('state', context.state)
    applyScopes(url, context.config)
    return url.toString()
  },
  async exchangeCode(context: SocialCallbackContext) {
    const tokenPayload = await exchangeToken(context)
    const accessToken = String(tokenPayload.access_token ?? '')
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'holo-js',
    }
    const profileResponse = await fetch('https://api.github.com/user', { headers })
    if (!profileResponse.ok) {
      throw new Error('[@holo-js/auth-social-github] GitHub user request failed.')
    }
    const emailsResponse = await fetch('https://api.github.com/user/emails', { headers })
    if (!emailsResponse.ok) {
      throw new Error('[@holo-js/auth-social-github] GitHub email request failed.')
    }

    const profilePayload = await readJson(profileResponse) as Record<string, unknown>
    const emailsPayload = await readJson(emailsResponse) as readonly Record<string, unknown>[]

    return {
      profile: normalizeProfile(profilePayload, emailsPayload),
      tokens: normalizeTokens(tokenPayload),
    }
  },
})

export default githubSocialProvider
