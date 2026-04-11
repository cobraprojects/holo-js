import { afterEach, describe, expect, it, vi } from 'vitest'
import googleSocialProvider from '../src'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-google', () => {
  it('builds the authorization url with Google defaults', async () => {
    const url = await googleSocialProvider.buildAuthorizationUrl({
      provider: 'google',
      request: new Request('https://app.test/auth/google'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/google/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(url).toContain('accounts.google.com')
    expect(url).toContain('scope=openid+email+profile')
    expect(url).toContain('code_challenge=challenge')
  })

  it('exchanges the code and normalizes the Google profile', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-user',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
      }), { status: 200 })) as typeof fetch

    const exchanged = await googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/google/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'google-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Test User',
      avatar: 'https://example.com/avatar.png',
    })
    expect(exchanged.tokens.accessToken).toBe('access')
    expect(exchanged.tokens.refreshToken).toBe('refresh')
    expect(exchanged.tokens.expiresAt).toBeInstanceOf(Date)
  })

  it('fails when the token or profile request is invalid', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/google/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Google token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/google/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Google user info request failed')
  })

  it('fails when the Google profile does not include a stable id', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: 'user@example.com',
      }), { status: 200 })) as typeof fetch

    await expect(googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/google/callback',
        scopes: ['email'],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "sub"')
  })
})
