import { generateKeyPairSync, type KeyObject, sign as signSignature } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import appleSocialProvider from '../src'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token'
const originalFetch = globalThis.fetch
const appleKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const invalidKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const appleJwk = {
  ...appleKeyPair.publicKey.export({ format: 'jwk' }),
  kid: 'apple-test-key',
  alg: 'RS256',
  use: 'sig',
}

function encodeBase64Url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function createToken(
  payload: Record<string, unknown>,
  options: {
    readonly algorithm?: string
    readonly omitAlgorithm?: boolean
    readonly omitKid?: boolean
    readonly kid?: string
    readonly privateKey?: KeyObject
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    typ: 'JWT',
  }
  const signedHeader = {
    ...header,
    ...(options.omitAlgorithm ? {} : { alg: options.algorithm ?? 'RS256' }),
    ...(options.omitKid ? {} : { kid: options.kid ?? 'apple-test-key' }),
  }
  const claims = {
    iss: 'https://appleid.apple.com',
    aud: 'client',
    exp: now + 300,
    iat: now,
    ...payload,
  }
  const signingInput = `${encodeBase64Url(signedHeader)}.${encodeBase64Url(claims)}`
  const signature = signSignature(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    options.privateKey ?? appleKeyPair.privateKey,
  ).toString('base64url')

  return `${signingInput}.${signature}`
}

function tokenResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function jwksResponse(keys: readonly Record<string, unknown>[] = [appleJwk]): Response {
  return new Response(JSON.stringify({ keys }), { status: 200 })
}

function mockAppleFetch(
  payload: Record<string, unknown>,
  keys: readonly Record<string, unknown>[] = [appleJwk],
): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (url === APPLE_TOKEN_URL) {
      return tokenResponse(payload)
    }

    if (url === APPLE_JWKS_URL) {
      return jwksResponse(keys)
    }

    throw new Error(`Unexpected Apple fetch: ${url}`)
  }) as typeof fetch
}

