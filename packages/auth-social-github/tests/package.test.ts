import { afterEach, describe, expect, it, vi } from 'vitest'
import githubSocialProvider from '../src'

const originalFetch = globalThis.fetch
type GithubRedirectContext = Parameters<typeof githubSocialProvider.buildAuthorizationUrl>[0]
type GithubCallbackContext = Parameters<typeof githubSocialProvider.exchangeCode>[0]

function createRedirectContext(): GithubRedirectContext {
  return {
    provider: 'github',
    request: new Request('https://app.test/auth/github'),
    state: 'state-1',
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    config: createProviderConfig(),
  }
}

function createCallbackContext(scopes: readonly string[] = []): GithubCallbackContext {
  return {
    provider: 'github',
    request: new Request('https://app.test/auth/github/callback?code=test'),
    code: 'test-code',
    codeVerifier: 'verifier',
    config: createProviderConfig(scopes),
  }
}

function createProviderConfig(scopes: readonly string[] = []) {
  return {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/auth/github/callback',
    scopes: [...scopes],
    encryptTokens: false,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-github', () => {
  it('builds the authorization url with GitHub defaults', async () => {
    const url = await githubSocialProvider.buildAuthorizationUrl(createRedirectContext())

    expect(url).toContain('github.com/login/oauth/authorize')
    expect(url).toContain('scope=read%3Auser+user%3Aemail')
  })

  it('exchanges the code and prefers a verified GitHub email', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 42,
        login: 'octocat',
        name: 'Octo Cat',
        avatar_url: 'https://example.com/octo.png',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { email: 'private@example.com', verified: false, primary: true },
        { email: 'verified@example.com', verified: true, primary: false },
      ]), { status: 200 })) as typeof fetch

    const exchanged = await githubSocialProvider.exchangeCode(createCallbackContext())

    expect(exchanged.profile).toEqual({
      id: '42',
      email: 'verified@example.com',
      emailVerified: true,
      name: 'Octo Cat',
      avatar: 'https://example.com/octo.png',
    })
  })

  it('fails when GitHub token or API requests fail', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(githubSocialProvider.exchangeCode(createCallbackContext())).rejects.toThrow('GitHub token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(githubSocialProvider.exchangeCode(createCallbackContext())).rejects.toThrow('GitHub user request failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(githubSocialProvider.exchangeCode(createCallbackContext())).rejects.toThrow('GitHub email request failed')
  })

  it('fails when the GitHub profile does not include an id', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) as typeof fetch

    await expect(githubSocialProvider.exchangeCode(createCallbackContext(['read:user']))).rejects.toThrow('did not include "id"')
  })
})
