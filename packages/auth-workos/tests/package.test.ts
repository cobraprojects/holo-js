import { generateKeyPairSync, sign as signData } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, resetAuthRuntime } from '../../auth/src'
import type { AuthProviderAdapter } from '../../auth/src'
import {
  WorkosAuthConflictError,
  authenticate,
  configureWorkosAuthRuntime,
  resetWorkosAuthRuntime,
  syncIdentity,
  verifyRequest,
  verifySession,
  workosAuth,
  workosAuthInternals,
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

type WorkosSessionFixture = {
  readonly sessionId: string
  readonly identity: {
    readonly id: string
    readonly email?: string
    readonly emailVerified?: boolean
    readonly firstName?: string
    readonly lastName?: string
    readonly name?: string
    readonly avatar?: string
    readonly organizationId?: string
    readonly raw?: unknown
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
  workosGuard?: 'web' | 'admin' | 'api'
  includeWorkosConfig?: boolean
  configureWorkosRuntime?: boolean
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
      workos: options.includeWorkosConfig === false
        ? undefined
        : {
            dashboard: {
              clientId: 'workos-client',
              apiKey: 'workos-key',
              cookiePassword: 'cookie-secret',
              sessionCookie: 'workos-session',
              guard: options.workosGuard,
              mapToProvider: options.workosGuard === 'admin' ? 'admins' : undefined,
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
  const sessions = new Map<string, WorkosSessionFixture | null>()

  if (options.configureWorkosRuntime !== false) {
    configureWorkosAuthRuntime({
      providers: {
        dashboard: {
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
  resetWorkosAuthRuntime()
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
    kid: 'workos-test-key',
    typ: 'JWT',
  },
): string {
  const encodedHeader = encodeBase64Url(JSON.stringify(header))
  const encodedPayload = encodeBase64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signData('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

describe('@holo-js/auth-workos', () => {
  it('exports the WorkOS auth facade and helpers', () => {
    expect(workosAuth.authenticate).toBe(authenticate)
    expect(workosAuth.verifyRequest).toBe(verifyRequest)
    expect(workosAuth.verifySession).toBe(verifySession)
    expect(typeof workosAuthInternals.resolveEmailForCreation).toBe('function')
  })

  it('merges partial runtime configuration updates', () => {
    const identityStore = new InMemoryIdentityStore()
    const providers = Object.freeze({
      dashboard: {
        async verifySession() {
          return null
        },
      },
    })

    configureWorkosAuthRuntime({
      identityStore,
    })
    expect(workosAuthInternals.getBindings()).toEqual({
      providers: {},
      identityStore,
    })

    configureWorkosAuthRuntime({
      providers,
    })

    expect(workosAuthInternals.getBindings()).toEqual({
      providers,
      identityStore,
    })
  })

  it('uses the built-in verifier when only the identity store is configured', async () => {
    const runtime = configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_workos_1',
      sid: 'sess_workos_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const publicJwk = publicKey.export({ format: 'jwk' })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.workos.com/sso/jwks/workos-client') {
        return new Response(JSON.stringify({
          keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.workos.com/user_management/users/user_workos_1') {
        return new Response(JSON.stringify({
          id: 'user_workos_1',
          email: 'workos@app.test',
          email_verified: true,
          first_name: 'WorkOS',
          last_name: 'User',
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
        authorization: `Bearer ${token}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_workos_1',
      accessToken: token,
      identity: {
        id: 'user_workos_1',
        email: 'workos@app.test',
        emailVerified: true,
        name: 'WorkOS User',
      },
    })
  })

  it('rejects built-in WorkOS JWTs before their not-before time', async () => {
    const runtime = configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_workos_future',
      sid: 'sess_workos_future',
      nbf: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 7200,
    }, privateKey)
    const publicJwk = publicKey.export({ format: 'jwk' })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.workos.com/sso/jwks/workos-client-future') {
        return new Response(JSON.stringify({
          keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.workos.com/user_management/users/user_workos_future') {
        return new Response(JSON.stringify({
          id: 'user_workos_future',
          email: 'future@app.test',
          email_verified: true,
          first_name: 'Future',
          last_name: 'User',
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
        workos: {
          dashboard: {
            clientId: 'workos-client-future',
            apiKey: 'workos-key',
            cookiePassword: 'cookie-secret',
            sessionCookie: 'workos-session',
          },
        },
      }),
    })

    await expect(verifySession(token)).rejects.toThrow('not valid yet')
  })

  it('refreshes cached WorkOS JWKS when a new key id appears', async () => {
    const runtime = configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const firstKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const secondKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const firstToken = createSignedJwt({
      sub: 'user_workos_rotate_first',
      sid: 'sess_workos_rotate_first',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, firstKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'workos-test-key-1',
      typ: 'JWT',
    })
    const secondToken = createSignedJwt({
      sub: 'user_workos_rotate_second',
      sid: 'sess_workos_rotate_second',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, secondKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'workos-test-key-2',
      typ: 'JWT',
    })

    configureAuthRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        workos: {
          dashboard: {
            clientId: 'workos-client-rotate',
            apiKey: 'workos-key',
            cookiePassword: 'cookie-secret',
            sessionCookie: 'workos-session',
          },
        },
      }),
    })

    let jwksRequestCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.workos.com/sso/jwks/workos-client-rotate') {
        jwksRequestCount += 1
        const publicKey = (jwksRequestCount === 1 ? firstKeyPair.publicKey : secondKeyPair.publicKey)
          .export({ format: 'jwk' }) as Record<string, unknown>
        return new Response(JSON.stringify({
          keys: [{
            ...publicKey,
            kid: jwksRequestCount === 1 ? 'workos-test-key-1' : 'workos-test-key-2',
            alg: 'RS256',
            use: 'sig',
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.workos.com/user_management/users/user_workos_rotate_first') {
        return new Response(JSON.stringify({
          id: 'user_workos_rotate_first',
          email: 'rotate-first@app.test',
          email_verified: true,
          first_name: 'Rotate',
          last_name: 'First',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.workos.com/user_management/users/user_workos_rotate_second') {
        return new Response(JSON.stringify({
          id: 'user_workos_rotate_second',
          email: 'rotate-second@app.test',
          email_verified: true,
          first_name: 'Rotate',
          last_name: 'Second',
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
      sessionId: 'sess_workos_rotate_first',
      identity: {
        id: 'user_workos_rotate_first',
      },
    })

    await expect(verifyRequest(new Request('https://app.test/me', {
      headers: {
        authorization: `Bearer ${secondToken}`,
      },
    }))).resolves.toMatchObject({
      sessionId: 'sess_workos_rotate_second',
      identity: {
        id: 'user_workos_rotate_second',
      },
    })

    expect(jwksRequestCount).toBe(2)
  })

  it('verifies WorkOS sessions from bearer headers and cookies and fails closed for missing tokens', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('bearer-token', {
      sessionId: 'sess_1',
      identity: {
        id: 'workos_1',
        email: 'user@app.test',
        emailVerified: true,
        name: 'Bearer User',
      },
    })
    runtime.sessions.set('cookie-token', {
      sessionId: 'sess_2',
      identity: {
        id: 'workos_2',
        email: 'cookie@app.test',
        emailVerified: true,
        name: 'Cookie User',
      },
    })
    runtime.sessions.set('revoked-token', null)

    await expect(verifySession('bearer-token')).resolves.toMatchObject({
      sessionId: 'sess_1',
      identity: {
        id: 'workos_1',
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
        cookie: 'workos-session=cookie-token',
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

  it('creates a first-time local user from WorkOS identity data', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('create-token', {
      sessionId: 'sess_create',
      identity: {
        id: 'workos_create',
        email: 'create@app.test',
        emailVerified: true,
        firstName: 'Create',
        lastName: 'User',
        avatar: 'https://cdn.test/avatar.png',
        organizationId: 'org_123',
      },
    })

    const result = await authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer create-token',
      },
    }))

    expect(result).toMatchObject({
      provider: 'dashboard',
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
    expect(runtime.identityStore.records.get('dashboard:workos_create')).toMatchObject({
      userId: 1,
      email: 'create@app.test',
      emailVerified: true,
      profile: {
        organizationId: 'org_123',
      },
    })
    const sessionId = authRuntimeInternals.getRuntimeBindings().context.getSessionId('web')
    expect(sessionId).toBeTypeOf('string')
  })

  it('reuses an existing Holo session when the request already carries the session cookie', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('repeat-token', {
      sessionId: 'sess_repeat',
      identity: {
        id: 'workos_repeat',
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

  it('updates existing linked users on subsequent WorkOS syncs and relinks missing local rows', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('first-token', {
      sessionId: 'sess_first',
      identity: {
        id: 'workos_sync',
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
      identity: {
        id: 'workos_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'Updated Name',
        avatar: 'https://cdn.test/updated.png',
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
      identity: {
        id: 'workos_sync',
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

  it('fails when WorkOS sync needs to persist changes without adapter.update()', async () => {
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
        workos: {
          dashboard: {
            clientId: 'workos-client',
            apiKey: 'workos-key',
            cookiePassword: 'cookie-secret',
            sessionCookie: 'workos-session',
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
    configureWorkosAuthRuntime({
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
      provider: 'dashboard',
      providerUserId: 'workos_sync',
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
      identity: {
        id: 'workos_sync',
        email: 'sync@app.test',
        emailVerified: true,
        name: 'Updated Name',
        avatar: 'https://cdn.test/updated.png',
      },
    }, 'dashboard')).rejects.toThrow('must implement update()')
    expect(usersProvider.users.get(1)).toMatchObject({
      name: 'First Name',
      avatar: null,
      email_verified_at: null,
    })
  })

  it('raises a soft conflict when WorkOS email collides with unexpected local data', async () => {
    const runtime = configureRuntime()
    runtime.sessions.set('initial-link', {
      sessionId: 'sess_initial',
      identity: {
        id: 'workos_conflict',
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
      identity: {
        id: 'workos_conflict',
        email: 'other@app.test',
        emailVerified: true,
        name: 'Linked User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer conflict-token',
      },
    }))).rejects.toBeInstanceOf(WorkosAuthConflictError)
  })

  it('supports WorkOS auth against a non-default guard and provider model', async () => {
    const runtime = configureRuntime({
      workosGuard: 'admin',
    })
    runtime.sessions.set('admin-token', {
      sessionId: 'sess_admin',
      identity: {
        id: 'workos_admin',
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

  it('rejects WorkOS providers mapped to token guards', async () => {
    const runtime = configureRuntime({
      workosGuard: 'api',
    })
    runtime.sessions.set('api-token', {
      sessionId: 'sess_api',
      identity: {
        id: 'workos_api',
        email: 'api@app.test',
        emailVerified: true,
        name: 'API User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer api-token',
      },
    }))).rejects.toThrow('requires auth guard "api" to use the session driver')
  })

  it('blocks unverified WorkOS identities when local verification is required', async () => {
    const runtime = configureRuntime({
      emailVerificationRequired: true,
    })
    runtime.sessions.set('unverified-token', {
      sessionId: 'sess_unverified',
      identity: {
        id: 'workos_unverified',
        email: 'user@app.test',
        emailVerified: false,
        name: 'Pending User',
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer unverified-token',
      },
    }))).rejects.toThrow('must provide a verified email address')
  })

  it('fails closed when the WorkOS runtime or config entry is missing', async () => {
    configureRuntime({
      configureWorkosRuntime: false,
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer token',
      },
    }))).rejects.toThrow('WorkOS auth runtime is not configured yet')

    resetWorkosAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()

    configureRuntime({
      includeWorkosConfig: false,
    })

    await expect(verifySession('token')).rejects.toThrow('is not configured in auth.workos')
  })
})
