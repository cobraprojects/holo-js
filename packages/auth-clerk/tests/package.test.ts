import { generateKeyPairSync, sign as signData } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, logout, provider, resetAuthRuntime } from '../../auth/src'
import type { AuthProviderAdapter } from '../../auth/src'
import {
  ClerkAuthConflictError,
  authenticate,
  clerkAuth,
  clerkAuthInternals,
  completeClerkAuth,
  configureClerkAuthRuntime,
  loginWithClerk,
  logoutWithClerk,
  resetClerkAuthRuntime,
  registerWithClerk,
  syncIdentity,
  verifyRequest,
  verifySession,
} from '../src'

const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

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
  name: string
  email: string
  role: 'admin' | 'member'
  avatarUrl?: string | null
  password?: string | null
  avatar?: string | null
  clerkUserId?: string
  email_verified_at?: Date | null
}

type ClerkSessionFixture = {
  readonly sessionId: string
  readonly user: {
    readonly id: string
    readonly email?: string
    readonly emailVerified?: boolean
    readonly firstName?: string
    readonly lastName?: string
    readonly name?: string
    readonly imageUrl?: string
    readonly primaryEmailAddressId?: string
    readonly emailAddresses?: readonly {
      readonly id?: string
      readonly emailAddress: string
      readonly verificationStatus?: 'verified' | 'unverified' | 'pending'
    }[]
  }
  readonly raw?: unknown
}

type FetchMockInput = string | URL | Request

function resolveFetchMockUrl(input: FetchMockInput): string {
  if (input instanceof Request) {
    return input.url
  }

  if (input instanceof URL) {
    return input.href
  }

  return input
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
    readonly clerkUserId?: string
    readonly email_verified_at?: Date | null
  }): Promise<UserRecord> {
    const created: UserRecord = {
      id: this.nextId,
      name: input.name ?? input.email,
      email: input.email,
      role: 'member',
      avatarUrl: input.avatar ?? null,
      password: input.password,
      avatar: input.avatar,
      clerkUserId: input.clerkUserId,
      email_verified_at: input.email_verified_at,
    }
    this.nextId += 1
    this.users.set(created.id, created)
    this.usersByEmail.set(created.email, created.id)
    return created
  }

  async delete(id: string | number): Promise<void> {
    const normalized = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
    const user = this.users.get(normalized)
    if (user) {
      this.usersByEmail.delete(user.email)
    }
    this.users.delete(normalized)
  }

  async update(user: UserRecord, input: {
    readonly name?: string
    readonly email?: string
    readonly avatar?: string | null
    readonly clerkUserId?: string
    readonly email_verified_at?: Date | null
    readonly password?: string | null
  }): Promise<UserRecord> {
    const currentEmail = user.email
    if (typeof input.name !== 'undefined') {
      user.name = input.name
    }
    if (typeof input.email !== 'undefined') {
      user.email = input.email
    }
    if (typeof input.avatar !== 'undefined') {
      user.avatar = input.avatar
      user.avatarUrl = input.avatar
    }
    if (typeof input.clerkUserId !== 'undefined') {
      user.clerkUserId = input.clerkUserId
    }
    if (typeof input.email_verified_at !== 'undefined') {
      user.email_verified_at = input.email_verified_at
    }
    if (typeof input.password !== 'undefined') {
      user.password = input.password
    }
    if (currentEmail !== user.email) {
      this.usersByEmail.delete(currentEmail)
      this.usersByEmail.set(user.email, user.id)
    }

    return user
  }

  getId(user: UserRecord): string | number {
    return user.id
  }

  serialize(user: UserRecord) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar ?? null,
      avatarUrl: user.avatarUrl ?? user.avatar ?? null,
      clerkUserId: user.clerkUserId,
      email_verified_at: user.email_verified_at ?? null,
    }
  }
}

class SnapshotProviderAdapter implements AuthProviderAdapter<UserRecord> {
  readonly users = new Map<number, UserRecord>()
  readonly usersByEmail = new Map<string, number>()
  nextId = 1

  async findById(id: string | number): Promise<UserRecord | null> {
    const normalized = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
    const record = this.users.get(normalized)
    return record ? { ...record } : null
  }

  async findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<UserRecord | null> {
    const value = typeof credentials.email === 'string' ? credentials.email : ''
    const id = this.usersByEmail.get(value)
    const record = typeof id === 'number' ? this.users.get(id) : undefined
    return record ? { ...record } : null
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
      name: input.name ?? input.email,
      email: input.email,
      role: 'member',
      avatarUrl: input.avatar ?? null,
      password: input.password,
      avatar: input.avatar,
      email_verified_at: input.email_verified_at,
    }
    this.nextId += 1
    this.users.set(created.id, created)
    this.usersByEmail.set(created.email, created.id)
    return { ...created }
  }

  getId(user: UserRecord): string | number {
    return user.id
  }

  serialize(user: UserRecord) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar ?? null,
      avatarUrl: user.avatarUrl ?? user.avatar ?? null,
      email_verified_at: user.email_verified_at ?? null,
    }
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
    linkedAt: Date
    updatedAt: Date
  }>()

  async findByProviderUserId(provider: string, providerUserId: string) {
    return this.records.get(`${provider}:${providerUserId}`) ?? null
  }

  async findByUserId(provider: string, authProvider: string, userId: string | number) {
    for (const record of this.records.values()) {
      if (record.provider === provider && record.authProvider === authProvider && record.userId === userId) {
        return record
      }
    }

    return null
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
    linkedAt: Date
    updatedAt: Date
  }): Promise<void> {
    this.records.set(`${record.provider}:${record.providerUserId}`, record)
  }

  async claim(record: {
    provider: string
    providerUserId: string
    guard: string
    authProvider: string
    userId: string | number
    email?: string
    emailVerified: boolean
    profile: Readonly<Record<string, unknown>>
    linkedAt: Date
    updatedAt: Date
  }) {
    const key = `${record.provider}:${record.providerUserId}`
    const existing = this.records.get(key)
    if (existing) {
      return existing
    }

    this.records.set(key, record)
    return record
  }
}

function configureRuntime(options: {
  emailVerificationRequired?: boolean
  apiUrl?: string
  clerkGuard?: 'web' | 'admin' | 'api'
  includeClerkConfig?: boolean
  configureClerkRuntime?: boolean
  frontendApi?: string
  publishableKey?: string
  redirectUri?: string
  secretKey?: string
  responseCookies?: string[]
  redirectResponses?: {
    url: string
    status?: 301 | 302 | 303 | 307 | 308
  }[]
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
  const authContext = options.responseCookies || options.redirectResponses
    ? {
        ...context,
        appendResponseCookie(cookie: string) {
          options.responseCookies?.push(cookie)
        },
        redirectResponse(url: string, status?: 301 | 302 | 303 | 307 | 308) {
          options.redirectResponses?.push({ url, status })
        },
      }
    : context

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
      clerk: options.includeClerkConfig === false
        ? undefined
        : {
            provider: 'app',
            app: {
              apiUrl: options.apiUrl,
              publishableKey: options.publishableKey ?? 'pk_test',
              secretKey: options.secretKey ?? 'sk_test',
              frontendApi: options.frontendApi ?? 'https://accounts.app.test',
              redirectUri: options.redirectUri ?? 'https://app.test/api/auth/clerk/callback',
              sessionCookie: '__session',
              guard: options.clerkGuard,
              mapToProvider: options.clerkGuard === 'admin' ? 'admins' : undefined,
            },
          },
    }),
    session: getSessionRuntime(),
    providers: {
      users: usersProvider,
      admins: adminsProvider,
    },
    context: authContext,
  })

  const identityStore = new InMemoryIdentityStore()
  const sessions = new Map<string, ClerkSessionFixture | null>()

  if (options.configureClerkRuntime !== false) {
    configureClerkAuthRuntime({
      providers: {
        app: {
          async verifySession({ token }) {
            const session = sessions.get(token)
            if (!session) {
              return null
            }

            return {
              ...session,
              user: clerkAuthInternals.normalizeClerkUserProfile(session.user),
              accessToken: token,
            }
          },
        },
      },
      identityStore,
    })
  }

  return {
    sessionStore,
    usersProvider,
    adminsProvider,
    identityStore,
    sessions,
  }
}

