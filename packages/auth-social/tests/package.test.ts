import { afterEach, describe, expect, it } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, resetAuthRuntime, tokens } from '../../auth/src'
import type { AuthProviderAdapter, AuthTokenStore, PersonalAccessTokenRecord } from '../../auth/src'
import {
  callback,
  configureSocialAuthRuntime,
  decryptTokens,
  redirect,
  resetSocialAuthRuntime,
  socialAuth,
  socialAuthInternals,
} from '../src'

type SessionRecord = {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}

type SessionStore = {
  read(sessionId: string): Promise<SessionRecord | null>
  write(record: SessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
}

type UserRecord = {
  id: number
  name?: string
  email: string
  password?: string | null
  avatar?: string | null
  email_verified_at?: Date | null
}

class InMemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>()
  async read(sessionId: string): Promise<SessionRecord | null> {
    return this.records.get(sessionId) ?? null
  }
  async write(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record)
  }
  async delete(sessionId: string): Promise<void> {
    this.records.delete(sessionId)
  }
}

class InMemoryProviderAdapter implements AuthProviderAdapter<UserRecord> {
  readonly users = new Map<number, UserRecord>()
  readonly usersByEmail = new Map<string, number>()
  nextId = 1

  async findById(id: string | number): Promise<UserRecord | null> {
    const normalized = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
    return this.users.get(normalized) ?? null
  }

  async findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<UserRecord | null> {
    const value = typeof credentials.email === 'string' ? credentials.email : ''
    const id = this.usersByEmail.get(value)
    return typeof id === 'number' ? this.users.get(id) ?? null : null
  }

  async create(input: {
    readonly name?: string
    readonly email: string
    readonly password?: string | null
    readonly avatar?: string | null
    readonly email_verified_at?: Date | null
  }): Promise<UserRecord> {
    const created: UserRecord = {
      id: this.nextId,
      name: input.name,
      email: input.email,
      password: input.password,
      avatar: input.avatar,
      email_verified_at: input.email_verified_at,
    }
    this.nextId += 1
    this.users.set(created.id, created)
    this.usersByEmail.set(created.email, created.id)
    return created
  }

  getId(user: UserRecord): string | number {
    return user.id
  }

  serialize(user: UserRecord) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar ?? null,
      email_verified_at: user.email_verified_at ?? null,
    }
  }
}

class InMemoryTokenStore implements AuthTokenStore {
  async create(_record: PersonalAccessTokenRecord): Promise<void> {}
  async findById(_id: string): Promise<PersonalAccessTokenRecord | null> { return null }
  async listByUserId(_provider: string, _userId: string | number): Promise<readonly PersonalAccessTokenRecord[]> { return [] }
  async update(_record: PersonalAccessTokenRecord): Promise<void> {}
  async delete(_id: string): Promise<void> {}
  async deleteByUserId(_provider: string, _userId: string | number): Promise<number> { return 0 }
}

class InMemoryStateStore {
  readonly records = new Map<string, { provider: string, state: string, codeVerifier: string, guard: string, createdAt: Date }>()
  async create(record: { provider: string, state: string, codeVerifier: string, guard: string, createdAt: Date }): Promise<void> {
    this.records.set(`${record.provider}:${record.state}`, record)
  }
  async read(provider: string, state: string) {
    return this.records.get(`${provider}:${state}`) ?? null
  }
  async delete(provider: string, state: string): Promise<void> {
    this.records.delete(`${provider}:${state}`)
  }
}

class InMemoryIdentityStore {
  readonly records = new Map<string, {
    provider: string
    providerUserId: string
    guard: string
    authProvider: string
    userId: string | number
    email?: string
    emailVerified: boolean
    profile: Readonly<Record<string, unknown>>
    tokens?: unknown
    linkedAt: Date
    updatedAt: Date
  }>()

  async findByProviderUserId(provider: string, providerUserId: string) {
    return this.records.get(`${provider}:${providerUserId}`) ?? null
  }

  async save(record: {
    provider: string
    providerUserId: string
    guard: string
    authProvider: string
    userId: string | number
    email?: string
    emailVerified: boolean
    profile: Readonly<Record<string, unknown>>
    tokens?: unknown
    linkedAt: Date
    updatedAt: Date
  }): Promise<void> {
    this.records.set(`${record.provider}:${record.providerUserId}`, record)
  }
}