function exchangeCode(
  options: {
    readonly clientId?: string
    readonly clientSecret?: string
    readonly request?: Request
    readonly redirectUri?: string
    readonly scopes?: readonly string[]
  } = {},
) {
  return appleSocialProvider.exchangeCode({
    provider: 'apple',
    request: options.request ?? new Request('https://app.test/auth/apple/callback?code=test'),
    code: 'test-code',
    codeVerifier: 'verifier',
    config: {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
      scopes: options.scopes ?? [],
      encryptTokens: false,
    },
  })
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

  it('builds authorization urls with configured scopes and optional values', async () => {
    const url = await appleSocialProvider.buildAuthorizationUrl({
      provider: 'apple',
      request: new Request('https://app.test/auth/apple'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        scopes: ['email'],
        encryptTokens: false,
      },
    })

    expect(url).toContain('scope=email')
    expect(url).toContain('client_id=')
    expect(url).toContain('redirect_uri=')
  })

  it('builds authorization urls with omitted optional scopes', async () => {
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
        encryptTokens: false,
      },
    })

    expect(url).toContain('scope=name+email')
  })

  it('exchanges the code and normalizes the verified Apple id token', async () => {
    mockAppleFetch({
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
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.test/auth/apple/callback',
    })

    expect(exchanged.profile).toEqual({
      id: 'apple-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Test User',
    })
    expect(exchanged.tokens.accessToken).toBe('access')
  })

  it('accepts audience arrays for Apple service identifiers', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        aud: ['other-client', 'client'],
      }),
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
    })

    expect(exchanged.profile.id).toBe('apple-user')
  })

  it('preserves the one-time Apple form payload name when id_token omits it', async () => {
    mockAppleFetch({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      id_token: createToken({
        sub: 'apple-user',
        email: 'user@example.com',
        email_verified: 'true',
      }),
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
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
    })

    expect(exchanged.profile).toEqual({
      id: 'apple-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Form Name',
    })
  })

  it('ignores POST callbacks without a usable Apple user payload', async () => {
    mockAppleFetch({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: createToken({
        sub: 'apple-user',
        email: 'user@example.com',
        email_verified: 'true',
        given_name: 'Token',
        family_name: 'Name',
      }),
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: 'test-code',
        }),
      }),
    })

    expect(exchanged.profile.name).toBe('Token Name')
    expect(exchanged.tokens.expiresAt).toBeUndefined()
  })

  it('ignores malformed Apple form payload JSON', async () => {
    mockAppleFetch({
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
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
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
    })

    expect(exchanged.profile.name).toBe('Token Name')
    expect(exchanged.tokens.expiresAt).toBeInstanceOf(Date)
  })

  it('fails when the Apple token exchange or id token is invalid', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Apple token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 })) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('did not include "id_token"')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse({
        access_token: 'access',
      })) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('did not include "id_token"')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse({
        access_token: 'access',
        id_token: 'bad-token',
      })) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Apple id_token was malformed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse({
        access_token: 'access',
        id_token: `${encodeBase64Url({ alg: 'RS256', kid: 'apple-test-key' })}.not-json.signature`,
      })) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Apple id_token payload was not valid JSON')
  })

  it('rejects unverified Apple id tokens', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }, {
        privateKey: invalidKeyPair.privateKey,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('signature verification failed')
  })

  it('accepts Apple id tokens without kid by using the first JWKS key', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }, {
        omitKid: true,
      }),
    })

    const exchanged = await exchangeCode({ clientId: 'client' })

    expect(exchanged.profile.id).toBe('apple-user')
  })

  it('rejects Apple id tokens with unsupported algorithms', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }, {
        algorithm: 'HS256',
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Unsupported Apple id_token algorithm "HS256"')
  })

  it('rejects Apple id tokens without an algorithm', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }, {
        omitAlgorithm: true,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Unsupported Apple id_token algorithm "unknown"')
  })

  it('rejects Apple id tokens without a matching public key', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }, {
        kid: 'missing-key',
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('signature verification failed')
  })

  it('rejects Apple id tokens when JWKS does not contain keys', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      return url === APPLE_TOKEN_URL
        ? tokenResponse({
          access_token: 'access',
          id_token: createToken({ sub: 'apple-user' }),
        })
        : new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('signature verification failed')
  })

  it('rejects Apple id tokens when JWKS loading fails', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      return url === APPLE_TOKEN_URL
        ? tokenResponse({
          access_token: 'access',
          id_token: createToken({ sub: 'apple-user' }),
        })
        : new Response('nope', { status: 503 })
    }) as typeof fetch

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('Failed to load Apple JWKS')
  })

  it('rejects Apple id tokens with invalid claims', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        iss: 'https://issuer.test',
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('issuer was invalid')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        aud: 'other-client',
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('audience was invalid')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        aud: ['other-client'],
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('audience was invalid')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        aud: { client: true },
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('audience was invalid')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('has expired')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        nbf: Math.floor(Date.now() / 1000) + 120,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('is not valid yet')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        iat: undefined,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('did not include "iat"')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        iat: Math.floor(Date.now() / 1000) + 120,
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('was issued in the future')
  })

  it('fails when Apple id token verification cannot use the configured client id', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
      }),
    })

    await expect(exchangeCode({ clientId: ' ' })).rejects.toThrow('requires clientId to be configured')

    await expect(exchangeCode()).rejects.toThrow('requires clientId to be configured')
  })

  it('fails when the Apple id token does not include required claims', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        exp: undefined,
        sub: 'apple-user',
      }),
    })

    await expect(exchangeCode({ clientId: 'client' })).rejects.toThrow('did not include "exp"')

    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        email: 'user@example.com',
      }),
    })

    await expect(exchangeCode({
      clientId: 'client',
      scopes: ['email'],
    })).rejects.toThrow('did not include "sub"')
  })

  it('normalizes optional Apple profile and token values', async () => {
    mockAppleFetch({
      id_token: createToken({
        sub: 'apple-user',
        email_verified: true,
      }),
      token_type: 'bearer',
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          user: JSON.stringify({
            email: 'form@example.com',
            name: {
              firstName: 123,
              lastName: 456,
            },
          }),
        }),
      }),
    })

    expect(exchanged.profile).toEqual({
      id: 'apple-user',
      email: 'form@example.com',
      emailVerified: true,
      name: undefined,
    })
    expect(exchanged.tokens).toMatchObject({
      accessToken: '',
      tokenType: 'bearer',
    })
  })

  it('continues when Apple form data cannot be parsed', async () => {
    mockAppleFetch({
      access_token: 'access',
      id_token: createToken({
        sub: 'apple-user',
        given_name: 'Token',
        family_name: 'Name',
      }),
    })

    const exchanged = await exchangeCode({
      clientId: 'client',
      request: new Request('https://app.test/auth/apple/callback', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=missing',
        },
        body: 'not multipart',
      }),
    })

    expect(exchanged.profile.name).toBe('Token Name')
  })
})
