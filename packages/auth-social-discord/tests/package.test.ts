import { afterEach, describe, expect, it, vi } from 'vitest'
import discordSocialProvider from '../src'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('@holo-js/auth-social-discord', () => {
  it('builds the authorization url with Discord defaults', async () => {
    const url = await discordSocialProvider.buildAuthorizationUrl({
      provider: 'discord',
      request: new Request('https://app.test/auth/discord'),
      state: 'state-1',
      codeVerifier: 'verifier',
      codeChallenge: 'challenge',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/discord/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(url).toContain('discord.com/oauth2/authorize')
    expect(url).toContain('scope=identify+email')
  })

  it('exchanges the code and normalizes the Discord profile', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'discord-user',
        username: 'octo',
        global_name: 'Octo',
        email: 'user@example.com',
        verified: true,
        avatar: 'avatar-hash',
      }), { status: 200 })) as typeof fetch

    const exchanged = await discordSocialProvider.exchangeCode({
      provider: 'discord',
      request: new Request('https://app.test/auth/discord/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/discord/callback',
        scopes: [],
        encryptTokens: false,
      },
    })

    expect(exchanged.profile).toEqual({
      id: 'discord-user',
      email: 'user@example.com',
      emailVerified: true,
      name: 'Octo',
      avatar: 'https://cdn.discordapp.com/avatars/discord-user/avatar-hash.png',
    })
  })

  it('fails when the Discord token or user request fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) as typeof fetch

    await expect(discordSocialProvider.exchangeCode({
      provider: 'discord',
      request: new Request('https://app.test/auth/discord/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/discord/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Discord token exchange failed')

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })) as typeof fetch

    await expect(discordSocialProvider.exchangeCode({
      provider: 'discord',
      request: new Request('https://app.test/auth/discord/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/discord/callback',
        scopes: [],
        encryptTokens: false,
      },
    })).rejects.toThrow('Discord user request failed')
  })

  it('fails when the Discord profile does not include an id', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ username: 'octo' }), { status: 200 })) as typeof fetch

    await expect(discordSocialProvider.exchangeCode({
      provider: 'discord',
      request: new Request('https://app.test/auth/discord/callback?code=test'),
      code: 'test-code',
      codeVerifier: 'verifier',
      config: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.test/auth/discord/callback',
        scopes: ['identify'],
        encryptTokens: false,
      },
    })).rejects.toThrow('did not include "id"')
  })
})
