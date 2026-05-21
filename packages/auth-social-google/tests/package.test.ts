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
    expect(new URL(url).searchParams.get('access_type')).toBe('offline')
  })

  it('builds authorization urls with configured scopes and optional values omitted', async () => {
    const url = new URL(await googleSocialProvider.buildAuthorizationUrl({
      provider: 'google',
      request: new Request('https://app.test/auth/google'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        scopes: ['openid'],
      },
    }))

    expect(url.searchParams.get('client_id')).toBe('')
    expect(url.searchParams.get('redirect_uri')).toBe('')
    expect(url.searchParams.get('scope')).toBe('openid')
    expect(url.searchParams.get('access_type')).toBe('offline')

    const fallbackUrl = new URL(await googleSocialProvider.buildAuthorizationUrl({
      provider: 'google',
      request: new Request('https://app.test/auth/google'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {},
    }))

    expect(fallbackUrl.searchParams.get('scope')).toBe('openid email profile')
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

  it('normalizes optional token and profile fields', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: undefined,
        refresh_token: 123,
        expires_in: '120',
        id_token: 'id-token',
        token_type: 'Bearer',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-user',
        email_verified: false,
      }), { status: 200 })) as typeof fetch

    const exchanged = await googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {},
    })

    const tokenRequest = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined
    expect(tokenRequest?.body?.toString()).toContain('client_id=&client_secret=&redirect_uri=')
    expect(exchanged.profile).toEqual({
      id: 'google-user',
      email: undefined,
      emailVerified: false,
      name: undefined,
      avatar: undefined,
    })
    expect(exchanged.tokens.accessToken).toBe('')
    expect(exchanged.tokens.refreshToken).toBeUndefined()
    expect(exchanged.tokens.expiresAt).toBeInstanceOf(Date)
    expect(exchanged.tokens.idToken).toBe('id-token')
    expect(exchanged.tokens.tokenType).toBe('Bearer')
  })

  it('leaves token expiry unset when Google omits expires_in', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-user',
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
      },
    })

    expect(exchanged.tokens.expiresAt).toBeUndefined()
  })

  it('treats an empty token response body as an empty payload', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-user',
      }), { status: 200 })) as typeof fetch

    const exchanged = await googleSocialProvider.exchangeCode({
      provider: 'google',
      request: new Request('https://app.test/auth/google/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {},
    })

    expect(exchanged.tokens.accessToken).toBe('')
    expect(exchanged.profile.id).toBe('google-user')
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
