import { afterEach, describe, expect, it, vi } from 'vitest'
import linkedinSocialProvider from '../src'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-linkedin', () => {
  it('builds the authorization url with LinkedIn defaults', async () => {
    const url = await linkedinSocialProvider.buildAuthorizationUrl({
      provider: 'linkedin',
      request: new Request('https://app.test/auth/linkedin'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/linkedin/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(url).toContain('linkedin.com/oauth/v2/authorization')
    expect(url).toContain('scope=openid+profile+email')
  })

  it('exchanges the code and normalizes LinkedIn user info', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'linkedin-user',
        email: 'user@example.com',
        email_verified: true,
        name: 'Linked In',
        picture: 'https://example.com/avatar.png',
      }), { status: 200 })) as typeof fetch

    const exchanged = await linkedinSocialProvider.exchangeCode({
      provider: 'linkedin',
      request: new Request('https://app.test/auth/linkedin/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/linkedin/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'linkedin-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Linked In',
      avatar: 'https://example.com/avatar.png',
    })
  })

  it('fails when the LinkedIn token or user info request fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(linkedinSocialProvider.exchangeCode({
      provider: 'linkedin',
      request: new Request('https://app.test/auth/linkedin/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/linkedin/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('LinkedIn token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(linkedinSocialProvider.exchangeCode({
      provider: 'linkedin',
      request: new Request('https://app.test/auth/linkedin/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/linkedin/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('LinkedIn user info request failed')
  })

  it('fails when LinkedIn user info does not include sub', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })) as typeof fetch

    await expect(linkedinSocialProvider.exchangeCode({
      provider: 'linkedin',
      request: new Request('https://app.test/auth/linkedin/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/linkedin/callback',
        scopes: ['openid'],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "sub"')
  })
})
