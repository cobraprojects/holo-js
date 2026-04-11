import { afterEach, describe, expect, it, vi } from 'vitest'
import facebookSocialProvider from '../src'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-facebook', () => {
  it('builds the authorization url with Facebook defaults', async () => {
    const url = await facebookSocialProvider.buildAuthorizationUrl({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(url).toContain('facebook.com/dialog/oauth')
    expect(url).toContain('scope=email%2Cpublic_profile')
  })

  it('exchanges the code and normalizes the Facebook profile', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'facebook-user',
        name: 'Face Book',
        email: 'user@example.com',
        picture: {
          data: {
            url: 'https://example.com/avatar.png',
          },
        },
      }), { status: 200 })) as typeof fetch

    const exchanged = await facebookSocialProvider.exchangeCode({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'facebook-user',
      email: 'user@example.com',
      emailVerified: false,
      name: 'Face Book',
      avatar: 'https://example.com/avatar.png',
    })
  })

  it('fails when the Facebook token or user request fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(facebookSocialProvider.exchangeCode({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Facebook token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(facebookSocialProvider.exchangeCode({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Facebook user request failed')
  })

  it('fails when the Facebook profile does not include an id', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Face Book' }), { status: 200 })) as typeof fetch

    await expect(facebookSocialProvider.exchangeCode({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: ['email'],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "id"')
  })
})
