import { createNativeHostedAuthPersistence } from '../../auth/tests/support/native-hosted-persistence'
import { generateKeyPairSync, sign as signData } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionStore } from '../../session/src'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import { requestUrlInternals } from '../../kernel/src'
import { configureSecurityRuntime, resetSecurityRuntime } from '../../security/src'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, logout, provider, resetAuthRuntime } from '../../auth/src'
import type { AuthProviderAdapter } from '../../auth/src'
import {
  WorkosAuthConflictError,
  authenticate,
  completeWorkosAuth,
  configureWorkosAuthRuntime,
  loginWithWorkos,
  logoutWithWorkos,
  resetWorkosAuthRuntime,
  registerWithWorkos,
  syncIdentity,
  verifyRequest,
  verifySession,
  workosAuth,
  workosAuthInternals,
  type WorkosAuthenticationResult,
  type WorkosAuthFacade,
  type WorkosCompleteAuthResult,
  type WorkosJsonValue,
  type WorkosVerifiedSession,
} from '../src'

const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')



type AssertExtends<TValue extends TExpected, TExpected> = true
type IsOptionalProperty<TRecord, TKey extends keyof TRecord> = Record<never, never> extends Pick<TRecord, TKey>
  ? true
  : false

type UserRecord = {
  id: number
  name?: string
  email: string
  password?: string | null
  avatar?: string | null
  timezone?: string
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
    readonly profilePictureUrl?: string
    readonly organizationId?: string
    readonly metadata?: Readonly<Record<string, WorkosJsonValue>>
    readonly raw?: Readonly<Record<string, WorkosJsonValue>>
  }
  readonly raw?: unknown
}

function completeWorkosSessionFixture(session: WorkosSessionFixture | null): WorkosVerifiedSession | null {
  if (!session) {
    return null
  }

  const fullName = [session.identity.firstName, session.identity.lastName].filter(Boolean).join(' ')
  const name = session.identity.name
    ?? (fullName || undefined)
    ?? session.identity.email
    ?? session.identity.id

  return {
    ...session,
    identity: {
      ...session.identity,
      email: session.identity.email ?? `${session.identity.id}@app.test`,
      name,
      emailVerified: session.identity.emailVerified ?? false,
      metadata: session.identity.metadata ?? {},
      raw: session.identity.raw ?? {},
    },
  }
}

const SECURE_COOKIE_FLAG = /;\s*Secure\s*(;|$)/

const sessionDirectories: string[] = []

function createSessionStore() {
  const directory = mkdtempSync(join(tmpdir(), 'holo-hosted-auth-session-'))
  sessionDirectories.push(directory)
  return { store: createFileSessionStore(directory), path: directory }
}

type NativeProvider = AuthProviderAdapter<UserRecord> & Required<Pick<AuthProviderAdapter<UserRecord>, 'delete' | 'update' | 'serialize'>>

async function createIdentityStore() {
  return (await createNativeHostedAuthPersistence('workos')).identityStore
}

async function configureRuntime(options: {
  emailVerificationRequired?: boolean
  sessionCookieSecure?: boolean
  workosGuard?: 'web' | 'admin' | 'api'
  defaultWorkosProvider?: string
  includeWorkosConfig?: boolean
  configureWorkosRuntime?: boolean
  workosClientId?: string
  workosApiKey?: string
  workosRedirectUri?: string
} = {}) {
  const { store: sessionStore, path: sessionPath } = createSessionStore()
  configureSessionRuntime({
    appKey: 'holo-test-app-key',
    config: {
      driver: 'file',
      stores: {
        file: {
          name: 'file',
          driver: 'file',
          path: sessionPath,
        },
      },
      cookie: {
        name: 'holo_session',
        path: '/',
        secure: options.sessionCookieSecure === true,
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
      file: sessionStore,
    },
  })

  const persistence = await createNativeHostedAuthPersistence('workos')
  const usersProvider = persistence.providers.users as NativeProvider
  const adminsProvider = persistence.providers.admins as NativeProvider
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
            provider: options.defaultWorkosProvider,
            dashboard: {
              clientId: options.workosClientId ?? 'workos-client',
              apiKey: options.workosApiKey ?? 'workos-key',
              redirectUri: options.workosRedirectUri ?? 'https://app.test/api/auth/workos/callback',
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
    context: Object.assign(authRuntimeInternals.createMemoryAuthContext(), { appendResponseCookie: () => undefined }),
  })

  const identityStore = persistence.identityStore
  const sessions = new Map<string, WorkosSessionFixture | null>()

  if (options.configureWorkosRuntime !== false) {
    configureWorkosAuthRuntime({
      providers: {
        dashboard: {
          async verifySession({ token }) {
            return completeWorkosSessionFixture(sessions.get(token) ?? null)
          },
        },
      },
      identityStore,
    })
  }

  return {
    persistence,
    sessionPath,
    sessionStore,
    usersProvider,
    adminsProvider,
    identityStore,
    sessions,
  }
}