function configureRuntime(options: {
  emailVerificationRequired?: boolean
  socialGuard?: 'web' | 'admin' | 'api'
  encryptTokens?: boolean
} = {}) {
  const sessionStore = new InMemorySessionStore()
  configureSessionRuntime({
    config: {
      driver: 'database',
      stores: {
        database: {
          name: 'database',
          driver: 'database',
          connection: 'main',
          table: 'sessions',
        },
      },
      cookie: {
        name: 'holo_session',
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        partitioned: false,
        maxAge: 120,
      },
      idleTimeout: 120,
      absoluteLifetime: 120,
      rememberMeLifetime: 43200,
    },
    stores: {
      database: sessionStore,
    },
  })

  const usersProvider = new InMemoryProviderAdapter()
  const adminsProvider = new InMemoryProviderAdapter()
  const context = authRuntimeInternals.createMemoryAuthContext()
  configureAuthRuntime({
    config: defineAuthConfig({
      defaults: {
        guard: 'web',
        passwords: 'users',
      },
      guards: {
        web: { driver: 'session', provider: 'users' },
        admin: { driver: 'session', provider: 'admins' },
        api: { driver: 'token', provider: 'users' },
      },
      providers: {
        users: { model: 'User' },
        admins: { model: 'Admin' },
      },
      emailVerification: {
        required: options.emailVerificationRequired === true,
      },
      social: {
        google: {
          clientId: 'google-client',
          clientSecret: 'google-secret',
          redirectUri: 'https://app.test/auth/google/callback',
          scopes: ['openid', 'email', 'profile'],
          guard: options.socialGuard,
          encryptTokens: options.encryptTokens === true,
        },
      },
    }),
    session: getSessionRuntime(),
    providers: {
      users: usersProvider,
      admins: adminsProvider,
    },
    tokens: new InMemoryTokenStore(),
    context,
  })

  const stateStore = new InMemoryStateStore()
  const identityStore = new InMemoryIdentityStore()
  const exchangeProfiles = new Map<string, {
    profile: { id: string, email?: string, emailVerified?: boolean, name?: string, avatar?: string }
    tokens: { accessToken: string, refreshToken?: string }
    expectedVerifier?: string
  }>()

  configureSocialAuthRuntime({
    providers: {
      google: {
        buildAuthorizationUrl({ state, codeChallenge, config }) {
          const url = new URL('https://accounts.example.com/oauth/authorize')
          url.searchParams.set('client_id', config.clientId ?? '')
          url.searchParams.set('redirect_uri', config.redirectUri ?? '')
          url.searchParams.set('response_type', 'code')
          url.searchParams.set('scope', (config.scopes ?? []).join(' '))
          url.searchParams.set('state', state)
          url.searchParams.set('code_challenge', codeChallenge)
          url.searchParams.set('code_challenge_method', 'S256')
          return url.toString()
        },
        async exchangeCode({ code, codeVerifier }) {
          const resolved = exchangeProfiles.get(code)
          if (!resolved) {
            throw new Error(`Unknown code: ${code}`)
          }
          if (resolved.expectedVerifier && resolved.expectedVerifier !== codeVerifier) {
            throw new Error('PKCE verification failed.')
          }
          return resolved
        },
      },
    },
    stateStore,
    identityStore,
    encryptionKey: options.encryptTokens ? 'phase-6-encryption-key' : undefined,
  })

  return {
    sessionStore,
    usersProvider,
    adminsProvider,
    context,
    stateStore,
    identityStore,
    exchangeProfiles,
  }
}

afterEach(() => {
  resetSocialAuthRuntime()
  resetAuthRuntime()
  resetSessionRuntime()
})

