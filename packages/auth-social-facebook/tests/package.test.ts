import { afterEach, describe, expect, it, vi } from 'vitest'
import facebookSocialProvider from '../src'

const originalFetch = globalThis.fetch

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type CapturedFetchCall = readonly [input: FetchInput, init: FetchInit]

function urlFromFetchInput(input: FetchInput): URL {
  if (typeof input === 'string') {
    return new URL(input)
  }

  if (input instanceof URL) {
    return input
  }

  return new URL(input.url)
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
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

  it('builds the authorization url with custom scopes and empty optional config fields', async () => {
    const url = new URL(await facebookSocialProvider.buildAuthorizationUrl({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        encryptTokens: false,
      },
    }))
    expect(url.searchParams.get('client_id')).toBe('')
    expect(url.searchParams.get('redirect_uri')).toBe('')
    expect(url.searchParams.get('scope')).toBe('email,public_profile')

    const scopedUrl = new URL(await facebookSocialProvider.buildAuthorizationUrl({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/facebook/callback',
        scopes: ['pages_show_list'],
        encryptTokens: false,
      },
    }))
    expect(scopedUrl.searchParams.get('scope')).toBe('pages_show_list')
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

  it('uses empty defaults for optional token config and profile fields', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'facebook-user' }), { status: 200 })) as typeof fetch

    const exchanged = await facebookSocialProvider.exchangeCode({
      provider: 'facebook',
      request: new Request('https://app.test/auth/facebook/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        encryptTokens: false,
      },
    })

    expect(exchanged).toEqual({
      profile: {
        id: 'facebook-user',
        email: undefined,
        emailVerified: false,
        name: undefined,
        avatar: undefined,
      },
      tokens: {
        accessToken: '',
        expiresAt: undefined,
        tokenType: undefined,
      },
    })
  })

  it('normalizes string token expiry values', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'))
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        expires_in: '60',
        token_type: 'bearer',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'facebook-user',
        name: 'Face Book',
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

    expect(exchanged.tokens).toEqual({
      accessToken: 'access',
      expiresAt: new Date('2026-05-19T00:01:00.000Z'),
      tokenType: 'bearer',
    })
  })

  it('keeps OAuth secrets out of Facebook request URLs', async () => {
    const fetchCalls: CapturedFetchCall[] = []
    const responses = [
      new Response(JSON.stringify({
        access_token: 'access',
        expires_in: 3600,
      }), { status: 200 }),
      new Response(JSON.stringify({
        id: 'facebook-user',
        name: 'Face Book',
      }), { status: 200 }),
    ]

    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      fetchCalls.push([input, init])
      const response = responses.shift()
      if (!response) {
        throw new Error('Unexpected fetch call')
      }

      return response
    }) as typeof fetch

    await facebookSocialProvider.exchangeCode({
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

    const tokenCall = fetchCalls[0]
    const profileCall = fetchCalls[1]
    if (!tokenCall || !profileCall) {
      throw new Error('Expected Facebook token and profile fetch calls')
    }

    const [tokenInput, tokenInit] = tokenCall
    const tokenUrl = urlFromFetchInput(tokenInput)
    expect(tokenUrl.toString()).toBe('https://graph.facebook.com/oauth/access_token')
    expect(tokenUrl.searchParams.has('client_secret')).toBe(false)
    expect(tokenUrl.searchParams.has('code')).toBe(false)
    expect(tokenInit?.method).toBe('POST')
    expect(tokenInit?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(tokenInit?.body).toBeInstanceOf(URLSearchParams)
    const tokenBody = tokenInit?.body
    if (!(tokenBody instanceof URLSearchParams)) {
      throw new Error('Expected Facebook token request to use URLSearchParams')
    }

    expect(tokenBody.get('client_id')).toBe('client')
    expect(tokenBody.get('client_secret')).toBe('secret')
    expect(tokenBody.get('redirect_uri')).toBe('https://app.test/auth/facebook/callback')
    expect(tokenBody.get('code')).toBe('test-code')

    const [profileInput, profileInit] = profileCall
    const profileUrl = urlFromFetchInput(profileInput)
    expect(profileUrl.toString()).toBe('https://graph.facebook.com/me?fields=id%2Cname%2Cemail%2Cpicture')
    expect(profileUrl.searchParams.has('access_token')).toBe(false)
    expect(profileInit?.headers).toEqual({
      authorization: 'Bearer access',
      accept: 'application/json',
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
      .mockResolvedValueOnce(new Response('', { status: 200 })) as typeof fetch

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