afterEach(async () => {
  resetWorkosAuthRuntime()
  resetAuthRuntime()
  resetSessionRuntime()
  resetSecurityRuntime()
  requestUrlInternals.provideConnectionAddress(undefined)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(sessionDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
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
  const encodedPayload = encodeBase64Url(JSON.stringify({
    aud: 'workos-client',
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

async function createWorkosCallbackRequest(code = 'code_123', headers: Record<string, string> = {}): Promise<Request> {
  const login = await loginWithWorkos(new Request('https://app.test/login'))
  const location = login.headers.get('location')
  const state = location ? new URL(location).searchParams.get('state') : null
  const stateCookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (!state || !stateCookie) {
    throw new Error('Expected WorkOS login to issue callback state.')
  }

  return new Request(`https://app.test/api/auth/workos/callback?code=${code}&state=${state}`, {
    headers: {
      ...headers,
      cookie: stateCookie,
    },
  })
}

describe('@holo-js/auth-workos', () => {
  it('exports the WorkOS auth facade and helpers', () => {
    const facade: WorkosAuthFacade = workosAuth
    expect(workosAuth.authenticate).toBe(authenticate)
    expect(workosAuth.completeWorkosAuth).toBe(completeWorkosAuth)
    expect(workosAuth.loginWithWorkos).toBe(loginWithWorkos)
    expect(workosAuth.logoutWithWorkos).toBe(logoutWithWorkos)
    expect(workosAuth.registerWithWorkos).toBe(registerWithWorkos)
    expect(workosAuth.verifyRequest).toBe(verifyRequest)
    expect(workosAuth.verifySession).toBe(verifySession)
    expect(typeof workosAuthInternals.resolveEmailForCreation).toBe('function')
    expect(facade).toBe(workosAuth)

    function defaultCompleteAuthResult() {
      return workosAuth.completeWorkosAuth(new Request('https://app.test/callback'))
    }
    type CompleteWorkosAuthReturn = Awaited<ReturnType<typeof defaultCompleteAuthResult>>
    type CompleteWorkosAuthSuccess = Extract<CompleteWorkosAuthReturn, { readonly error: null }>['data']
    type CompleteWorkosAuthSessionOptional = IsOptionalProperty<CompleteWorkosAuthSuccess, 'authSession'>
    type WorkosAuthenticationSessionOptional = IsOptionalProperty<WorkosAuthenticationResult, 'authSession'>
    type _CompleteAuthSessionOptionalityMatches = AssertExtends<
      CompleteWorkosAuthSessionOptional,
      WorkosAuthenticationSessionOptional
    >
    type _AuthenticationSessionOptionalityMatches = AssertExtends<
      WorkosAuthenticationSessionOptional,
      CompleteWorkosAuthSessionOptional
    >
    type _CompleteWorkosAuthReturnMatches = AssertExtends<
      CompleteWorkosAuthReturn,
      WorkosCompleteAuthResult
    >
    type _CompleteWorkosAuthReturnReverseMatches = AssertExtends<
      WorkosCompleteAuthResult,
      CompleteWorkosAuthReturn
    >

    expectTypeOf<CompleteWorkosAuthSuccess['authSession']>().toEqualTypeOf<WorkosAuthenticationResult['authSession']>()
    expectTypeOf<IsOptionalProperty<CompleteWorkosAuthSuccess, 'authSession'>>()
      .toEqualTypeOf<IsOptionalProperty<WorkosAuthenticationResult, 'authSession'>>()

    function mappedCompleteAuthResult() {
      return completeWorkosAuth(new Request('https://app.test/callback'), {
        user: workosUser => ({
          email: workosUser.email,
          name: workosUser.name,
          timezone: String(workosUser.metadata.timezone ?? ''),
        }),
      })
    }
    type MappedCompleteAuthSuccess = Extract<Awaited<ReturnType<typeof mappedCompleteAuthResult>>, { readonly error: null }>['data']
    expectTypeOf<MappedCompleteAuthSuccess['user']['timezone']>().toEqualTypeOf<string>()
    expectTypeOf<MappedCompleteAuthSuccess['user']['email']>().toEqualTypeOf<string>()

    function mappedSyncResult() {
      return syncIdentity({
        sessionId: 'sess_type',
        identity: {
          id: 'workos_type',
          email: 'type@app.test',
          emailVerified: true,
          name: 'Type User',
          metadata: {},
          raw: {},
        },
      }, 'dashboard', {
        user: workosUser => ({
          email: workosUser.email,
          name: workosUser.name,
          timezone: String(workosUser.metadata.timezone ?? ''),
        }),
      })
    }
    type MappedSyncResult = Awaited<ReturnType<typeof mappedSyncResult>>
    expectTypeOf<MappedSyncResult['user']['timezone']>().toEqualTypeOf<string>()
    expectTypeOf<MappedSyncResult['user']['email']>().toEqualTypeOf<string>()

    function acceptsTypedFacadeOptions(subject: WorkosAuthFacade): void {
      void subject.completeWorkosAuth(new Request('https://app.test/callback'), {
        user: workosUser => ({
          email: workosUser.email,
          name: workosUser.name,
          timezone: String(workosUser.metadata.timezone ?? ''),
        }),
      })
      void subject.syncIdentity({
        sessionId: 'sess_type',
        identity: {
          id: 'workos_type',
          email: 'type@app.test',
          emailVerified: true,
          name: 'Type User',
          metadata: {},
          raw: {},
        },
      }, 'dashboard', {
        user: workosUser => ({
          email: workosUser.email,
          name: workosUser.name,
        }),
      })
    }

    expectTypeOf(acceptsTypedFacadeOptions).returns.toEqualTypeOf<void>()
  })

  it('resolves the configured default WorkOS provider', async () => {
    await configureRuntime({
      defaultWorkosProvider: 'dashboard',
    })

    expect(workosAuthInternals.resolveConfiguredProviderName()).toBe('dashboard')
  })

  it('creates a resettable WorkOS runtime state property', async () => {
    await configureRuntime()

    expect(Object.getOwnPropertyDescriptor(globalThis, '__holoJsAuthWorkosRuntime')).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    })
  })

  it('uses the built-in verifier when only the identity store is configured', async () => {
    const runtime = await configureRuntime({
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
          organization_id: 'organization-snake',
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

  it('rejects built-in WorkOS JWTs without required bound claims', async () => {
    const runtime = await configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const wrongAudience = createSignedJwt({
      aud: 'other-client',
      sub: 'user_workos_bad_aud',
      sid: 'sess_workos_bad_aud',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const missingExpiration = createSignedJwt({
      sub: 'user_workos_no_exp',
      sid: 'sess_workos_no_exp',
      exp: undefined,
    }, privateKey)
    const publicJwk = publicKey.export({ format: 'jwk' })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.workos.com/sso/jwks/workos-client') {
        return new Response(JSON.stringify({
          keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })

    await expect(verifySession(wrongAudience)).rejects.toThrow('audience')
    await expect(verifySession(missingExpiration)).rejects.toThrow('expiration')
  })

  it('rejects expired, unbound, unsigned, and incomplete built-in WorkOS JWTs', async () => {
    const runtime = await configureRuntime({ configureWorkosRuntime: false })
    configureWorkosAuthRuntime({ identityStore: runtime.identityStore })
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicJwk = publicKey.export({ format: 'jwk' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const claims = { sid: 'session', sub: 'user', exp: Math.floor(Date.now() / 1000) + 3600 }
    await expect(verifySession(createSignedJwt({ ...claims, exp: 1 }, privateKey))).rejects.toThrow('expired')
    await expect(verifySession(createSignedJwt({ ...claims, sub: ' ' }, privateKey))).rejects.toThrow('subject')
    await expect(verifySession(createSignedJwt({ ...claims, sid: undefined }, privateKey))).rejects.toThrow('session id')
    await expect(verifySession(createSignedJwt({ ...claims, aud: [false, 'workos-client'] }, privateKey))).resolves.toBeTruthy()
    await expect(verifySession(createSignedJwt({ ...claims, sid: ' ', session_id: 'legacy-session' }, privateKey))).resolves.toMatchObject({
      sessionId: 'legacy-session',
    })
    await expect(verifySession(createSignedJwt({ ...claims, aud: false }, privateKey))).rejects.toThrow('audience')
    await expect(verifySession(createUnsignedJwt({ aud: 'workos-client', ...claims }))).rejects.toThrow('Unsupported WorkOS JWT algorithm')
  })

  it('rejects a built-in WorkOS JWT whose signature never matches', async () => {
    const runtime = await configureRuntime({ configureWorkosRuntime: false })
    configureWorkosAuthRuntime({ identityStore: runtime.identityStore })
    const signer = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const verifier = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = createSignedJwt({
      sub: 'signature-user',
      sid: 'signature-session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, signer.privateKey)
    const publicJwk = verifier.publicKey.export({ format: 'jwk' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
    }), { status: 200 }))

    await expect(verifySession(token)).rejects.toThrow('signature verification failed')
  })

  it('requires built-in verifier credentials and a readable user profile', async () => {
    const runtime = await configureRuntime({ configureWorkosRuntime: false, workosClientId: '' })
    configureWorkosAuthRuntime({ identityStore: runtime.identityStore })
    await expect(verifySession('token')).rejects.toThrow('clientId')

    resetAuthRuntime()
    await configureRuntime({ configureWorkosRuntime: false, workosApiKey: '' })
    configureWorkosAuthRuntime({ identityStore: runtime.identityStore })
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = createSignedJwt({
      sub: 'profile',
      sid: 'session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const publicJwk = publicKey.export({ format: 'jwk' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(verifySession(token)).rejects.toThrow('apiKey')

    resetAuthRuntime()
    await configureRuntime({ configureWorkosRuntime: false })
    configureWorkosAuthRuntime({ identityStore: runtime.identityStore })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => String(input).includes('/sso/jwks/')
      ? new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }] }), { status: 200 })
      : new Response(null, { status: 503 }))
    await expect(verifySession(token)).rejects.toThrow('Failed to load WorkOS user')
  })

  it('bounds WorkOS JWKS refreshes for forged key ids and expires cached keys after their maximum age', async () => {
    const runtime = await configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })
    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        workos: {
          app: {
            clientId: 'workos-client-flood',
            apiKey: 'workos-api-key',
            redirectUri: 'https://app.test/auth/workos/callback',
          },
        },
      }),
    })

    const trustedKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const forgedKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const trustedJwk = trustedKeyPair.publicKey.export({ format: 'jwk' })
    let jwksRequestCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://api.workos.com/sso/jwks/workos-client-flood') {
        jwksRequestCount += 1
        return new Response(JSON.stringify({
          keys: [{ ...trustedJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    }))

    const forgedSession = (kid: string) => verifySession(createSignedJwt({
      sub: 'user_forged',
      sid: 'sess_forged',
      aud: 'workos-client-flood',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, forgedKeyPair.privateKey, {
      alg: 'RS256',
      kid,
      typ: 'JWT',
    }))

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
      await expect(forgedSession('workos-test-key')).rejects.toThrow('signature verification failed')
      expect(jwksRequestCount).toBe(1)

      vi.setSystemTime(new Date('2030-01-01T00:02:00Z'))
      await Promise.allSettled(Array.from({ length: 5 }, (_, index) => forgedSession(`forged-key-${index}`)))
      expect(jwksRequestCount).toBe(2)

      await Promise.allSettled(Array.from({ length: 5 }, (_, index) => forgedSession(`other-forged-key-${index}`)))
      expect(jwksRequestCount).toBe(2)

      vi.setSystemTime(new Date('2030-01-01T00:13:00Z'))
      await expect(forgedSession('workos-test-key')).rejects.toThrow('signature verification failed')
      expect(jwksRequestCount).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears built-in WorkOS verifier caches when the runtime is reset', async () => {
    const runtime = await configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      sub: 'user_workos_reset',
      sid: 'sess_workos_reset',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, privateKey)
    const publicJwk = publicKey.export({ format: 'jwk' })
    let jwksRequestCount = 0

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.workos.com/sso/jwks/workos-client') {
        jwksRequestCount += 1
        return new Response(JSON.stringify({
          keys: [{ ...publicJwk, kid: 'workos-test-key', alg: 'RS256', use: 'sig' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://api.workos.com/user_management/users/user_workos_reset') {
        return new Response(JSON.stringify({
          id: 'user_workos_reset',
          email: 'reset@app.test',
          email_verified: true,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(null, { status: 404 })
    })

    await expect(verifySession(token)).resolves.toMatchObject({
      sessionId: 'sess_workos_reset',
    })

    resetWorkosAuthRuntime()
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    await expect(verifySession(token)).resolves.toMatchObject({
      sessionId: 'sess_workos_reset',
    })
    expect(jwksRequestCount).toBe(2)
  })

  it('rejects built-in WorkOS JWTs before their not-before time', async () => {
    const runtime = await configureRuntime({
      configureWorkosRuntime: false,
    })
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
    })

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const token = createSignedJwt({
      aud: 'workos-client-future',
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

    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        workos: {
          dashboard: {
            clientId: 'workos-client-future',
            apiKey: 'workos-key',
          },
        },
      }),
    })

    await expect(verifySession(token)).rejects.toThrow('not valid yet')
  })

  it('refreshes cached WorkOS JWKS when a new key id appears', async () => {
    const runtime = await configureRuntime({
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
      aud: 'workos-client-rotate',
      sub: 'user_workos_rotate_first',
      sid: 'sess_workos_rotate_first',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, firstKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'workos-test-key-1',
      typ: 'JWT',
    })
    const secondToken = createSignedJwt({
      aud: 'workos-client-rotate',
      sub: 'user_workos_rotate_second',
      sid: 'sess_workos_rotate_second',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, secondKeyPair.privateKey, {
      alg: 'RS256',
      kid: 'workos-test-key-2',
      typ: 'JWT',
    })

    authRuntimeInternals.configureRuntime({
      ...authRuntimeInternals.getRuntimeBindings(),
      config: defineAuthConfig({
        ...authRuntimeInternals.getRuntimeBindings().config,
        workos: {
          dashboard: {
            clientId: 'workos-client-rotate',
            apiKey: 'workos-key',
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

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    try {
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
    } finally {
      vi.useRealTimers()
    }

    expect(jwksRequestCount).toBe(2)
  })

  it('verifies WorkOS sessions from bearer headers and cookies and fails closed for missing tokens', async () => {
    const runtime = await configureRuntime()
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
        cookie: 'wos-session=cookie-token',
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
    const runtime = await configureRuntime()
    runtime.sessions.set('create-token', {
      sessionId: 'sess_create',
      identity: {
        id: 'workos_create',
        email: 'create@app.test',
        emailVerified: true,
        firstName: 'Create',
        lastName: 'User',
        profilePictureUrl: 'https://cdn.test/avatar.png',
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
    expect(await runtime.identityStore.findByProviderUserId('dashboard', 'workos_create')).toMatchObject({
      userId: '1',
      email: 'create@app.test',
      emailVerified: true,
      profile: {
        organizationId: 'org_123',
      },
    })
    const sessionId = authRuntimeInternals.getRuntimeBindings().context.getSessionId('web')
    expect(sessionId).toBeTypeOf('string')
    await expect(result?.user.can('anything', {})).resolves.toBe(false)
  })

  it('rejects an unlinked WorkOS identity that collides with a local email', async () => {
    const runtime = await configureRuntime()
    await runtime.usersProvider.create({ email: 'collision@app.test' })
    runtime.sessions.set('collision-token', {
      sessionId: 'collision-session',
      identity: {
        id: 'workos_collision',
        email: 'collision@app.test',
        emailVerified: true,
      },
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer collision-token' },
    }))).rejects.toBeInstanceOf(WorkosAuthConflictError)
  })

  it('returns hosted AuthKit redirects for login and register', async () => {
    await configureRuntime()

    const login = await loginWithWorkos(new Request('https://app.test/login'))
    const loginLocation = login.headers.get('location')
    const loginState = loginLocation ? new URL(loginLocation).searchParams.get('state') : null
    expect(login.status).toBe(302)
    expect(loginLocation).toContain('https://api.workos.com/user_management/authorize?')
    expect(loginLocation).toContain('provider=authkit')
    expect(loginLocation).toContain('screen_hint=sign-in')
    expect(loginState).toBeTypeOf('string')
    expect(login.headers.get('set-cookie')).toContain(`holo_workos_dashboard_state=${loginState}`)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect(login.headers.get('set-cookie')).toContain('SameSite=Lax')

    const register = await registerWithWorkos({
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
    expect(register.headers.get('location')).toContain('screen_hint=sign-up')
    expect(register.headers.get('location')).toContain('state=')
    expect(register.headers.get('set-cookie')).toContain('holo_workos_dashboard_state=')
  })

  it('marks the WorkOS state cookie Secure when the session cookie is configured Secure, even over http', async () => {
    await configureRuntime({ sessionCookieSecure: true })

    const login = await loginWithWorkos(new Request('http://app.test/login'))

    expect(login.headers.get('set-cookie')).toContain('holo_workos_dashboard_state=')
    expect(login.headers.get('set-cookie')).toMatch(SECURE_COOKIE_FLAG)
  })

  it('marks the WorkOS state cookie Secure on https requests with the default session cookie', async () => {
    await configureRuntime()

    const login = await loginWithWorkos(new Request('https://app.test/login'))

    expect(login.headers.get('set-cookie')).toMatch(SECURE_COOKIE_FLAG)
  })

  it('clears the WorkOS state cookie with Secure over http when the session cookie is configured Secure', async () => {
    await configureRuntime({ sessionCookieSecure: true })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      access_token: createUnsignedJwt({ sid: 'session_clear_state_cookie' }),
      user: { id: 'workos_clear_state', email: 'clear-state@app.test', emailVerified: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const login = await loginWithWorkos(new Request('http://app.test/login'))
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
    const stateCookie = login.headers.get('set-cookie')?.split(';', 1)[0]

    const callback = await completeWorkosAuth(new Request(`http://app.test/api/auth/workos/callback?code=code_clear_state&state=${state}`, {
      headers: { cookie: stateCookie ?? '' },
    }))

    expect(callback.error).toBeNull()
    const cleared = callback.data?.authSession?.cookies.find(cookie => cookie.startsWith('holo_workos_dashboard_state=;'))
    expect(cleared).toMatch(SECURE_COOKIE_FLAG)
  })

  it('treats X-Forwarded-Proto as https for the WorkOS state cookie only from a trusted proxy', async () => {
    await configureRuntime()
    configureSecurityRuntime({ config: { trustedProxies: ['198.51.100.4'] } })
    const forwardedHeaders = { 'x-forwarded-proto': 'https' }

    requestUrlInternals.provideConnectionAddress(() => '198.51.100.4')
    const trusted = await loginWithWorkos(new Request('http://app.test/login', { headers: forwardedHeaders }))
    expect(trusted.headers.get('set-cookie')).toMatch(SECURE_COOKIE_FLAG)

    requestUrlInternals.provideConnectionAddress(() => '203.0.113.66')
    const untrusted = await loginWithWorkos(new Request('http://app.test/login', { headers: forwardedHeaders }))
    expect(untrusted.headers.get('set-cookie')).not.toMatch(SECURE_COOKIE_FLAG)
  })

  it('sends WorkOS the client IP resolved through trusted proxies, never a spoofed forwarded address', async () => {
    await configureRuntime()
    const sentAddresses: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      sentAddresses.push(JSON.parse(String(init?.body)).ip_address)
      return new Response(JSON.stringify({
        access_token: createUnsignedJwt({ sid: `session_workos_ip_${sentAddresses.length}` }),
        user: { id: 'workos_ip', email: 'ip@app.test', emailVerified: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    requestUrlInternals.provideConnectionAddress(() => '198.51.100.4')
    const spoofed = { 'x-forwarded-for': '203.0.113.66', 'x-real-ip': '203.0.113.67' }

    await completeWorkosAuth(await createWorkosCallbackRequest('code_direct', spoofed))
    configureSecurityRuntime({ config: { trustedProxies: ['198.51.100.4'] } })
    await completeWorkosAuth(await createWorkosCallbackRequest('code_proxied', { 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }))

    expect(sentAddresses).toEqual(['198.51.100.4', '192.0.2.10'])
  })

  it('completes the hosted WorkOS callback with typed user mapping', async () => {
    const runtime = await configureRuntime()
    const accessToken = createUnsignedJwt({ sid: 'session_workos_callback' })
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.workos.com/user_management/authenticate')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer workos-key',
        'content-type': 'application/json',
      })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        grant_type: 'authorization_code',
        client_id: 'workos-client',
        client_secret: 'workos-key',
        code: 'code_123',
      })

      return new Response(JSON.stringify({
        access_token: ` ${accessToken} `,
        organization_id: 'org_123',
        user: {
          id: 'workos_callback',
          email: ' callback@app.test ',
          firstName: 'Callback',
          lastName: 'User',
          emailVerified: true,
          profilePictureUrl: 'https://cdn.test/callback.png',
          metadata: {
            timezone: 'Africa/Cairo',
          },
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })

    const result = await completeWorkosAuth(await createWorkosCallbackRequest(), {
      user: workosUser => ({
        email: workosUser.email,
        name: workosUser.name,
        avatar: workosUser.profilePictureUrl,
        timezone: workosUser.metadata.timezone,
      }),
    })

    expect(result).toMatchObject({
      data: {
        provider: 'dashboard',
        guard: 'web',
        authProvider: 'users',
        status: 'created',
        user: {
          email: 'callback@app.test',
          name: 'Callback User',
          avatar: 'https://cdn.test/callback.png',
          timezone: 'Africa/Cairo',
        },
        identity: {
          provider: 'dashboard',
          providerUserId: 'workos_callback',
          email: 'callback@app.test',
        },
        session: {
          sessionId: 'session_workos_callback',
          accessToken,
        },
      },
      error: null,
    })
    expect(result.data?.authSession?.cookies ?? []).toContainEqual(expect.stringContaining('holo_workos_dashboard_state=;'))
    await expect(provider()).resolves.toBe('workos')
    expect((await runtime.usersProvider.findById(1))).toMatchObject({
      email: 'callback@app.test',
      name: 'Callback User',
      avatar: 'https://cdn.test/callback.png',
      timezone: 'Africa/Cairo',
    })
  })

  it('normalizes camel-case and snake-case callback profiles and session fallbacks', async () => {
    await configureRuntime()
    const profiles = [
      {
        session: { id: 'session_nested' },
        user: {
          id: 'camel-profile',
          email: 'camel@app.test',
          emailVerified: true,
          name: 'Camel Profile',
          profilePictureUrl: 'https://cdn.test/camel.png',
          externalId: 'external-camel',
          organizationId: 'organization-camel',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        user: {
          id: 'snake-profile',
          email: 'snake@app.test',
          email_verified: true,
          first_name: 'Snake',
          last_name: 'Profile',
          profile_picture_url: 'https://cdn.test/snake.png',
          external_id: 'external-snake',
          organization_id: 'organization-snake',
          created_at: '2026-02-01T00:00:00.000Z',
          updated_at: '2026-02-02T00:00:00.000Z',
        },
      },
    ]

    for (const [index, payload] of profiles.entries()) {
      const request = await createWorkosCallbackRequest(`profile-code-${index}`)
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      const result = await completeWorkosAuth(request)
      if (index === 0) {
        expect(result.error).toBeNull()
        expect(result.data?.session.sessionId).toBe('session_nested')
      } else {
        expect(result.data).toBeNull()
        expect(result.error?.code).toBe('workos_auth_failed')
      }
    }
  })

  it('logs out locally and returns the WorkOS hosted logout URL', async () => {
    await configureRuntime()
    const accessToken = createUnsignedJwt({ sid: 'session_workos_logout' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      access_token: accessToken,
      user: {
        id: 'workos_logout_callback',
        email: 'logout-callback@app.test',
        emailVerified: true,
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))

    const callback = await completeWorkosAuth(await createWorkosCallbackRequest())
    expect(callback.error).toBeNull()
    if (!callback.data?.authSession) {
      throw new Error('Expected WorkOS callback to establish an auth session.')
    }
    const sessionCookie = callback.data.authSession.cookies[0]?.split(';', 1)[0]

    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    authRuntimeInternals.getRuntimeBindings().context.setCachedUser('web', null)

    const response = await logoutWithWorkos(new Request('https://app.test/api/auth/workos/logout', {
      method: 'POST',
      headers: sessionCookie ? { cookie: sessionCookie } : undefined,
    }), {
      returnTo: 'https://evil.test/after-logout',
    })

    expect(response.status).toBe(303)
    const hostedLogoutUrl = new URL(response.headers.get('location') ?? '')
    expect(hostedLogoutUrl.searchParams.get('session_id')).toBe('session_workos_logout')
    expect(hostedLogoutUrl.searchParams.get('return_to')).toBe('https://app.test')
    expect(response.headers.get('set-cookie')).toContain('holo_session=;')

    const safeCallback = await completeWorkosAuth(await createWorkosCallbackRequest())
    const safeCookie = safeCallback.data?.authSession?.cookies[0]?.split(';', 1)[0]
    const safeResponse = await logoutWithWorkos(new Request('https://app.test/logout', {
      headers: safeCookie ? { cookie: safeCookie } : undefined,
    }), { returnTo: '/signed-out' })
    expect(new URL(safeResponse.headers.get('location') ?? '').searchParams.get('return_to')).toBe('https://app.test/signed-out')

    const invalidCallback = await completeWorkosAuth(await createWorkosCallbackRequest())
    const invalidCookie = invalidCallback.data?.authSession?.cookies[0]?.split(';', 1)[0]
    const invalidResponse = await logoutWithWorkos(new Request('https://app.test/logout', {
      headers: invalidCookie ? { cookie: invalidCookie } : undefined,
    }), { returnTo: 'http://[' })
    expect(new URL(invalidResponse.headers.get('location') ?? '').searchParams.get('return_to')).toBe('https://app.test')

    const plainCallback = await completeWorkosAuth(await createWorkosCallbackRequest())
    const plainCookie = plainCallback.data?.authSession?.cookies[0]?.split(';', 1)[0]
    const plainResponse = await logoutWithWorkos(new Request('https://app.test/logout', {
      headers: plainCookie ? { cookie: plainCookie } : undefined,
    }))
    expect(new URL(plainResponse.headers.get('location') ?? '').searchParams.has('return_to')).toBe(false)
  })

  it.each([
    ['an opaque access token', { access_token: 'opaque_access_token_secret' }],
    ['no token', {}],
  ])('fails closed when WorkOS returns %s and no session id, creating no Holo session', async (_label, tokens) => {
    const runtime = await configureRuntime()
    const sessionFilesBefore = (await readdir(runtime.sessionPath)).sort()
    const respondWith = (payload: Readonly<Record<string, unknown>>) => vi.stubGlobal('fetch', async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))

    respondWith({
      ...tokens,
      user: {
        id: 'workos_no_session_id',
        email: 'no-session-id@app.test',
        emailVerified: true,
      },
    })
    const callback = await completeWorkosAuth(await createWorkosCallbackRequest('code_no_session_id'))

    expect(callback.data).toBeNull()
    expect(callback.error?.code).toBe('workos_auth_failed')
    expect(callback.error?.message).toContain('session id')
    expect(JSON.stringify(callback)).not.toContain('opaque_access_token_secret')
    expect(JSON.stringify(callback)).not.toContain('code_no_session_id')
    expect(await runtime.usersProvider.findByCredentials({ email: 'no-session-id@app.test' })).toBeNull()
    expect(await runtime.identityStore.findByProviderUserId('dashboard', 'workos_no_session_id')).toBeNull()
    expect((await readdir(runtime.sessionPath)).sort()).toEqual(sessionFilesBefore)

    const logout = await logoutWithWorkos(new Request('https://app.test/logout'))
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe('https://app.test/')

    respondWith({
      access_token: createUnsignedJwt({ sid: 'session_positive_control' }),
      user: { id: 'workos_positive_control', email: 'positive-control@app.test', emailVerified: true },
    })
    const positive = await completeWorkosAuth(await createWorkosCallbackRequest('code_positive_control'))
    expect(positive.error).toBeNull()
    expect((await readdir(runtime.sessionPath)).length).toBeGreaterThan(sessionFilesBefore.length)
  })

  it('fails closed when the WorkOS session id lacks the session_ prefix', async () => {
    const runtime = await configureRuntime()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      session: { id: 'opaque-session-id' },
      user: { id: 'workos_unprefixed', email: 'unprefixed@app.test', emailVerified: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const callback = await completeWorkosAuth(await createWorkosCallbackRequest('code_unprefixed'))

    expect(callback.data).toBeNull()
    expect(callback.error?.code).toBe('workos_auth_failed')
    expect(await runtime.usersProvider.findByCredentials({ email: 'unprefixed@app.test' })).toBeNull()
    expect(await runtime.identityStore.findByProviderUserId('dashboard', 'workos_unprefixed')).toBeNull()
  })

  it('writes no user, identity, or session when the request URL cannot be resolved for the state cookie', async () => {
    const runtime = await configureRuntime()
    configureSecurityRuntime({ config: { trustedProxies: ['198.51.100.4'] } })
    requestUrlInternals.provideConnectionAddress(() => '198.51.100.4')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      access_token: createUnsignedJwt({ sid: 'session_bad_forwarded_host' }),
      user: { id: 'workos_bad_host', email: 'bad-host@app.test', emailVerified: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const callback = await completeWorkosAuth(await createWorkosCallbackRequest('code_bad_host', { 'x-forwarded-host': 'bad host/' }))

    expect(callback.data).toBeNull()
    expect(callback.error?.code).toBe('workos_auth_failed')
    expect(await runtime.usersProvider.findByCredentials({ email: 'bad-host@app.test' })).toBeNull()
    expect(await runtime.identityStore.findByProviderUserId('dashboard', 'workos_bad_host')).toBeNull()
  })

  it('takes the session id from a session_id claim when the access token has no sid', async () => {
    await configureRuntime()
    const accessToken = createUnsignedJwt({ session_id: 'session_claim_only' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      access_token: accessToken,
      user: {
        id: 'workos_session_claim',
        email: 'session-claim@app.test',
        emailVerified: true,
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))

    const callback = await completeWorkosAuth(await createWorkosCallbackRequest('code_session_claim'))
    expect(callback.error).toBeNull()
    expect(callback.data?.session.sessionId).toBe('session_claim_only')
    const sessionCookie = callback.data?.authSession?.cookies[0]?.split(';', 1)[0]

    const response = await logoutWithWorkos(new Request('https://app.test/logout', {
      headers: sessionCookie ? { cookie: sessionCookie } : undefined,
    }))
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('session_id')).toBe('session_claim_only')
  })

  it.each([
    ['an access token', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl'],
    ['an opaque access token', 'opaque_access_token_secret'],
    ['an authorization code', 'code_01_authorization_secret'],
  ])('logs out locally and never sends %s upstream as the session id', async (_label, storedSessionId) => {
    const runtime = await configureRuntime()
    const now = new Date()
    await runtime.sessionStore.write({
      id: 'legacy-workos-session',
      store: 'file',
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          authenticatedAt: now.toISOString(),
          userId: 1,
          user: { id: 1 },
          workos: { provider: 'dashboard', sessionId: storedSessionId },
        },
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web', 'legacy-workos-session')

    const response = await logoutWithWorkos(new Request('https://app.test/logout'))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.test/')
    expect(response.headers.get('location')).not.toContain(storedSessionId)
    expect(response.headers.get('set-cookie')).toContain('holo_session=;')
  })

  it('sends a stored WorkOS session id upstream in the hosted logout URL', async () => {
    const runtime = await configureRuntime()
    const now = new Date()
    await runtime.sessionStore.write({
      id: 'workos-session',
      store: 'file',
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          userId: 1,
          authenticatedAt: now.toISOString(),
          user: { id: 1 },
          workos: { provider: 'dashboard', sessionId: 'session_01HZ8V3K1ARTE0A3XQ7B2Q9ZCD' },
        },
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web', 'workos-session')

    const response = await logoutWithWorkos(new Request('https://app.test/logout'))

    expect(new URL(response.headers.get('location') ?? '').searchParams.get('session_id')).toBe('session_01HZ8V3K1ARTE0A3XQ7B2Q9ZCD')
  })

  it('returns typed callback failures without combining response behavior', async () => {
    await configureRuntime()

    await expect(completeWorkosAuth(new Request('https://app.test/api/auth/workos/callback'))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'workos_code_required',
        message: 'WorkOS callback did not include an authorization code.',
      },
    })

    await expect(completeWorkosAuth(new Request('https://app.test/api/auth/workos/callback?error=access_denied&error_description=Denied'))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'access_denied',
        message: 'Denied',
      },
    })
    await expect(completeWorkosAuth(new Request('https://app.test/api/auth/workos/callback?error=cancelled'))).resolves.toMatchObject({
      data: null,
      error: { code: 'cancelled', message: 'WorkOS authentication failed.' },
    })
  })

  it('rejects WorkOS callbacks with missing or mismatched state before exchanging codes', async () => {
    await configureRuntime()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeWorkosAuth(new Request('https://app.test/api/auth/workos/callback?code=code_123'))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'workos_state_mismatch',
        message: 'WorkOS callback state did not match the login request.',
      },
    })

    await expect(completeWorkosAuth(new Request('https://app.test/api/auth/workos/callback?code=code_123&state=callback-state', {
      headers: {
        cookie: 'holo_workos_dashboard_state=login-state',
      },
    }))).resolves.toMatchObject({
      data: null,
      error: {
        code: 'workos_state_mismatch',
        message: 'WorkOS callback state did not match the login request.',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reuses an existing Holo session when the request already carries the session cookie', async () => {
    const runtime = await configureRuntime()
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
    expect(firstSessionId ? await runtime.sessionStore.read(firstSessionId) : null).not.toBeNull()
  })

  it('does not reuse Holo sessions with mismatched auth or WorkOS identities', async () => {
    const runtime = await configureRuntime()
    runtime.sessions.set('mismatch-token', {
      sessionId: 'workos-session',
      identity: {
        id: 'workos_mismatch',
        email: 'mismatch@app.test',
        emailVerified: true,
      },
    })
    const first = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token' },
    }))
    const firstId = first?.authSession?.sessionId
    const firstCookie = first?.authSession?.cookies[0]?.split(';', 1)[0]
    const firstRecord = firstId ? await runtime.sessionStore.read(firstId) : undefined
    if (!firstId || !firstCookie || !firstRecord) {
      throw new Error('Expected an initial Holo session.')
    }
    const firstPayload = firstRecord.data.auth as Record<string, unknown>
    await runtime.sessionStore.write({
      ...firstRecord,
      data: { auth: { ...firstPayload, provider: 'admins' } },
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const second = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: firstCookie },
    }))
    expect(second?.authSession?.sessionId).not.toBe(firstId)

    const secondId = second?.authSession?.sessionId
    const secondCookie = second?.authSession?.cookies[0]?.split(';', 1)[0]
    const secondRecord = secondId ? await runtime.sessionStore.read(secondId) : undefined
    if (!secondId || !secondCookie || !secondRecord) {
      throw new Error('Expected a replacement Holo session.')
    }
    const secondPayload = secondRecord.data.auth as Record<string, unknown>
    await runtime.sessionStore.write({
      ...secondRecord,
      data: {
        auth: {
          ...secondPayload,
          workos: { provider: 'other', sessionId: 'workos-session' },
        },
      },
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const third = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: secondCookie },
    }))
    expect(third?.authSession?.sessionId).not.toBe(secondId)

    const thirdId = third?.authSession?.sessionId
    const thirdCookie = third?.authSession?.cookies[0]?.split(';', 1)[0]
    const thirdRecord = thirdId ? await runtime.sessionStore.read(thirdId) : undefined
    if (!thirdId || !thirdCookie || !thirdRecord) {
      throw new Error('Expected a second replacement Holo session.')
    }
    const { workos: _workos, ...standardPayload } = thirdRecord.data.auth as Record<string, unknown>
    await runtime.sessionStore.write({ ...thirdRecord, data: { auth: standardPayload } })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web')
    const fourth = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer mismatch-token', cookie: thirdCookie },
    }))
    expect(fourth?.authSession).toMatchObject({ sessionId: thirdId, provider: 'users', cookies: [] })
  })

  it('clears the WorkOS hosted session cookie through the shared logout api', async () => {
    const runtime = await configureRuntime()
    runtime.sessions.set('logout-token', {
      sessionId: 'sess_logout',
      identity: {
        id: 'workos_logout',
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
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('wos-session=;'))
  })

  it.each([
    [undefined],
    [null],
    ['invalid'],
    [{ provider: 'other', sessionId: 'session' }],
    [{ provider: 'dashboard', sessionId: ' ' }],
  ] as const)('ignores malformed WorkOS logout metadata %#', async (workos) => {
    const runtime = await configureRuntime()
    const now = new Date()
    await runtime.sessionStore.write({
      id: 'malformed-session',
      store: 'file',
      data: {
        auth: {
          guard: 'web',
          provider: 'users',
          userId: 1,
          user: { id: 1 },
          ...(typeof workos === 'undefined' ? {} : { workos }),
        },
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    authRuntimeInternals.getRuntimeBindings().context.setSessionId('web', 'malformed-session')

    const response = await logoutWithWorkos(new Request('https://app.test/logout'))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.test/')
  })

  it('updates existing linked users on subsequent WorkOS syncs and relinks missing local rows', async () => {
    const runtime = await configureRuntime()
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
        profilePictureUrl: 'https://cdn.test/updated.png',
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

    await runtime.usersProvider.delete(1)
    await runtime.usersProvider.create({
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

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer relink-token',
      },
    }))).rejects.toBeInstanceOf(WorkosAuthConflictError)
  })

  it('relinks an identity when its local row no longer exists', async () => {
    const runtime = await configureRuntime()
    await runtime.identityStore.save({
      provider: 'dashboard',
      providerUserId: 'workos_orphan',
      guard: 'web',
      authProvider: 'users',
      userId: 404,
      email: 'old@app.test',
      emailVerified: true,
      profile: {},
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    const result = await syncIdentity({
      sessionId: 'orphan-session',
      identity: {
        id: 'workos_orphan',
        email: 'new@app.test',
        emailVerified: true,
        name: 'Recreated User',
        metadata: {},
        raw: {},
      },
    }, 'dashboard')

    expect(result).toMatchObject({
      status: 'relinked',
      user: { id: 1, email: 'new@app.test', name: 'Recreated User' },
      identity: { userId: 1 },
    })
    expect(result.identity.linkedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))

    await runtime.identityStore.save({
      provider: 'dashboard',
      providerUserId: 'workos_orphan_no_email',
      guard: 'web',
      authProvider: 'users',
      userId: 405,
      email: '',
      emailVerified: false,
      profile: {},
      linkedAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    })
    await expect(syncIdentity({
      sessionId: 'orphan-no-email-session',
      identity: {
        id: 'workos_orphan_no_email',
        name: '',
        email: '',
        emailVerified: false,
        metadata: {},
        raw: {},
      },
    }, 'dashboard')).resolves.toMatchObject({ status: 'relinked' })
  })

  it('creates identities without an email and updates linked users without collisions', async () => {
    const runtime = await configureRuntime()
    const created = await syncIdentity({
      sessionId: 'no-email-session',
      identity: {
        id: 'workos_no_email',
        name: '',
        email: '',
        emailVerified: false,
        metadata: {},
        raw: {},
      },
    }, 'dashboard')
    expect(created).toMatchObject({
      status: 'created',
      user: { email: 'workos_no_email@workos.hosted.local' },
    })

    const updated = await syncIdentity({
      sessionId: 'no-email-session-2',
      identity: {
        id: 'workos_no_email',
        email: 'unique@app.test',
        emailVerified: true,
        name: 'Unique User',
        metadata: {},
        raw: {},
      },
    }, 'dashboard')
    expect(updated).toMatchObject({ status: 'updated', user: { email: 'unique@app.test' } })
    expect((await runtime.usersProvider.findByCredentials({ email: 'unique@app.test' }))?.id).toBe(1)
  })

  it('keeps the stored email and its verification when WorkOS reports the new email unverified', async () => {
    const runtime = await configureRuntime()
    const verifiedAt = new Date('2026-04-08T00:00:00.000Z')
    const user = await runtime.usersProvider.create({ email: 'owner@app.test', name: 'Owner', password: null, email_verified_at: verifiedAt })
    await runtime.identityStore.save({
      provider: 'dashboard',
      providerUserId: 'workos_owner',
      guard: 'web',
      authProvider: 'users',
      userId: user.id,
      email: 'owner@app.test',
      emailVerified: true,
      profile: {},
      linkedAt: verifiedAt,
      updatedAt: verifiedAt,
    })

    await expect(syncIdentity({
      sessionId: 'unverified-email-change',
      identity: {
        id: 'workos_owner',
        email: 'victim@app.test',
        emailVerified: false,
        name: 'Owner',
        metadata: {},
        raw: {},
      },
    }, 'dashboard')).resolves.toMatchObject({ status: 'linked' })
    expect(await runtime.usersProvider.findById(user.id)).toMatchObject({
      email: 'owner@app.test',
      email_verified_at: verifiedAt,
    })
  })

  it('does not overwrite linked users with synthetic fallback fields when WorkOS omits profile data', async () => {
    const runtime = await configureRuntime()
    const linkedUser = await runtime.usersProvider.create({
      name: 'Existing User',
      email: 'existing@app.test',
      password: null,
      avatar: null,
      email_verified_at: new Date(),
    })
    await runtime.identityStore.save({
      provider: 'dashboard',
      providerUserId: 'workos_existing',
      guard: 'web',
      authProvider: 'users',
      userId: linkedUser.id,
      email: 'existing@app.test',
      emailVerified: true,
      profile: {},
      linkedAt: new Date('2026-04-08T00:00:00.000Z'),
      updatedAt: new Date('2026-04-08T00:00:00.000Z'),
    })

    const result = await syncIdentity({
      sessionId: 'sess_existing',
      identity: {
        id: 'workos_existing',
        email: '',
        emailVerified: false,
        name: '',
        metadata: {},
        raw: {},
      },
    }, 'dashboard')

    expect(result).toMatchObject({
      status: 'linked',
      user: {
        id: linkedUser.id,
        name: 'Existing User',
        email: 'existing@app.test',
      },
    })
    expect((await runtime.usersProvider.findById(linkedUser.id))).toMatchObject({
      name: 'Existing User',
      email: 'existing@app.test',
    })
    expect((await runtime.usersProvider.findByCredentials({ email: 'workos_existing@workos.hosted.local' }))?.id).toBeUndefined()
  })

  it('fails when WorkOS sync needs to persist changes without adapter.update()', async () => {
    const { store: sessionStore, path: sessionPath } = createSessionStore()
    const persistence = await createNativeHostedAuthPersistence('workos')
    const { update: _update, ...usersProvider } = persistence.providers.users as NativeProvider
    const adminsProvider = persistence.providers.admins as NativeProvider
    const identityStore = persistence.identityStore

    configureSessionRuntime({
      appKey: 'holo-test-app-key',
      config: {
        driver: 'file',
        stores: {
          file: {
            name: 'file',
            driver: 'file',
            path: sessionPath,
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
        file: sessionStore,
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
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: usersProvider,
        admins: adminsProvider,
      },
      context: Object.assign(authRuntimeInternals.createMemoryAuthContext(), { appendResponseCookie: () => undefined }),
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
        profilePictureUrl: 'https://cdn.test/updated.png',
        metadata: {},
        raw: {},
      },
    }, 'dashboard')).rejects.toThrow('must implement update()')
    expect((await usersProvider.findById(1))).toMatchObject({
      name: 'First Name',
      avatar: null,
      email_verified_at: null,
    })
  })

  it('raises a soft conflict when WorkOS email collides with unexpected local data', async () => {
    const runtime = await configureRuntime()
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

    let conflictError: unknown
    try {
      await authenticate(new Request('https://app.test/me', {
        headers: {
          authorization: 'Bearer conflict-token',
        },
      }))
    } catch (error) {
      conflictError = error
    }

    expect(conflictError).toBeInstanceOf(WorkosAuthConflictError)
    expect(conflictError).toMatchObject({
      provider: 'dashboard',
      workosUserId: 'workos_conflict',
      email: 'other@app.test',
    })
  })

  it('supports WorkOS auth against a non-default guard and provider model', async () => {
    const runtime = await configureRuntime({
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
    expect((await runtime.adminsProvider.findById(1))?.email).toBe('admin@app.test')
    expect(await runtime.persistence.db.table('users').count()).toBe(0)
    const sessionId = authRuntimeInternals.getRuntimeBindings().context.getSessionId('admin')
    expect(sessionId).toBeTypeOf('string')
  })

  it('rejects WorkOS providers mapped to token guards', async () => {
    const runtime = await configureRuntime({
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
    const runtime = await configureRuntime({
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
    await configureRuntime({
      configureWorkosRuntime: false,
    })

    await expect(authenticate(new Request('https://app.test/me', {
      headers: {
        authorization: 'Bearer token',
      },
    }))).rejects.toThrow('WorkOS auth runtime is not configured yet')
    const logoutResult = await logoutWithWorkos(new Request('https://app.test/api/auth/workos/logout', {
      method: 'POST',
    }))
    expect(logoutResult.status).toBe(303)
    expect(logoutResult.headers.get('location')).toBe('https://app.test/')

    resetWorkosAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()

    await configureRuntime({
      includeWorkosConfig: false,
    })

    await expect(verifySession('token')).rejects.toThrow('is not configured in auth.workos')
    const failedLogout = await logoutWithWorkos(new Request('https://app.test/api/auth/workos/logout', {
      method: 'POST',
    }))
    await expect(failedLogout.json()).resolves.toEqual({
      data: null,
      error: {
        code: 'workos_logout_failed',
        message: 'Unable to complete WorkOS logout.',
        status: 500,
        fields: {
          _root: ['Unable to complete WorkOS logout.'],
        },
      },
    })
    expect(failedLogout.status).toBe(500)
  })

  it('normalizes WorkOS helper edge cases', async () => {
    await configureRuntime()

    expect(workosAuthInternals.resolveConfiguredProviderName(' dashboard ')).toBe('dashboard')
    expect(workosAuthInternals.getSessionTokenFromRequest(new Request('https://app.test', {
      headers: { authorization: 'Basic token', cookie: 'wos_session=cookie-token' },
    }), 'wos_session')).toBe('cookie-token')
    expect(workosAuthInternals.getSessionTokenFromRequest(new Request('https://app.test', {
      headers: { authorization: 'Bearer   bearer-token' },
    }), 'wos_session')).toBe('bearer-token')
    expect(workosAuthInternals.resolveDisplayName({
      id: 'workos_name',
      name: '',
      email: '',
      emailVerified: false,
      firstName: ' Ada ',
      lastName: ' Lovelace ',
      metadata: {},
      raw: {},
    })).toBe('Ada Lovelace')
    expect(workosAuthInternals.resolveDisplayName({
      id: 'workos_id',
      name: '',
      email: '',
      emailVerified: false,
      metadata: {},
      raw: {},
    })).toBe('workos_id')
    expect(workosAuthInternals.resolveEmailForCreation({
      id: 'workos_email',
      name: '',
      email: '  ',
      emailVerified: false,
      metadata: {},
      raw: {},
    })).toBe('workos_email@workos.hosted.local')
  })

  it.each([
    ['clientId', { workosClientId: '' }, 'clientId'],
    ['apiKey', { workosApiKey: '' }, 'apiKey'],
    ['redirectUri', { workosRedirectUri: '' }, 'redirectUri'],
  ] as const)('returns a safe redirect error when %s is missing', async (_field, options, message) => {
    await configureRuntime(options)

    const response = await loginWithWorkos(new Request('https://app.test/login'))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      code: 'workos_login_failed',
      message: expect.stringContaining(message),
      ok: false,
    })
  })

  it('fails closed for missing provider capabilities and adapters', async () => {
    const runtime = await configureRuntime()
    configureWorkosAuthRuntime({
      providers: { dashboard: {} },
      identityStore: runtime.identityStore,
    })
    await expect(verifySession('token')).rejects.toThrow('does not implement verifySession()')

    const bindings = authRuntimeInternals.getRuntimeBindings()
    configureAuthRuntime({
      config: bindings.config,
      session: bindings.session,
      providers: {},
      context: bindings.context,
    })
    expect(() => workosAuthInternals.resolveGuardAndProvider('dashboard')).toThrow('runtime "users" is not configured')
  })

  it('rejects malformed users returned by auth provider boundaries', async () => {
    const runtime = await configureRuntime()
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
      identity: { id: 'malformed-create', name: '', email: '', emailVerified: false, metadata: {}, raw: {} },
    }, 'dashboard')).rejects.toThrow('create() must return an object user')

    const invalidId: AuthProviderAdapter<UserRecord> = {
      findById: async () => null,
      findByCredentials: async () => null,
      create: async input => ({ id: 1, email: String(input.email) }),
      getId: () => ({}) as never,
      serialize: user => user,
    }
    configureAuthRuntime({ ...bindings, providers: { users: invalidId } })
    await expect(syncIdentity({
      sessionId: 'invalid-id',
      identity: { id: 'invalid-id', name: '', email: '', emailVerified: false, metadata: {}, raw: {} },
    }, 'dashboard')).rejects.toThrow('must expose a serializable id')

    expect(await runtime.persistence.db.table('auth_identities').count()).toBe(0)
  })

  it('serializes local users when an auth adapter has no serializer', async () => {
    const runtime = await configureRuntime()
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
      identity: {
        id: 'no-serializer',
        name: '',
        email: 'no-serializer@app.test',
        emailVerified: true,
        metadata: {},
        raw: {},
      },
    }, 'dashboard')

    expect(result.user).toMatchObject({ id: 1, email: 'no-serializer@app.test' })
  })

  it('can explicitly clear the WorkOS runtime bindings', async () => {
    await configureRuntime()
    configureWorkosAuthRuntime()

    expect(() => workosAuthInternals.getBindings()).toThrow('not configured yet')
  })

  it('resolves multiple configured providers deterministically', async () => {
    const runtime = await configureRuntime()
    const bindings = authRuntimeInternals.getRuntimeBindings()
    authRuntimeInternals.configureRuntime({
      ...bindings,
      config: defineAuthConfig({
        ...bindings.config,
        workos: {
          identityStore: runtime.identityStore,
          alpha: { clientId: 'alpha', apiKey: 'key' },
          beta: { clientId: 'beta', apiKey: 'key' },
        },
      }),
    })
    expect(() => workosAuthInternals.resolveConfiguredProviderName()).toThrow('provider name is required')

    authRuntimeInternals.configureRuntime({
      ...bindings,
      config: defineAuthConfig({
        ...bindings.config,
        workos: {
          default: { clientId: 'default', apiKey: 'key' },
          beta: { clientId: 'beta', apiKey: 'key' },
        },
      }),
    })
    expect(workosAuthInternals.resolveConfiguredProviderName()).toBe('default')
  })

  it('delegates request verification and returns null authentication safely', async () => {
    const runtime = await configureRuntime()
    const verifyRequestRuntime = vi.fn(async () => null)
    configureWorkosAuthRuntime({
      identityStore: runtime.identityStore,
      providers: { dashboard: { verifyRequest: verifyRequestRuntime } },
    })

    const request = new Request('https://app.test/me')
    await expect(verifyRequest(request)).resolves.toBeNull()
    await expect(authenticate(request)).resolves.toBeNull()
    expect(verifyRequestRuntime).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a session when the session runtime emits no cookie name', async () => {
    const runtime = await configureRuntime()
    runtime.sessions.set('cookie-name-token', {
      sessionId: 'cookie-name-session',
      identity: {
        id: 'cookie-name-user',
        email: 'cookie-name@app.test',
        emailVerified: true,
      },
    })
    const bindings = authRuntimeInternals.getRuntimeBindings()
    authRuntimeInternals.configureRuntime({
      ...bindings,
      session: {
        ...bindings.session,
        sessionCookie: () => '',
      },
    })

    const result = await authenticate(new Request('https://app.test/me', {
      headers: { authorization: 'Bearer cookie-name-token', cookie: 'holo_session=stale' },
    }))

    expect(result?.authSession?.sessionId).toBeTypeOf('string')
  })

  it('converts non-error callback failures into a stable public failure', async () => {
    await configureRuntime()
    const request = await createWorkosCallbackRequest()
    vi.stubGlobal('fetch', async () => {
      throw 'network failure'
    })

    await expect(completeWorkosAuth(request)).resolves.toMatchObject({
      data: null,
      error: {
        code: 'workos_auth_failed',
        message: 'WorkOS authentication failed.',
        status: 422,
      },
    })
  })

  it('returns a conflict result when a callback email is already owned locally', async () => {
    const runtime = await configureRuntime()
    await runtime.usersProvider.create({ email: 'callback-conflict@app.test' })
    const request = await createWorkosCallbackRequest()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      session_id: 'session_callback_conflict',
      user: {
        id: 'callback-conflict',
        email: 'callback-conflict@app.test',
        emailVerified: true,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(completeWorkosAuth(request)).resolves.toMatchObject({
      data: null,
      error: {
        code: 'workos_identity_conflict',
        status: 409,
      },
    })
  })

  it.each([
    [400, { message: 'invalid authorization code' }, 'invalid authorization code'],
    [401, { error_description: 'expired authorization code' }, 'expired authorization code'],
    [403, {}, 'status 403'],
    [200, { access_token: 'token' }, 'did not return a user'],
  ] as const)('normalizes WorkOS callback response failures with status %s', async (status, body, message) => {
    await configureRuntime()
    const request = await createWorkosCallbackRequest()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(completeWorkosAuth(request)).resolves.toMatchObject({
      data: null,
      error: { message: expect.stringContaining(message) },
    })
  })
})