describe('@holo-js/auth-social', () => {
  it('exports the social auth facade and helpers', () => {
    expect(socialAuth.redirect).toBe(redirect)
    expect(socialAuth.callback).toBe(callback)
  })

  it('builds a redirect URL with state and PKCE and rejects unknown callback state', async () => {
    const runtime = configureRuntime()
    const response = await redirect('google', new Request('https://app.test/auth/google'))
    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).toContain('https://accounts.example.com/oauth/authorize')
    const url = new URL(location!)
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(runtime.stateStore.records.size).toBe(1)

    const invalid = await callback('google', new Request('https://app.test/auth/google/callback?state=bad&code=demo'))
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      message: 'Invalid or expired OAuth state.',
    })
  })

  it('links by existing identity first and signs the linked local user in', async () => {
    const runtime = configureRuntime()
    const localUser = await runtime.usersProvider.create({
      name: 'Existing User',
      email: 'existing@example.com',
      password: null,
      email_verified_at: null,
    })
    await runtime.identityStore.save({
      provider: 'google',
      providerUserId: 'google-123',
      guard: 'web',
      authProvider: 'users',
      userId: localUser.id,
      email: localUser.email,
      emailVerified: false,
      profile: {},
      tokens: undefined,
      linkedAt: new Date('2026-04-08T00:00:00.000Z'),
      updatedAt: new Date('2026-04-08T00:00:00.000Z'),
    })

    const redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    const state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-1', {
      profile: {
        id: 'google-123',
        email: 'different@example.com',
        emailVerified: true,
        name: 'Provider Name',
      },
      tokens: {
        accessToken: 'access',
      },
    })

    const response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-1`))
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('holo_session=')
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      provider: 'google',
      user: {
        id: localUser.id,
        email: 'existing@example.com',
      },
    })
    expect(runtime.context.getSessionId('web')).toBeTypeOf('string')
  })

  it('links to an existing local user by verified email and creates a new user when no local match exists', async () => {
    const runtime = configureRuntime()
    const existing = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: null,
    })

    let redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    let state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-link', {
      profile: {
        id: 'google-link',
        email: 'ava@example.com',
        emailVerified: true,
        name: 'Ava Social',
      },
      tokens: {
        accessToken: 'link-token',
      },
    })
    let response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-link`))
    expect(response.status).toBe(200)
    expect((await runtime.identityStore.findByProviderUserId('google', 'google-link'))?.userId).toBe(existing.id)

    redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-create', {
      profile: {
        id: 'google-create',
        email: 'new@example.com',
        emailVerified: true,
        name: 'New Social User',
        avatar: 'https://example.com/avatar.png',
      },
      tokens: {
        accessToken: 'create-token',
      },
    })
    response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-create`))
    await expect(response.json()).resolves.toMatchObject({
      user: {
        email: 'new@example.com',
        name: 'New Social User',
      },
    })
    expect(runtime.usersProvider.usersByEmail.has('new@example.com')).toBe(true)
  })

  it('preserves the auth provider marker on linked social users', async () => {
    const runtime = configureRuntime({
      socialGuard: 'admin',
    })

    const linked = await socialAuthInternals.resolveLinkedUser('google', {
      id: 'google-admin',
      email: 'admin@example.com',
      emailVerified: true,
      name: 'Admin Social',
    }, {
      accessToken: 'admin-token',
    })

    await expect(tokens.create(linked.user, {
      name: 'social-admin',
    })).resolves.toMatchObject({
      provider: 'admins',
      userId: 1,
    })
  })

  it('does not bind an unverified social email onto an existing local account', async () => {
    const runtime = configureRuntime()
    const existing = await runtime.usersProvider.create({
      name: 'Existing Local User',
      email: 'ava@example.com',
      password: null,
      email_verified_at: null,
    })

    const redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    const state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-unverified-existing', {
      profile: {
        id: 'google-unverified-existing',
        email: 'ava@example.com',
        emailVerified: false,
        name: 'Unverified Social User',
      },
      tokens: {
        accessToken: 'unverified-token',
      },
    })

    const response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-unverified-existing`))
    expect(response.status).toBe(200)

    const storedIdentity = await runtime.identityStore.findByProviderUserId('google', 'google-unverified-existing')
    expect(storedIdentity?.userId).not.toBe(existing.id)
    expect(runtime.usersProvider.users.size).toBe(2)
    expect(runtime.usersProvider.usersByEmail.has('google-unverified-existing@google.social.local')).toBe(true)
  })

  it('accepts OAuth callbacks submitted as form posts', async () => {
    const runtime = configureRuntime()
    const redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    const state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-form-post', {
      profile: {
        id: 'google-form-post',
        email: 'form@example.com',
        emailVerified: true,
        name: 'Form Post User',
      },
      tokens: {
        accessToken: 'form-token',
      },
    })

    const response = await callback('google', new Request('https://app.test/auth/google/callback', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        state,
        code: 'code-form-post',
      }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      provider: 'google',
      user: {
        email: 'form@example.com',
      },
    })
  })

  it('blocks unverified email when local policy requires verification and allows it otherwise', async () => {
    const blockedRuntime = configureRuntime({
      emailVerificationRequired: true,
    })
    let redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    let state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    blockedRuntime.exchangeProfiles.set('code-block', {
      profile: {
        id: 'google-block',
        email: 'blocked@example.com',
        emailVerified: false,
        name: 'Blocked',
      },
      tokens: {
        accessToken: 'blocked-token',
      },
    })
    await expect(callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-block`))).rejects.toThrow(
      'requires a verified email',
    )

    resetSocialAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()

    const allowedRuntime = configureRuntime()
    redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    allowedRuntime.exchangeProfiles.set('code-allow', {
      profile: {
        id: 'google-allow',
        name: 'No Email',
      },
      tokens: {
        accessToken: 'allow-token',
      },
    })
    const response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-allow`))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      user: {
        email: 'google-allow@google.social.local',
      },
    })
  })

  it('supports social login against a non-default guard/provider and can encrypt stored tokens', async () => {
    const runtime = configureRuntime({
      socialGuard: 'admin',
      encryptTokens: true,
    })
    const redirectResponse = await redirect('google', new Request('https://app.test/auth/google'))
    const state = new URL(redirectResponse.headers.get('location')!).searchParams.get('state')!
    runtime.exchangeProfiles.set('code-admin', {
      profile: {
        id: 'google-admin',
        email: 'admin@example.com',
        emailVerified: true,
        name: 'Admin Social',
      },
      tokens: {
        accessToken: 'admin-access',
        refreshToken: 'admin-refresh',
      },
    })

    const response = await callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-admin`))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      guard: 'admin',
      user: {
        email: 'admin@example.com',
      },
    })
    expect(runtime.context.getSessionId('admin')).toBeTypeOf('string')
    expect(runtime.adminsProvider.usersByEmail.has('admin@example.com')).toBe(true)

    const storedIdentity = await runtime.identityStore.findByProviderUserId('google', 'google-admin')
    expect(storedIdentity?.tokens).toMatchObject({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    })
    expect(decryptTokens(storedIdentity?.tokens, 'phase-6-encryption-key')).toMatchObject({
      accessToken: 'admin-access',
      refreshToken: 'admin-refresh',
    })
  })

  it('rejects social providers mapped to token guards', async () => {
    configureRuntime({
      socialGuard: 'api',
    })
    await expect(redirect('google', new Request(
      'https://app.test/auth/google',
    ))).rejects.toThrow('requires auth guard "api" to use the session driver')
  })

  it('fails closed for missing provider runtime, missing config activation, and PKCE mismatch', async () => {
    const runtime = configureRuntime()
    configureSocialAuthRuntime({
      providers: {},
      stateStore: runtime.stateStore,
      identityStore: runtime.identityStore,
    })
    await expect(redirect('google', new Request('https://app.test/auth/google'))).rejects.toThrow(
      'provider runtime "google" is not configured',
    )

    resetSocialAuthRuntime()
    configureSocialAuthRuntime({
      providers: {
        google: {
          buildAuthorizationUrl({ state, codeChallenge }) {
            const url = new URL('https://accounts.example.com/oauth/authorize')
            url.searchParams.set('state', state)
            url.searchParams.set('code_challenge', codeChallenge)
            return url.toString()
          },
          async exchangeCode() {
            return {
              profile: { id: 'google-pkce', email: 'pkce@example.com', emailVerified: true },
              tokens: { accessToken: 'pkce-token' },
            }
          },
        },
      },
      stateStore: runtime.stateStore,
      identityStore: runtime.identityStore,
    })
    const configuredRedirect = await redirect('google', new Request('https://app.test/auth/google'))
    const state = new URL(configuredRedirect.headers.get('location')!).searchParams.get('state')!
    const pending = await runtime.stateStore.read('google', state)
    runtime.exchangeProfiles.set('code-pkce', {
      profile: {
        id: 'google-pkce',
        email: 'pkce@example.com',
        emailVerified: true,
      },
      tokens: {
        accessToken: 'pkce-token',
      },
      expectedVerifier: `${pending?.codeVerifier}-wrong`,
    })
    configureSocialAuthRuntime({
      providers: {
        google: {
          buildAuthorizationUrl({ state: stateValue, codeChallenge }) {
            const url = new URL('https://accounts.example.com/oauth/authorize')
            url.searchParams.set('state', stateValue)
            url.searchParams.set('code_challenge', codeChallenge)
            return url.toString()
          },
          async exchangeCode({ code, codeVerifier }) {
            const resolved = runtime.exchangeProfiles.get(code)!
            if (resolved.expectedVerifier !== codeVerifier) {
              throw new Error('PKCE verification failed.')
            }
            return resolved
          },
        },
      },
      stateStore: runtime.stateStore,
      identityStore: runtime.identityStore,
    })
    await expect(callback('google', new Request(`https://app.test/auth/google/callback?state=${state}&code=code-pkce`))).rejects.toThrow(
      'PKCE verification failed.',
    )

    resetSocialAuthRuntime()
    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: { driver: 'session', provider: 'users' },
        },
        providers: {
          users: { model: 'User' },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
      },
      tokens: new InMemoryTokenStore(),
      context: runtime.context,
    })
    await expect(redirect('google', new Request('https://app.test/auth/google'))).rejects.toThrow(
      'Social provider "google" is not configured in auth.social.',
    )
  })

  it('exposes deterministic helper internals for state, PKCE, and synthetic email fallback', () => {
    const verifier = socialAuthInternals.createCodeVerifier()
    const challenge = socialAuthInternals.createCodeChallenge(verifier)
    expect(verifier).toBeTruthy()
    expect(challenge).toBeTruthy()
    expect(socialAuthInternals.createState()).toBeTruthy()
    expect(socialAuthInternals.resolveEmailForCreation('google', {
      id: 'provider-1',
    })).toBe('provider-1@google.social.local')
    expect(socialAuthInternals.resolveEmailForCreation('google', {
      id: 'provider-2',
      email: 'user@example.com',
    }, {
      trustEmail: false,
    })).toBe('provider-2@google.social.local')
  })
})
