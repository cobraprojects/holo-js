import { generateKeyPairSync, sign as signData } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, resetAuthRuntime } from '../../auth/src'
import type { AuthProviderAdapter } from '../../auth/src'
import {
  ClerkAuthConflictError,
  authenticate,
  clerkAuth,
  clerkAuthInternals,
  configureClerkAuthRuntime,
  resetClerkAuthRuntime,
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
  name?: string
  email: string
  password?: string | null
  avatar?: string | null
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

  async update(user: UserRecord, input: {
    readonly name?: string
    readonly email?: string
    readonly avatar?: string | null
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
      avatar: user.avatar ?? null,
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
      name: input.name,
      email: input.email,
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
      avatar: user.avatar ?? null,
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
}

function configureRuntime(options: {
  emailVerificationRequired?: boolean
  clerkGuard?: 'web' | 'admin' | 'api'
  includeClerkConfig?: boolean
  configureClerkRuntime?: boolean
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
            app: {
              publishableKey: 'pk_test',
              secretKey: 'sk_test',
              jwtKey: 'jwt-key',
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
    context: authRuntimeInternals.createMemoryAuthContext(),
  })

  const identityStore = new InMemoryIdentityStore()
  const sessions = new Map<string, ClerkSessionFixture | null>()

  if (options.configureClerkRuntime !== false) {
    configureClerkAuthRuntime({
      providers: {
        app: {
          async verifySession({ token }) {
            return sessions.get(token) ?? null
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
  const encodedPayload = encodeBase64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signData('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

describe('@holo-js/auth-clerk', () => {
  it('exports the Clerk auth facade and helpers', () => {
    expect(clerkAuth.authenticate).toBe(authenticate)
    expect(clerkAuth.verifyRequest).toBe(verifyRequest)
    expect(clerkAuth.verifySession).toBe(verifySession)
    expect(typeof clerkAuthInternals.resolveEmailForCreation).toBe('function')
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
            jwtKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
            jwtKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
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

  it('uses frontendApi JWKS when jwtKey and apiUrl are not configured', async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
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
            jwtKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
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
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        cookie: '__session=cookie-token',
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_2',
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

  it('updates existing linked users on subsequent Clerk syncs and relinks missing local rows', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('first-token', {
      sessionId: 'sess_first',
      user: {
        id: 'user_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'First Name',
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
      },
    })

    runtime.usersProvider.users.delete(1)
    runtime.usersProvider.usersByEmail.delete('sync@app.test')
    const relinkTarget = await runtime.usersProvider.create({
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

    const relinked = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer relink-token',
      },
    }))
    expect(relinked).toMatchObject({
      status: 'relinked',
      user: {
        id: relinkTarget.id,
        name: 'Relinked User',
      },
    })
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
            jwtKey: 'jwt-key',
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

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer conflict-token',
      },
    }))).rejects.toBeInstanceOf(ClerkAuthConflictError)
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

    resetClerkAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()

    configureRuntime({
      includeClerkConfig: false,
    })

    await expect(verifySession('token')).rejects.toThrow('is not configured in auth.clerk')
  })
})