afterEach(() => {
  resetClerkAuthRuntime()
  resetAuthRuntime()
  resetSessionRuntime()
  vi.doUnmock('@clerk/backend')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function createSignedJwt(
  payload: Readonly<Record<string, unknown>>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  header: Readonly<Record<string, unknown>> = {
    alg: 'RS256',
    kid: 'clerk-test-key',
    typ: 'JWT',
  },
): string {
  const encodedHeader = encodeBase64Url(JSON.stringify(header))
  const encodedPayload = encodeBase64Url(JSON.stringify({
    azp: 'https://app.test',
    ...payload,
  }))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signData('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function createUnsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  return [
    encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    encodeBase64Url(JSON.stringify(payload)),
    'signature',
  ].join('.')
}

function createJwksResponse(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): Response {
  return new Response(JSON.stringify({
    keys: [
      {
        ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
        kid: 'clerk-test-key',
        use: 'sig',
        alg: 'RS256',
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('@holo-js/auth-clerk', () => {
  it('exports the Clerk auth facade and helpers', () => {
    expect(clerkAuth.authenticate).toBe(authenticate)
    expect(clerkAuth.completeClerkAuth).toBe(completeClerkAuth)
    expect(clerkAuth.loginWithClerk).toBe(loginWithClerk)
    expect(clerkAuth.logoutWithClerk).toBe(logoutWithClerk)
    expect(clerkAuth.registerWithClerk).toBe(registerWithClerk)
    expect(clerkAuth.verifyRequest).toBe(verifyRequest)
    expect(clerkAuth.verifySession).toBe(verifySession)
    expect(typeof clerkAuthInternals.resolveEmailForCreation).toBe('function')
  })

  it('normalizes fetch mock request inputs to URL strings', () => {
    expect(resolveFetchMockUrl('https://api.clerk.test/v1/jwks')).toBe('https://api.clerk.test/v1/jwks')
    expect(resolveFetchMockUrl(new URL('https://api.clerk.test/v1/users/user_1'))).toBe('https://api.clerk.test/v1/users/user_1')
    expect(resolveFetchMockUrl(new Request('https://api.clerk.test/v1/sessions/session_1/revoke'))).toBe('https://api.clerk.test/v1/sessions/session_1/revoke')
  })

  it('merges partial runtime configuration updates', () => {
    const identityStore = new InMemoryIdentityStore()
    const providers = Object.freeze({
      app: {
        async verifySession() {
          return null
        },
      },
    })

    configureClerkAuthRuntime({
      identityStore,
    })
    expect(clerkAuthInternals.getBindings()).toEqual({
      providers: {},
      identityStore,
    })

    configureClerkAuthRuntime({
      providers,
    })

    expect(clerkAuthInternals.getBindings()).toEqual({
      providers,
      identityStore,
    })
  })

  it('uses the built-in verifier when only the identity store is configured', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_clerk_1',
      sid: 'sess_clerk_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const fetchMock = vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://api.clerk.com/v1/jwks') {
        return createJwksResponse(publicKey)
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_1') {
        return new Response(JSON.stringify({
          id: 'user_clerk_1',
          first_name: 'Clerk',
          last_name: 'User',
          image_url: 'https://cdn.test/avatar.png',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'clerk@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${token}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_1',
      user: {
        id: 'user_clerk_1',
        firstName: 'Clerk',
        lastName: 'User',
        imageUrl: 'https://cdn.test/avatar.png',
      },
    })
  })

  it('rejects Clerk tokens whose azp does not match the request origin or configured parties', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const mismatchToken = createSignedJwt({
      sub: 'user_clerk_azp_mismatch',
      sid: 'sess_clerk_azp_mismatch',
      azp: 'https://foreign.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const matchingToken = createSignedJwt({
      sub: 'user_clerk_azp_match',
      sid: 'sess_clerk_azp_match',
      azp: 'https://app.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const fetchMock = vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://api.clerk.com/v1/jwks') {
        return createJwksResponse(publicKey)
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_azp_match') {
        return new Response(JSON.stringify({
          id: 'user_clerk_azp_match',
          first_name: 'Clerk',
          last_name: 'User',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'clerk@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            sessionCookie: '__session',
            authorizedParties: ['https://app.test'],
          },
        },
      }),
    })

    await expect(verifySession(mismatchToken)).rejects.toThrow('authorized party')
    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${mismatchToken}`,
      },
    }))).rejects.toThrow('authorized party')
    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${matchingToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_azp_match',
      user: {
        id: 'user_clerk_azp_match',
      },
    })
  })

  it('rejects built-in Clerk JWTs without required bound claims', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const missingAuthorizedParty = createSignedJwt({
      azp: undefined,
      sub: 'user_clerk_no_azp',
      sid: 'sess_clerk_no_azp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const missingExpiration = createSignedJwt({
      sub: 'user_clerk_no_exp',
      sid: 'sess_clerk_no_exp',
      exp: undefined,
    }, privateKey)

    vi.stubGlobal('fetch', async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://api.clerk.com/v1/jwks') {
        return createJwksResponse(publicKey)
      }

      return new Response(null, { status: 404 })
    })

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            sessionCookie: '__session',
            authorizedParties: ['https://app.test'],
          },
        },
      }),
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${missingAuthorizedParty}`,
      },
    }))).rejects.toThrow('authorized party')
    await expect(verifySession(missingExpiration)).rejects.toThrow('expiration')
  })

  it('rejects expired, unbound, unsigned, and incorrectly signed Clerk JWTs', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
      apiUrl: 'https://edge-api.clerk.test',
      frontendApi: 'https://edge.clerk.test',
    })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    const signer = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const verifier = generateKeyPairSync('rsa', { modulusLength: 2048 })
    vi.stubGlobal('fetch', async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url.includes('jwks')) {
        return createJwksResponse(signer.publicKey)
      }
      return new Response(JSON.stringify({ id: 'user', email_addresses: [] }), { status: 200 })
    })
    const claims = {
      azp: 'https://app.test',
      sub: 'user',
      sid: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
    await expect(verifySession(createSignedJwt({ ...claims, exp: 1 }, signer.privateKey))).rejects.toThrow('expired')
    await expect(verifySession(createSignedJwt({ ...claims, sub: ' ' }, signer.privateKey))).rejects.toThrow('subject')
    await expect(verifySession(createSignedJwt({ ...claims, sid: undefined }, signer.privateKey))).rejects.toThrow('session id')
    await expect(verifySession(createSignedJwt({ ...claims, sid: ' ', session_id: 'legacy' }, signer.privateKey))).resolves.toMatchObject({
      sessionId: 'legacy',
    })
    await expect(verifySession(createUnsignedJwt(claims))).rejects.toThrow('Unsupported Clerk JWT algorithm')

    await expect(verifySession(createSignedJwt(claims, verifier.privateKey))).rejects.toThrow('signature verification failed')
  })

  it('requires a Clerk secret key and readable built-in user profile', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
      secretKey: '',
      apiUrl: 'https://credentials-api.clerk.test',
      frontendApi: 'https://credentials.clerk.test',
    })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = createSignedJwt({
      sub: 'profile', sid: 'session', exp: Math.floor(Date.now() / 1000) + 3600,
    }, keyPair.privateKey)
    vi.stubGlobal('fetch', async () => createJwksResponse(keyPair.publicKey))
    await expect(verifySession(token)).rejects.toThrow('secretKey')

    resetAuthRuntime()
    configureRuntime({
      configureClerkRuntime: false,
      apiUrl: 'https://profile-api.clerk.test',
      frontendApi: 'https://profile.clerk.test',
    })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    vi.stubGlobal('fetch', async (input: FetchMockInput) => resolveFetchMockUrl(input).includes('jwks')
      ? createJwksResponse(keyPair.publicKey)
      : new Response(null, { status: 503 }))
    await expect(verifySession(token)).rejects.toThrow('Failed to load Clerk user')
  })

  it('uses frontendApi JWKS when apiUrl is not configured', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_clerk_frontend',
      sid: 'sess_clerk_frontend',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const fetchMock = vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://clerk.example.test/.well-known/jwks.json') {
        return new Response(JSON.stringify({
          keys: [
            {
              ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
              kid: 'clerk-test-key',
              use: 'sig',
              alg: 'RS256',
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_frontend') {
        return new Response(JSON.stringify({
          id: 'user_clerk_frontend',
          first_name: 'Frontend',
          last_name: 'API',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            frontendApi: 'https://clerk.example.test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${token}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_frontend',
      user: {
        id: 'user_clerk_frontend',
        firstName: 'Frontend',
        lastName: 'API',
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://clerk.example.test/.well-known/jwks.json',
      expect.any(Object),
    )
  })

  it('refreshes cached Clerk JWKS when a new key id appears', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const firstKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const secondKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const firstToken = createSignedJwt({
      sub: 'user_clerk_rotate_first',
      sid: 'sess_clerk_rotate_first',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, firstKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'clerk-test-key-1',
      typ: 'JWT',
    })
    const secondToken = createSignedJwt({
      sub: 'user_clerk_rotate_second',
      sid: 'sess_clerk_rotate_second',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, secondKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'clerk-test-key-2',
      typ: 'JWT',
    })

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            frontendApi: 'https://rotate.clerk.test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    let jwksRequestCount = 0
    const fetchMock = vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://rotate.clerk.test/.well-known/jwks.json') {
        jwksRequestCount += 1
        const publicKey = (jwksRequestCount === 1 ? firstKeyPair.publicKey : secondKeyPair.publicKey)
          .export({ format: 'jwk' }) as Record<string, unknown>
        return new Response(JSON.stringify({
          keys: [{
            ...publicKey,
            kid: jwksRequestCount === 1 ? 'clerk-test-key-1' : 'clerk-test-key-2',
            use: 'sig',
            alg: 'RS256',
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_rotate_first') {
        return new Response(JSON.stringify({
          id: 'user_clerk_rotate_first',
          first_name: 'Rotate',
          last_name: 'First',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'rotate-first@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_rotate_second') {
        return new Response(JSON.stringify({
          id: 'user_clerk_rotate_second',
          first_name: 'Rotate',
          last_name: 'Second',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'rotate-second@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${firstToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_rotate_first',
      user: {
        id: 'user_clerk_rotate_first',
      },
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${secondToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_rotate_second',
      user: {
        id: 'user_clerk_rotate_second',
      },
    })

    expect(jwksRequestCount).toBe(2)
  })

  it('rebuilds the built-in Clerk verifier when frontendApi changes', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const firstKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const secondKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const firstToken = createSignedJwt({
      sub: 'user_clerk_frontend_first',
      sid: 'sess_clerk_frontend_first',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, firstKeyPair.privateKey)
    const secondToken = createSignedJwt({
      sub: 'user_clerk_frontend_second',
      sid: 'sess_clerk_frontend_second',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, secondKeyPair.privateKey)
    const fetchMock = vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://first.clerk.test/.well-known/jwks.json') {
        return new Response(JSON.stringify({
          keys: [
            {
              ...(firstKeyPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
              kid: 'clerk-test-key',
              use: 'sig',
              alg: 'RS256',
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://second.clerk.test/.well-known/jwks.json') {
        return new Response(JSON.stringify({
          keys: [
            {
              ...(secondKeyPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
              kid: 'clerk-test-key',
              use: 'sig',
              alg: 'RS256',
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_frontend_first') {
        return new Response(JSON.stringify({
          id: 'user_clerk_frontend_first',
          first_name: 'First',
          last_name: 'Frontend',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'first@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_frontend_second') {
        return new Response(JSON.stringify({
          id: 'user_clerk_frontend_second',
          first_name: 'Second',
          last_name: 'Frontend',
          primary_email_address_id: 'email_primary',
          email_addresses: [
            {
              id: 'email_primary',
              email_address: 'second@app.test',
              verification: {
                status: 'verified',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            frontendApi: 'https://first.clerk.test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${firstToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_frontend_first',
      user: {
        id: 'user_clerk_frontend_first',
      },
    })

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            frontendApi: 'https://second.clerk.test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${secondToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_clerk_frontend_second',
      user: {
        id: 'user_clerk_frontend_second',
      },
    })
  })

  it('rejects built-in Clerk JWTs before their not-before time', async () => {
    const runtime = configureRuntime({
      configureClerkRuntime: false,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_clerk_future',
      sid: 'sess_clerk_future',
      nbf: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 7200,
    }, privateKey)
    vi.stubGlobal('fetch', vi.fn(async (input: FetchMockInput) => {
      const url = resolveFetchMockUrl(input)
      if (url === 'https://api.clerk.com/v1/jwks') {
        return createJwksResponse(publicKey)
      }

      if (url === 'https://api.clerk.com/v1/users/user_clerk_future') {
        return new Response(JSON.stringify({
          id: 'user_clerk_future',
          first_name: 'Future',
          last_name: 'User',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    }))

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            sessionCookie: '__session',
          },
        },
      }),
    })

    await expect(verifySession(token)).rejects.toThrow('not valid yet')
  })

  it('verifies Clerk sessions from bearer headers and cookies and fails closed for missing tokens', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('bearer-token', {
      sessionId: 'sess_1',
      user: {
        id: 'user_1',
        email: 'user@app.test',
        emailVerified: true,
        name: 'Bearer User',
      },
    })
    runtime.sessions.set('cookie-token', {
      sessionId: 'sess_2',
      user: {
        id: 'user_2',
        email: 'cookie@app.test',
        emailVerified: true,
        name: 'Cookie User',
      },
    })
    runtime.sessions.set('revoked-token', null)

    await expect(verifySession('bearer-token')).resolves.toMatchObject({
      sessionId: 'sess_1',
      accessToken: 'bearer-token',
      user: {
        id: 'user_1',
      },
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer bearer-token',
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_1',
      accessToken: 'bearer-token',
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        cookie: '__session=cookie-token',
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_2',
      accessToken: 'cookie-token',
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer revoked-token',
      },
    }))).resolves.toBeNull()

    await expect(verifyRequest(new Request('https://app.test/me'))).resolves.toBeNull()
  })

  it('creates a first-time local user from Clerk identity data', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('create-token', {
      sessionId: 'sess_create',
      user: {
        id: 'user_create',
        firstName: 'Create',
        lastName: 'User',
        imageUrl: 'https://cdn.test/avatar.png',
        primaryEmailAddressId: 'email_primary',
        emailAddresses: [
          { id: 'email_primary', emailAddress: 'create@app.test', verificationStatus: 'verified' },
        ],
      },
    })

    const result = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer create-token',
      },
    }))

    expect(result).toMatchObject({
      provider: 'app',
      guard: 'web',
      authProvider: 'users',
      status: 'created',
      session: {
        sessionId: 'sess_create',
        accessToken: 'create-token',
      },
      authSession: {
        guard: 'web',
        sessionId: expect.any(String),
        cookies: [
          expect.stringContaining('holo_session='),
        ],
      },
      user: {
        id: 1,
        email: 'create@app.test',
        name: 'Create User',
      },
    })
    expect(runtime.identityStore.records.get('app:user_create')).toMatchObject({
      userId: 1,
      email: 'create@app.test',
      emailVerified: true,
    })
    const sessionId = authRuntimeInternals.getRuntimeBindings().context.getSessionId('web')
    expect(sessionId).toBeTypeOf('string')
    await expect(result?.user.can('anything', {})).resolves.toBe(false)
  })

  it('returns hosted Account Portal redirects for login and register', async () => {
    configureRuntime()

    const login = await loginWithClerk(new Request('https://app.test/login'))
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('https://accounts.app.test/sign-in?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback')

    const register = await registerWithClerk({
      node: {
        req: {
          method: 'GET',
          url: '/register',
          headers: {
            host: 'app.test',
          },
        },
      },
    })
    expect(register.status).toBe(302)
    expect(register.headers.get('location')).toBe('https://accounts.app.test/sign-up?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback')
  })

  it('derives Account Portal redirects from Clerk frontend API hosts', async () => {
    configureRuntime({
      frontendApi: 'https://steady-newt-5.clerk.accounts.dev',
    })

    const developmentLogin = await loginWithClerk(new Request('https://app.test/login'))
    expect(developmentLogin.headers.get('location')).toBe('https://steady-newt-5.accounts.dev/sign-in?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback')

    configureRuntime({
      frontendApi: 'https://clerk.example.com',
    })

    const productionLogin = await loginWithClerk(new Request('https://app.test/login'))
    expect(productionLogin.headers.get('location')).toBe('https://accounts.example.com/sign-in?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback')
  })

  it('completes the hosted Clerk callback with typed user mapping', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('callback-token', {
      sessionId: 'sess_callback',
      user: {
        id: 'user_callback',
        email: 'callback@app.test',
        emailVerified: true,
        firstName: 'Callback',
        lastName: 'User',
        imageUrl: 'https://cdn.test/callback.png',
      },
    })

    const result = await completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback', {
      headers: {
        cookie: '__session=callback-token',
      },
    }), {
      user: clerkUser => ({
        email: clerkUser.email,
        name: clerkUser.name,
        avatar: clerkUser.imageUrl,
        clerkUserId: clerkUser.id,
      }),
    })

    expect(result).toMatchObject({
      data: {
        provider: 'app',
        guard: 'web',
        authProvider: 'users',
        status: 'created',
        user: {
          email: 'callback@app.test',
          name: 'Callback User',
          avatar: 'https://cdn.test/callback.png',
          clerkUserId: 'user_callback',
        },
        identity: {
          provider: 'app',
          providerUserId: 'user_callback',
          email: 'callback@app.test',
        },
        session: {
          sessionId: 'sess_callback',
          accessToken: 'callback-token',
        },
      },
      error: null,
    })
    await expect(provider()).resolves.toBe('clerk')
    expect(runtime.usersProvider.users.get(1)).toMatchObject({
      email: 'callback@app.test',
      name: 'Callback User',
      avatar: 'https://cdn.test/callback.png',
      clerkUserId: 'user_callback',
    })
  })

  it('redirects Clerk SDK callback handshakes through the auth runtime', async () => {
    const redirectResponses: { url: string, status?: 301 | 302 | 303 | 307 | 308 }[] = []
    configureRuntime({
      configureClerkRuntime: false,
      publishableKey: 'pk_test_mocked',
      redirectResponses,
    })
    configureClerkAuthRuntime({
      identityStore: new InMemoryIdentityStore(),
    })

    const authenticateRequest = vi.fn().mockResolvedValueOnce({
      status: 'handshake',
      headers: new Headers({
        location: 'https://steady-newt-5.clerk.accounts.dev/v1/client/handshake?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback',
      }),
    })
    const createClerkClient = vi.fn(() => ({
      authenticateRequest,
    }))
    vi.doMock('@clerk/backend', () => ({
      createClerkClient,
    }))

    await expect(
      completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback')),
    ).rejects.toThrow('Holo auth response was already handled.')

    expect(authenticateRequest).toHaveBeenCalledTimes(1)
    expect(redirectResponses).toEqual([
      {
        url: 'https://steady-newt-5.clerk.accounts.dev/v1/client/handshake?redirect_url=https%3A%2F%2Fapp.test%2Fapi%2Fauth%2Fclerk%2Fcallback',
        status: 307,
      },
    ])
  })

  it('creates the local user after Clerk SDK resolves the callback handshake', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = createSignedJwt({
      sub: 'user_sdk_callback',
      sid: 'sess_sdk_callback',
      exp: Math.floor(Date.now() / 1000) + 300,
      azp: 'https://app.test',
    }, privateKey)
    const responseCookies: string[] = []
    const runtime = configureRuntime({
      configureClerkRuntime: false,
      publishableKey: 'pk_test_mocked',
      responseCookies,
    })
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const authenticateRequest = vi.fn()
    authenticateRequest.mockImplementationOnce(async () => {
      const headers = new Headers()
      headers.append('Set-Cookie', '__session=sdk-callback-token; Path=/; SameSite=Lax')

      return {
        status: 'signed-in',
        token,
        headers,
      }
    })
    const createClerkClient = vi.fn(() => ({
      authenticateRequest,
    }))
    vi.doMock('@clerk/backend', () => ({
      createClerkClient,
    }))
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl === 'https://accounts.app.test/.well-known/jwks.json') {
        return createJwksResponse(publicKey)
      }

      expect(requestUrl).toBe('https://api.clerk.com/v1/users/user_sdk_callback')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sk_test',
      })

      return new Response(JSON.stringify({
        id: 'user_sdk_callback',
        first_name: 'SDK',
        last_name: 'Callback',
        primary_email_address_id: 'email_sdk_callback',
        email_addresses: [
          {
            id: 'email_sdk_callback',
            email_address: 'sdk-callback@app.test',
            verification: {
              status: 'verified',
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })

    const result = await completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback?__clerk_handshake_nonce=nonce'))

    expect(createClerkClient).toHaveBeenCalledWith({
      apiUrl: undefined,
      publishableKey: 'pk_test_mocked',
      secretKey: 'sk_test',
    })
    expect(authenticateRequest).toHaveBeenCalledTimes(1)
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      apiUrl: undefined,
      authorizedParties: ['https://app.test'],
      publishableKey: 'pk_test_mocked',
      secretKey: 'sk_test',
    })
    const authenticatedRequest = authenticateRequest.mock.calls[0]?.[0]
    expect(authenticatedRequest).toBeInstanceOf(Request)
    if (!(authenticatedRequest instanceof Request)) {
      throw new Error('Expected Clerk SDK to receive a Request after handshake resolution.')
    }
    expect(authenticatedRequest.url).toBe('https://app.test/api/auth/clerk/callback?__clerk_handshake_nonce=nonce')
    expect(result).toMatchObject({
      data: {
        status: 'created',
        user: {
          email: 'sdk-callback@app.test',
          name: 'SDK Callback',
        },
        identity: {
          providerUserId: 'user_sdk_callback',
          email: 'sdk-callback@app.test',
        },
        session: {
          sessionId: 'sess_sdk_callback',
          accessToken: token,
        },
      },
      error: null,
    })
    expect(runtime.usersProvider.users.get(1)).toMatchObject({
      email: 'sdk-callback@app.test',
      name: 'SDK Callback',
    })
    expect(responseCookies).toContain('__session=sdk-callback-token; Path=/; SameSite=Lax')
    expect(responseCookies).toContainEqual(expect.stringContaining('holo_session='))
  })

  it('handles Clerk SDK handshake retries, signed-out states, and missing credentials', async () => {
    const responseCookies: string[] = []
    const runtime = configureRuntime({
      configureClerkRuntime: false,
      publishableKey: 'pk_sdk_edges',
      responseCookies,
    })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    const fallbackHeaders = new Headers({ 'set-cookie': 'first=1; Path=/, second=2; Path=/' })
    Object.defineProperty(fallbackHeaders, 'getSetCookie', { value: undefined })
    const authenticateRequest = vi.fn()
      .mockResolvedValueOnce({
        status: 'handshake',
        headers: new Headers({ location: 'https://accounts.app.test/handshake' }),
      })
      .mockResolvedValueOnce({ status: 'signed-out', headers: fallbackHeaders })
    vi.doMock('@clerk/backend', () => ({
      createClerkClient: () => ({ authenticateRequest }),
    }))

    await expect(verifyRequest(new Request('https://app.test/api/auth/clerk/callback?__clerk_handshake=1'))).resolves.toBeNull()
    await expect(verifyRequest(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toBeNull()
    expect(responseCookies).toEqual(['first=1; Path=/', 'second=2; Path=/'])

    resetAuthRuntime()
    configureRuntime({ configureClerkRuntime: false, publishableKey: 'pk_sdk_no_cookie_sink' })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    authenticateRequest.mockResolvedValueOnce({ status: 'signed-out', headers: new Headers() })
    await expect(verifyRequest(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toBeNull()

    resetAuthRuntime()
    configureRuntime({ configureClerkRuntime: false, publishableKey: '' })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    await expect(verifyRequest(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toBeNull()
  })

  it.each(['', '0'])('treats Clerk redirect-count cookie %j as no completed handshake', async (redirectCount) => {
    const redirects: { url: string, status?: 301 | 302 | 303 | 307 | 308 }[] = []
    const runtime = configureRuntime({
      configureClerkRuntime: false,
      publishableKey: 'pk_redirect_count',
      redirectResponses: redirects,
    })
    configureClerkAuthRuntime({ identityStore: runtime.identityStore })
    vi.doMock('@clerk/backend', () => ({
      createClerkClient: () => ({
        authenticateRequest: async () => ({
          status: 'handshake',
          headers: new Headers({ location: 'https://accounts.app.test/handshake' }),
        }),
      }),
    }))

    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback', {
      headers: { cookie: `__clerk_redirect_count=${redirectCount}` },
    }))).rejects.toThrow('Holo auth response was already handled.')
    expect(redirects).toHaveLength(1)
  })

  it('delegates verification to a configured Clerk request verifier', async () => {
    const runtime = configureRuntime()
    const requestVerifier = vi.fn(async () => null)
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
      providers: { app: { verifyRequest: requestVerifier } },
    })
    await expect(verifyRequest(new Request('https://app.test/me'))).resolves.toBeNull()
    expect(requestVerifier).toHaveBeenCalledOnce()
  })

  it('logs out locally, revokes the Clerk session, and returns a redirect URL', async () => {
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.clerk.com/v1/sessions/sess_logout_callback/revoke')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sk_test',
      })

      return new Response(JSON.stringify({ id: 'sess_logout_callback', status: 'revoked' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })

    const runtime = configureRuntime()
    runtime.sessions.set('logout-callback-token', {
      sessionId: 'sess_logout_callback',
      user: {
        id: 'user_logout_callback',
        email: 'logout-callback@app.test',
        emailVerified: true,
      },
    })

    const callback = await completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback', {
      headers: {
        cookie: '__session=logout-callback-token',
      },
    }))
    expect(callback.error).toBeNull()
    if (!callback.data?.authSession) {
      throw new Error('Expected Clerk callback to establish an auth session.')
    }
    const sessionCookie = callback.data.authSession.cookies[0]?.split(';', 1)[0]

    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    authRuntimeInternals.getRuntimeBindings().context.setCachedUser('web', null)

    const response = await logoutWithClerk(new Request('https://app.test/api/auth/clerk/logout', {
      method: 'POST',
      headers: sessionCookie ? { cookie: sessionCookie } : undefined,
    }), {
      returnTo: '/login',
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.test/login')
    expect(response.headers.get('set-cookie')).toContain('holo_session=;')
  })

  it('fails safely when Clerk session revocation cannot be authorized or completed', async () => {
    const missingSecret = configureRuntime({ secretKey: '' })
    missingSecret.sessions.set('missing-secret-token', {
      sessionId: 'missing-secret-session',
      user: { id: 'missing-secret-user', email: 'missing-secret@app.test', emailVerified: true },
    })
    await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer missing-secret-token' },
    }))
    const unauthorized = await logoutWithClerk(new Request('https://app.test/logout'))
    expect(unauthorized.status).toBe(500)

    resetClerkAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()
    const rejected = configureRuntime()
    rejected.sessions.set('rejected-token', {
      sessionId: 'rejected-session',
      user: { id: 'rejected-user', email: 'rejected@app.test', emailVerified: true },
    })
    await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer rejected-token' },
    }))
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
    const failed = await logoutWithClerk(new Request('https://app.test/logout'))
    expect(failed.status).toBe(500)
  })

  it('normalizes Clerk logout return URLs to relative or same-origin destinations', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'sess_logout_callback', status: 'revoked' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))

    const runtime = configureRuntime()

    async function completeAndLogout(returnTo: string) {
      runtime.sessions.set('logout-callback-token', {
        sessionId: 'sess_logout_callback',
        user: {
          id: 'user_logout_callback',
          email: 'logout-callback@app.test',
          emailVerified: true,
        },
      })

      const callback = await completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback', {
        headers: {
          cookie: '__session=logout-callback-token',
        },
      }))
      expect(callback.error).toBeNull()
      if (!callback.data?.authSession) {
        throw new Error('Expected Clerk callback to establish an auth session.')
      }
      const sessionCookie = callback.data.authSession.cookies[0]?.split(';', 1)[0]

      authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
      authRuntimeInternals.getRuntimeBindings().context.setCachedUser('web', null)

      return logoutWithClerk(new Request('https://app.test/api/auth/clerk/logout', {
        method: 'POST',
        headers: sessionCookie ? { cookie: sessionCookie } : undefined,
      }), {
        returnTo,
      })
    }

    await expect(completeAndLogout('/login').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/login')
    await expect(completeAndLogout('https://app.test/settings').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/settings')
    await expect(completeAndLogout('https://evil.test/phish').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
    await expect(completeAndLogout('//evil.test/phish').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
    await expect(completeAndLogout('').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
    await expect(completeAndLogout('/login\nheader').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
    await expect(completeAndLogout('http://[').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
    await expect(completeAndLogout('login').then(response => response.headers.get('location'))).resolves.toBe('https://app.test/')
  })

  it('returns typed callback failures without combining response behavior', async () => {
    configureRuntime()

    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'clerk_session_required',
        message: 'Clerk callback did not include an active session.',
      },
    })

    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback?error=access_denied&error_description=Denied'))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'access_denied',
        message: 'Denied',
      },
    })
    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback?error=cancelled'))).resolves.toMatchObject({
      data: null,
      error: { code: 'cancelled', message: 'Clerk authentication failed.' },
    })
  })

  it('normalizes non-error callback failures and identity conflicts', async () => {
    const runtime = configureRuntime()
    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
      providers: { app: { verifyRequest: async () => { throw 'network failure' } } },
    })
    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toMatchObject({
      data: null,
      error: { code: 'clerk_auth_failed', message: 'Clerk authentication failed.', status: 422 },
    })

    configureClerkAuthRuntime({
      identityStore: runtime.identityStore,
      providers: {
        app: {
          verifyRequest: async () => ({
            sessionId: 'conflict-session',
            user: clerkAuthInternals.normalizeClerkUserProfile({
              id: 'conflict-user',
              email: 'callback-conflict@app.test',
              emailVerified: true,
            }),
          }),
        },
      },
    })
    await runtime.usersProvider.create({ email: 'callback-conflict@app.test' })
    await expect(completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback'))).resolves.toMatchObject({
      data: null,
      error: { code: 'clerk_identity_conflict', status: 409 },
    })
  })

  it('reuses an existing Holo session when the request already carries the session cookie', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('repeat-token', {
      sessionId: 'sess_repeat',
      user: {
        id: 'user_repeat',
        email: 'repeat@app.test',
        emailVerified: true,
        name: 'Repeat User',
      },
    })

    const first = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer repeat-token',
      },
    }))
    const firstSessionId = first?.authSession?.sessionId
    const holoSessionCookie = first?.authSession?.cookies[0]?.split(';', 1)[0]

    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    authRuntimeInternals.getRuntimeBindings().context.setCachedUser('web', null)

    const second = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer repeat-token',
        ...(holoSessionCookie ? { cookie: holoSessionCookie } : {}),
      },
    }))

    expect(firstSessionId).toBeTypeOf('string')
    expect(second?.authSession).toMatchObject({
      guard: 'web',
      sessionId: firstSessionId,
      cookies: [],
    })
    expect(runtime.sessionStore.records.size).toBe(1)
    expect(firstSessionId ? runtime.sessionStore.records.has(firstSessionId) : false).toBe(true)
  })

  it('does not reuse Holo sessions with mismatched auth or Clerk identities', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('mismatch-token', {
      sessionId: 'clerk-session',
      user: { id: 'mismatch-user', email: 'mismatch@app.test', emailVerified: true },
    })
    const first = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token' },
    }))
    const firstId = first?.authSession?.sessionId
    const firstCookie = first?.authSession?.cookies[0]?.split(';', 1)[0]
    const firstRecord = firstId ? runtime.sessionStore.records.get(firstId) : undefined
    if (!firstId || !firstCookie || !firstRecord) throw new Error('Expected initial Holo session.')
    const firstPayload = firstRecord.data.auth as Record<string, unknown>
    runtime.sessionStore.records.set(firstId, { ...firstRecord, data: { auth: { ...firstPayload, provider: 'admins' } } })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const second = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: firstCookie },
    }))
    expect(second?.authSession?.sessionId).not.toBe(firstId)

    const secondId = second?.authSession?.sessionId
    const secondCookie = second?.authSession?.cookies[0]?.split(';', 1)[0]
    const secondRecord = secondId ? runtime.sessionStore.records.get(secondId) : undefined
    if (!secondId || !secondCookie || !secondRecord) throw new Error('Expected replacement Holo session.')
    const secondPayload = secondRecord.data.auth as Record<string, unknown>
    runtime.sessionStore.records.set(secondId, {
      ...secondRecord,
      data: { auth: { ...secondPayload, clerk: { provider: 'other', sessionId: 'clerk-session' } } },
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const third = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: secondCookie },
    }))
    expect(third?.authSession?.sessionId).not.toBe(secondId)

    const thirdId = third?.authSession?.sessionId
    const thirdCookie = third?.authSession?.cookies[0]?.split(';', 1)[0]
    const thirdRecord = thirdId ? runtime.sessionStore.records.get(thirdId) : undefined
    if (!thirdId || !thirdCookie || !thirdRecord) throw new Error('Expected second replacement Holo session.')
    const { clerk: _clerk, ...standardPayload } = thirdRecord.data.auth as Record<string, unknown>
    runtime.sessionStore.records.set(thirdId, { ...thirdRecord, data: { auth: standardPayload } })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const fourth = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: thirdCookie },
    }))
    expect(fourth?.authSession).toMatchObject({ sessionId: thirdId, provider: 'users', cookies: [] })
  })

  it('clears the Clerk hosted session cookie through the shared logout api', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('logout-token', {
      sessionId: 'sess_logout',
      user: {
        id: 'user_logout',
        email: 'logout@app.test',
        emailVerified: true,
        name: 'Logout User',
      },
    })

    await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer logout-token',
      },
    }))

    const loggedOut = await logout()

    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('holo_session=;'))
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('__session=;'))
  })

  it.each([
    [undefined],
    [null],
    ['invalid'],
    [{ provider: 'other', sessionId: 'session' }],
    [{ provider: 'app', sessionId: ' ' }],
  ] as const)('ignores malformed Clerk logout metadata %#', async (clerk) => {
    const runtime = configureRuntime()
    const now = new Date()
    runtime.sessionStore.records.set('malformed-session', {
      id: 'malformed-session',
      store: 'database',
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          userId: 1,
          user: { id: 1 },
          ...(typeof clerk === 'undefined' ? {} : { clerk }),
        },
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web', 'malformed-session')
    const response = await logoutWithClerk(new Request('https://app.test/logout'))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.test/')
  })

  it('updates existing linked users on subsequent Clerk syncs and relinks missing local rows', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('first-token', {
      sessionId: 'sess_first',
      user: {
        id: 'user_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'First Name',
        imageUrl: 'https://cdn.test/first.png',
      },
    })

    const first = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer first-token',
      },
    }))
    expect(first?.status).toBe('created')

    runtime.sessions.set('update-token', {
      sessionId: 'sess_update',
      user: {
        id: 'user_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'Updated Name',
        imageUrl: 'https://cdn.test/updated.png',
      },
    })

    const updated = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer update-token',
      },
    }))
    expect(updated).toMatchObject({
      status: 'updated',
      user: {
        id: 1,
        name: 'Updated Name',
        avatar: 'https://cdn.test/updated.png',
        avatarUrl: 'https://cdn.test/updated.png',
      },
    })

    runtime.usersProvider.users.delete(1)
    runtime.usersProvider.usersByEmail.delete('sync@app.test')
    await runtime.usersProvider.create({
      name: 'Relink Target',
      email: 'sync@app.test',
      password: null,
      email_verified_at: new Date(),
    })

    runtime.sessions.set('relink-token', {
      sessionId: 'sess_relink',
      user: {
        id: 'user_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'Relinked User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer relink-token',
      },
    }))).rejects.toBeInstanceOf(ClerkAuthConflictError)
  })

  it('relinks an orphaned Clerk identity without an email match', async () => {
    const runtime = configureRuntime()
    await runtime.identityStore.save({
      provider: 'app',
      providerUserId: 'orphan',
      guard: 'web',
      authProvider: 'users',
      userId: 404,
      email: undefined,
      emailVerified: false,
      profile: {},
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    const result = await syncIdentity({
      sessionId: 'orphan-session',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'orphan' }),
    }, 'app')
    expect(result).toMatchObject({
      status: 'relinked',
      user: { id: 1, email: 'orphan@clerk.hosted.local' },
      identity: { userId: 1 },
    })
    expect(result.identity.linkedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('updates a linked Clerk identity with no conflicting email', async () => {
    const runtime = configureRuntime()
    const user = await runtime.usersProvider.create({ email: 'linked@app.test', name: 'Linked User' })
    await runtime.identityStore.save({
      provider: 'app',
      providerUserId: 'linked-user',
      guard: 'web',
      authProvider: 'users',
      userId: user.id,
      email: undefined,
      emailVerified: false,
      profile: {},
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await expect(syncIdentity({
      sessionId: 'linked-no-email',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'linked-user' }),
    }, 'app')).resolves.toMatchObject({ user: { id: user.id } })
    await expect(syncIdentity({
      sessionId: 'linked-unique-email',
      user: clerkAuthInternals.normalizeClerkUserProfile({
        id: 'linked-user',
        email: 'unique-linked@app.test',
        emailVerified: true,
      }),
    }, 'app')).resolves.toMatchObject({ status: 'updated' })
  })

  it('claims a Clerk identity once under concurrent first syncs', async () => {
    const runtime = configureRuntime()
    const originalCreate = runtime.usersProvider.create.bind(runtime.usersProvider)
    let createCalls = 0

    vi.spyOn(runtime.usersProvider, 'create').mockImplementation(async (input) => {
      createCalls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return await originalCreate(input)
    })

    const session = {
      sessionId: 'sess_concurrent',
      user: clerkAuthInternals.normalizeClerkUserProfile({
        id: 'user_concurrent',
        email: 'concurrent@app.test',
        emailVerified: true,
        name: 'Concurrent User',
      }),
      accessToken: 'token-concurrent',
    }

    const [first, second] = await Promise.all([
      syncIdentity(session, 'app'),
      syncIdentity(session, 'app'),
    ])

    expect(createCalls).toBe(1)
    expect(runtime.usersProvider.users.size).toBe(1)
    expect(first.identity.userId).toBe(second.identity.userId)
    expect(first.user.id).toBe(second.user.id)
    expect(runtime.identityStore.records.get('app:user_concurrent')).toMatchObject({
      userId: first.user.id,
      email: 'concurrent@app.test',
    })
  })

  it('saves a new Clerk identity when the identity store has no atomic claim operation', async () => {
    const runtime = configureRuntime()
    const bindings = clerkAuthInternals.getBindings()
    configureClerkAuthRuntime({
      providers: bindings.providers,
      identityStore: {
        findByProviderUserId: runtime.identityStore.findByProviderUserId.bind(runtime.identityStore),
        findByUserId: runtime.identityStore.findByUserId.bind(runtime.identityStore),
        save: runtime.identityStore.save.bind(runtime.identityStore),
      },
    })

    const result = await syncIdentity({
      sessionId: 'save-only-session',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'save-only' }),
    }, 'app')

    expect(result.status).toBe('created')
    expect(runtime.identityStore.records.has('app:save-only')).toBe(true)
  })

  it('uses the identity-store claim winner and deletes the losing local user', async () => {
    const runtime = configureRuntime()
    runtime.usersProvider.users.set(99, {
      id: 99,
      email: 'winner@app.test',
      name: 'Claim Winner',
      role: 'member',
    })
    runtime.usersProvider.usersByEmail.set('winner@app.test', 99)
    const bindings = clerkAuthInternals.getBindings()
    configureClerkAuthRuntime({
      providers: bindings.providers,
      identityStore: {
        findByProviderUserId: async () => null,
        findByUserId: async () => null,
        save: async () => {},
        claim: async record => ({ ...record, userId: 99 }),
      },
    })

    const result = await syncIdentity({
      sessionId: 'claim-winner-session',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'claim-winner' }),
    }, 'app')

    expect(result).toMatchObject({ status: 'linked', user: { id: 99 } })
    expect(runtime.usersProvider.users.has(1)).toBe(false)

    const authBindings = authRuntimeInternals.getRuntimeBindings()
    const providerWithoutDelete: AuthProviderAdapter<UserRecord> = {
      findById: runtime.usersProvider.findById.bind(runtime.usersProvider),
      findByCredentials: runtime.usersProvider.findByCredentials.bind(runtime.usersProvider),
      create: runtime.usersProvider.create.bind(runtime.usersProvider),
      update: runtime.usersProvider.update.bind(runtime.usersProvider),
      getId: runtime.usersProvider.getId.bind(runtime.usersProvider),
      serialize: runtime.usersProvider.serialize.bind(runtime.usersProvider),
    }
    configureAuthRuntime({ ...authBindings, providers: { users: providerWithoutDelete } })
    await syncIdentity({
      sessionId: 'claim-winner-no-delete-session',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'claim-winner-no-delete' }),
    }, 'app')
    expect(runtime.usersProvider.users.has(2)).toBe(true)
  })

  it('fails when Clerk sync needs to persist changes without adapter.update()', async () => {
    const sessionStore = new InMemorySessionStore()
    const usersProvider = new SnapshotProviderAdapter()
    const adminsProvider = new InMemoryProviderAdapter()
    const identityStore = new InMemoryIdentityStore()

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

    configureAuthRuntime({
      config: defineAuthConfig({
        defaults: {
          guard: 'web',
          passwords: 'users',
        },
        guards: {
          web: { driver: 'session', provider: 'users' },
          admin: { driver: 'session', provider: 'admins' },
        },
        providers: {
          users: { model: 'User' },
          admins: { model: 'Admin' },
        },
        clerk: {
          app: {
            publishableKey: 'pk_test',
            secretKey: 'sk_test',
            sessionCookie: '__session',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: usersProvider,
        admins: adminsProvider,
      },
      context: authRuntimeInternals.createMemoryAuthContext(),
    })
    configureClerkAuthRuntime({
      identityStore,
    })

    const linkedUser = await usersProvider.create({
      name: 'First Name',
      email: 'sync@app.test',
      password: null,
      avatar: null,
      email_verified_at: null,
    })
    await identityStore.save({
      provider: 'app',
      providerUserId: 'user_sync',
      guard: 'web',
      authProvider: 'users',
      userId: linkedUser.id,
      email: 'sync@app.test',
      emailVerified: false,
      profile: {},
      linkedAt: new Date('2026-04-08T00:00:00.000Z'),
      updatedAt: new Date('2026-04-08T00:00:00.000Z'),
    })

    await expect(syncIdentity({
      sessionId: 'sess_update',
      user: {
        id: 'user_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'Updated Name',
        imageUrl: 'https://cdn.test/updated.png',
      },
    }, 'app')).rejects.toThrow('must implement update()')
    expect(usersProvider.users.get(1)).toMatchObject({
      name: 'First Name',
      avatar: null,
      email_verified_at: null,
    })
  })

  it('raises a soft conflict when Clerk email collides with unexpected local data', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('initial-link', {
      sessionId: 'sess_initial',
      user: {
        id: 'user_conflict',
        email: 'linked@app.test',
        emailVerified: true,
        name: 'Linked User',
      },
    })

    await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer initial-link',
      },
    }))

    await runtime.usersProvider.create({
      name: 'Unexpected User',
      email: 'other@app.test',
      password: null,
      email_verified_at: new Date(),
    })

    runtime.sessions.set('conflict-token', {
      sessionId: 'sess_conflict',
      user: {
        id: 'user_conflict',
        email: 'other@app.test',
        emailVerified: true,
        name: 'Linked User',
      },
    })

    const error = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer conflict-token',
      },
    })).then(
      () => null,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ClerkAuthConflictError)
    expect(error).toMatchObject({
      provider: 'app',
    })
  })

  it('supports Clerk auth against a non-default guard and provider model', async () => {
    const runtime = configureRuntime({
      clerkGuard: 'admin',
    })
    runtime.sessions.set('admin-token', {
      sessionId: 'sess_admin',
      user: {
        id: 'user_admin',
        email: 'admin@app.test',
        emailVerified: true,
        name: 'Admin User',
      },
    })

    const result = await authenticate(new Request('https://app.test/admin/me', {
      headers: {
        authorization: 'Bearer admin-token',
      },
    }))

    expect(result).toMatchObject({
      guard: 'admin',
      authProvider: 'admins',
      status: 'created',
      user: {
        id: 1,
        email: 'admin@app.test',
      },
    })
    expect((result?.user as Record<PropertyKey, unknown> | undefined)?.[AUTH_PROVIDER_MARKER]).toBe('admins')
    expect(runtime.adminsProvider.users.get(1)?.email).toBe('admin@app.test')
    expect(runtime.usersProvider.users.size).toBe(0)
    const sessionId = authRuntimeInternals.getRuntimeBindings().context.getSessionId('admin')
    expect(sessionId).toBeTypeOf('string')
  })

  it('rejects Clerk providers mapped to token guards', async () => {
    const runtime = configureRuntime({
      clerkGuard: 'api',
    })
    runtime.sessions.set('api-token', {
      sessionId: 'sess_api',
      user: {
        id: 'user_api',
        primaryEmailAddressId: 'email_primary',
        emailAddresses: [
          { id: 'email_primary', emailAddress: 'api@app.test', verificationStatus: 'verified' },
        ],
        name: 'API User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer api-token',
      },
    }))).rejects.toThrow('requires auth guard "api" to use the session driver')
  })

  it('blocks unverified Clerk identities when local verification is required', async () => {
    const runtime = configureRuntime({
      emailVerificationRequired: true,
    })
    runtime.sessions.set('unverified-token', {
      sessionId: 'sess_unverified',
      user: {
        id: 'user_unverified',
        primaryEmailAddressId: 'email_primary',
        emailAddresses: [
          { id: 'email_primary', emailAddress: 'user@app.test', verificationStatus: 'unverified' },
        ],
        name: 'Pending User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer unverified-token',
      },
    }))).rejects.toThrow('must provide a verified email address')
  })

  it('fails closed when the Clerk runtime or config entry is missing', async () => {
    configureRuntime({
      configureClerkRuntime: false,
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer token',
      },
    }))).rejects.toThrow('Clerk auth runtime is not configured yet')
    const logoutResult = await logoutWithClerk(new Request('https://app.test/api/auth/clerk/logout', {
      method: 'POST',
    }))
    expect(logoutResult.status).toBe(303)
    expect(logoutResult.headers.get('location')).toBe('https://app.test/')

    resetClerkAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()

    configureRuntime({
      includeClerkConfig: false,
    })

    await expect(verifySession('token')).rejects.toThrow('is not configured in auth.clerk')
    const failedLogout = await logoutWithClerk(new Request('https://app.test/api/auth/clerk/logout', {
      method: 'POST',
    }))
    await expect(failedLogout.json()).resolves.toEqual({
      data: null,
      error: {
        code: 'clerk_logout_failed',
        message: 'Unable to complete Clerk logout.',
        status: 500,
        fields: {
          _root: ['Unable to complete Clerk logout.'],
        },
      },
    })
    expect(failedLogout.status).toBe(500)
  })

  it('normalizes Clerk profile and email variants', () => {
    const camel = clerkAuthInternals.normalizeClerkUserProfile({
      id: 'camel',
      firstName: 'Ada',
      lastName: 'Lovelace',
      imageUrl: 'https://cdn.test/camel.png',
      primaryEmailAddressId: 'primary',
      emailAddresses: [
        { id: 'primary', emailAddress: 'ada@app.test', verificationStatus: 'verified' },
      ],
    })
    expect(camel).toMatchObject({
      email: 'ada@app.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      imageUrl: 'https://cdn.test/camel.png',
    })

    const snake = clerkAuthInternals.normalizeClerkUserProfile({
      id: 'snake',
      name: 'Snake User',
      first_name: 'Snake',
      last_name: 'User',
      image_url: 'https://cdn.test/snake.png',
      primary_email_address_id: 'snake-primary',
      email_addresses: [
        {
          id: 'snake-primary',
          email_address: 'snake@app.test',
          verification: { status: 'verified' },
        },
      ],
    })
    expect(snake).toMatchObject({
      email: 'snake@app.test',
      emailVerified: true,
      name: 'Snake User',
      imageUrl: 'https://cdn.test/snake.png',
    })
    expect(clerkAuthInternals.resolvePrimaryEmail({
      id: 'fallback',
      email: '',
      emailVerified: false,
      name: '',
      emailAddresses: [{ emailAddress: 'fallback@app.test', verificationStatus: 'verified' }],
      raw: {},
    })).toEqual({ email: 'fallback@app.test', emailVerified: true })
    expect(clerkAuthInternals.resolvePrimaryEmail({
      id: 'missing', email: '', emailVerified: false, name: '', emailAddresses: [], raw: {},
    })).toEqual({ email: undefined, emailVerified: false })
    expect(clerkAuthInternals.resolveEmailForCreation({
      id: 'missing', email: '', emailVerified: false, name: '', emailAddresses: [], raw: {},
    })).toBe('missing@clerk.hosted.local')
    expect(clerkAuthInternals.resolveDisplayName({
      id: 'display-id', email: '', emailVerified: false, name: '', raw: {},
    })).toBe('display-id')
    expect(clerkAuthInternals.normalizeClerkUserProfile({
      emailAddresses: [{}],
    })).toMatchObject({ id: '', email: '', name: '' })
    expect(clerkAuthInternals.getSessionTokenFromRequest(new Request('https://app.test', {
      headers: { authorization: 'Basic token', cookie: '__session=cookie-token' },
    }), '__session')).toBe('cookie-token')
  })

  it.each([
    ['frontendApi', { frontendApi: '' }, 'frontendApi'],
    ['redirectUri', { redirectUri: '' }, 'redirectUri'],
  ] as const)('returns a safe hosted redirect error when %s is missing', async (_field, options, message) => {
    configureRuntime(options)
    const response = await loginWithClerk(new Request('https://app.test/login'))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      code: 'clerk_login_failed',
      message: expect.stringContaining(message),
      ok: false,
    })
    const registerResponse = await registerWithClerk(new Request('https://app.test/register'))
    expect(registerResponse.status).toBe(422)
    await expect(registerResponse.json()).resolves.toMatchObject({ code: 'clerk_register_failed' })
  })

  it('can explicitly clear Clerk runtime bindings', () => {
    configureRuntime()
    configureClerkAuthRuntime()
    expect(() => clerkAuthInternals.getBindings()).toThrow('not configured yet')
  })

  it('stores Clerk runtime state on globalThis when process is unavailable', () => {
    vi.stubGlobal('process', undefined)
    configureClerkAuthRuntime()
    expect(Object.getOwnPropertyDescriptor(globalThis, '__holoJsAuthClerkRuntime')).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    })
    delete (globalThis as typeof globalThis & { __holoJsAuthClerkRuntime?: unknown }).__holoJsAuthClerkRuntime
    vi.unstubAllGlobals()
  })

  it('fails closed for missing provider capabilities and adapters', async () => {
    const runtime = configureRuntime()
    configureClerkAuthRuntime({ providers: { app: {} }, identityStore: runtime.identityStore })
    await expect(verifySession('token')).rejects.toThrow('does not implement verifySession()')
    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer token' },
    }))).rejects.toThrow('does not implement verifySession()')

    const bindings = authRuntimeInternals.getRuntimeBindings()
    configureAuthRuntime({ ...bindings, providers: {} })
    expect(() => clerkAuthInternals.resolveGuardAndProvider('app')).toThrow('runtime "users" is not configured')
  })

  it('resolves multiple configured Clerk providers deterministically', () => {
    const runtime = configureRuntime()
    const bindings = authRuntimeInternals.getRuntimeBindings()
    configureAuthRuntime({
      ...bindings,
      config: defineAuthConfig({
        ...bindings.config,
        clerk: {
          identityStore: runtime.identityStore,
          alpha: { secretKey: 'alpha' },
          beta: { secretKey: 'beta' },
        },
      }),
    })
    expect(() => clerkAuthInternals.resolveConfiguredProviderName()).toThrow('provider name is required')
    configureAuthRuntime({
      ...bindings,
      config: defineAuthConfig({
        ...bindings.config,
        clerk: {
          default: { secretKey: 'default' },
          beta: { secretKey: 'beta' },
        },
      }),
    })
    expect(clerkAuthInternals.resolveConfiguredProviderName()).toBe('default')
  })

  it('rejects malformed users returned by Clerk provider boundaries', async () => {
    const runtime = configureRuntime()
    const bindings = authRuntimeInternals.getRuntimeBindings()
    const malformedCreate: AuthProviderAdapter<UserRecord> = {
      findById: async () => null,
      findByCredentials: async () => null,
      create: async () => null as never,
      getId: user => user.id,
      serialize: user => user,
    }
    configureAuthRuntime({ ...bindings, providers: { users: malformedCreate } })
    await expect(syncIdentity({
      sessionId: 'malformed-create',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'malformed-create' }),
    }, 'app')).rejects.toThrow('create() must return an object user')

    const invalidId: AuthProviderAdapter<UserRecord> = {
      findById: async () => null,
      findByCredentials: async () => null,
      create: async input => ({ id: 1, email: String(input.email), name: 'Invalid Id', role: 'member' }),
      getId: () => ({}) as never,
      serialize: user => user,
    }
    configureAuthRuntime({ ...bindings, providers: { users: invalidId } })
    await expect(syncIdentity({
      sessionId: 'invalid-id',
      user: clerkAuthInternals.normalizeClerkUserProfile({ id: 'invalid-id' }),
    }, 'app')).rejects.toThrow('must expose a serializable id')
    expect(runtime.identityStore.records.size).toBe(0)
  })

  it('serializes Clerk users when an auth adapter has no serializer', async () => {
    const runtime = configureRuntime()
    const bindings = authRuntimeInternals.getRuntimeBindings()
    const providerWithoutSerializer = {
      findById: runtime.usersProvider.findById.bind(runtime.usersProvider),
      findByCredentials: runtime.usersProvider.findByCredentials.bind(runtime.usersProvider),
      create: runtime.usersProvider.create.bind(runtime.usersProvider),
      update: runtime.usersProvider.update.bind(runtime.usersProvider),
      getId: runtime.usersProvider.getId.bind(runtime.usersProvider),
    } as unknown as AuthProviderAdapter
    configureAuthRuntime({ ...bindings, providers: { users: providerWithoutSerializer } })
    const result = await syncIdentity({
      sessionId: 'no-serializer',
      user: clerkAuthInternals.normalizeClerkUserProfile({
        id: 'no-serializer',
        email_addresses: [{ email_address: 'no-serializer@app.test', verification: { status: 'verified' } }],
      }),
    }, 'app')
    expect(result.user).toMatchObject({ id: 1, email: 'no-serializer@app.test' })
  })

  it('returns null authentication when the configured Clerk verifier rejects a token', async () => {
    configureRuntime()
    await expect(authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer missing-token' },
    }))).resolves.toBeNull()
  })

  it('does not reuse a session when the session runtime emits no cookie name', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('cookie-name-token', {
      sessionId: 'cookie-name-session',
      user: { id: 'cookie-name-user', email: 'cookie-name@app.test', emailVerified: true },
    })
    const bindings = authRuntimeInternals.getRuntimeBindings()
    configureAuthRuntime({
      ...bindings,
      session: { ...bindings.session, sessionCookie: () => '' },
    })
    await expect(authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer cookie-name-token', cookie: 'holo_session=stale' },
    }))).resolves.toMatchObject({ authSession: { sessionId: expect.any(String) } })
  })

  it('rejects an unlinked Clerk identity that collides with a local email', async () => {
    const runtime = configureRuntime()
    await runtime.usersProvider.create({ email: 'new-collision@app.test' })
    await expect(syncIdentity({
      sessionId: 'new-collision',
      user: clerkAuthInternals.normalizeClerkUserProfile({
        id: 'new-collision',
        email_addresses: [{
          id: 'primary',
          email_address: 'new-collision@app.test',
          verification: { status: 'verified' },
        }],
        primary_email_address_id: 'primary',
      }),
    }, 'app')).rejects.toBeInstanceOf(ClerkAuthConflictError)
  })
})
