import { afterEach, describe, expect, it, vi } from 'vitest'
import appleSocialProvider from '../src'

const originalFetch = globalThis.fetch

function createToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-apple', () => {
  it('builds the authorization url with Apple defaults', async () => {
    const url = await appleSocialProvider.buildAuthorizationUrl({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(url).toContain('appleid.apple.com/auth/authorize')
    expect(url).toContain('scope=name+email')
    expect(url).toContain('response_mode=form_post')
  })

  it('exchanges the code and normalizes the Apple id token', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        id_token: createToken({
          sub: 'apple-user',
          email: 'user@example.com',
          email_verified: 'true',
          given_name: 'Test',
          family_name: 'User',
        }),
      }), { status: 200 })) as typeof fetch

    const exchanged = await appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'apple-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Test User',
    })
    expect(exchanged.tokens.accessToken).toBe('access')
  })

  it('preserves the one-time Apple form payload name when id_token omits it', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        id_token: createToken({
          sub: 'apple-user',
          email: 'user@example.com',
          email_verified: 'true',
        }),
      }), { status: 200 })) as typeof fetch

    const exchanged = await appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: 'test-code',
          user: JSON.stringify({
            name: {
              firstName: 'Form',
              lastName: 'Name',
            },
          }),
        }),
      }),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'apple-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Form Name',
    })
  })

  it('ignores POST callbacks without a usable Apple user payload', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: createToken({
          sub: 'apple-user',
          email: 'user@example.com',
          email_verified: 'true',
          given_name: 'Token',
          family_name: 'Name',
        }),
      }), { status: 200 })) as typeof fetch

    const exchanged = await appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: 'test-code',
        }),
      }),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile.name).toBe('Token Name')
    expect(exchanged.tokens.expiresAt).toBeUndefined()
  })

  it('ignores malformed Apple form payload JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: '3600',
        id_token: createToken({
          sub: 'apple-user',
          email: 'user@example.com',
          email_verified: 'true',
          given_name: 'Token',
          family_name: 'Name',
        }),
      }), { status: 200 })) as typeof fetch

    const exchanged = await appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: 'test-code',
          user: '{bad-json',
        }),
      }),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile.name).toBe('Token Name')
    expect(exchanged.tokens.expiresAt).toBeInstanceOf(Date)
  })

  it('fails when the Apple token exchange or id token is invalid', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Apple token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
      }), { status: 200 })) as typeof fetch

    await expect(appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "id_token"')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        id_token: 'bad-token',
      }), { status: 200 })) as typeof fetch

    await expect(appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Apple id_token was malformed')
  })

  it('fails when the Apple id token does not include sub', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        id_token: createToken({
          email: 'user@example.com',
        }),
      }), { status: 200 })) as typeof fetch

    await expect(appleSocialProvider.exchangeCode({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/apple/callback',
        scopes: ['email'],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "sub"')
  })
})
