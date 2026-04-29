import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src'
import type { SessionRecord, SessionStore } from '../../session/src'
import auth, {
  authRuntimeInternals,
  check,
  configureAuthRuntime,
  currentAccessToken,
  defineAuthConfig,
  getAuthRuntime,
  hashPassword,
  id,
  impersonate,
  impersonateById,
  impersonation,
  login,
  loginUsing,
  loginUsingId,
  logout,
  needsPasswordRehash,
  passwords,
  refreshUser,
  register,
  resetAuthRuntime,
  stopImpersonating,
  tokens,
  user,
  verification,
  verifyPassword,
} from '../src'
import clientAuth, {
  authClientInternals,
  check as clientCheck,
  configureAuthClient,
  refreshUser as clientRefreshUser,
  resetAuthClient,
  user as clientUser,
} from '../src/client'

function hashPasswordResetEmail(email: string, csrfSigningKey?: string): string {
  const canonicalEmail = email.trim().toLowerCase()

  if (csrfSigningKey) {
    return createHmac('sha256', csrfSigningKey).update(canonicalEmail).digest('hex')
  }

  return createHash('sha256').update(canonicalEmail).digest('hex')
}
import type {
  AuthDeliveryHook,
  AuthProviderAdapter,
  HoloAuthConfig,
  AuthUser,
  EmailVerificationTokenRecord,
  EmailVerificationTokenStore,
  PasswordResetTokenRecord,
  PasswordResetTokenStore,
  PersonalAccessTokenRecord,
  AuthTokenStore,
} from '../src'

type UserRecord = {
  id: number
  name?: string
  email: string
  phone?: string
  country?: string
  dob?: string
  role?: 'admin' | 'member'
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
  readonly usersByPhone = new Map<string, number>()
  nextId = 1

  async findById(id: string | number): Promise<UserRecord | null> {
    const numericId = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
    return this.users.get(numericId) ?? null
  }

  async findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<UserRecord | null> {
    const email = typeof credentials.email === 'string' ? credentials.email : undefined
    const phone = typeof credentials.phone === 'string' ? credentials.phone : undefined

    if (email) {
      const id = this.usersByEmail.get(email)
      return typeof id === 'number' ? this.users.get(id) ?? null : null
    }

    if (phone) {
      const id = this.usersByPhone.get(phone)
      return typeof id === 'number' ? this.users.get(id) ?? null : null
    }

    return null
  }

  async create(input: Readonly<Record<string, unknown>>): Promise<UserRecord> {
    const record: UserRecord = {
      id: this.nextId,
      name: typeof input.name === 'string' ? input.name : undefined,
      email: typeof input.email === 'string' ? input.email : '',
      password: typeof input.password === 'string' || input.password === null ? input.password as string | null : undefined,
      avatar: typeof input.avatar === 'string' || input.avatar === null ? input.avatar as string | null : undefined,
      email_verified_at: input.email_verified_at instanceof Date || input.email_verified_at === null
        ? input.email_verified_at as Date | null
        : undefined,
    }
    if (typeof input.phone === 'string') {
      record.phone = input.phone
    }
    if (typeof input.country === 'string') {
      record.country = input.country
    }
    if (typeof input.dob === 'string') {
      record.dob = input.dob
    }
    this.nextId += 1
    this.users.set(record.id, record)
    if (record.email) {
      this.usersByEmail.set(record.email, record.id)
    }
    if (typeof input.phone === 'string') {
      this.usersByPhone.set(input.phone, record.id)
    }
    return record
  }

  async update(user: UserRecord, input: Readonly<Record<string, unknown>>): Promise<UserRecord> {
    const currentEmail = user.email
    if (typeof input.name === 'string' || input.name === undefined) {
      user.name = input.name as string | undefined
    }
    if (typeof input.email === 'string') {
      user.email = input.email
    }
    if (typeof input.avatar === 'string' || input.avatar === null) {
      user.avatar = input.avatar
    }
    if (input.email_verified_at instanceof Date || input.email_verified_at === null) {
      user.email_verified_at = input.email_verified_at
    }
    if (typeof input.password === 'string' || input.password === null) {
      user.password = input.password
    }
    if (currentEmail !== user.email) {
      this.usersByEmail.delete(currentEmail)
      this.usersByEmail.set(user.email, user.id)
    }

    return user
  }

  matchesUser(user: unknown): boolean {
    if (!user || typeof user !== 'object') {
      return false
    }

    const candidateId = (user as { id?: unknown }).id
    return (typeof candidateId === 'number' || typeof candidateId === 'string')
      && this.users.get(Number(candidateId)) === user
  }

  getId(user: UserRecord): string | number {
    return user.id
  }

  getPasswordHash(user: UserRecord): string | null | undefined {
    return user.password
  }

  getEmailVerifiedAt(user: UserRecord): Date | string | null | undefined {
    return user.email_verified_at
  }

  serialize(user: UserRecord): AuthUser {
    const serialized = {
      id: user.id,
      name: user.name ?? '',
      email: user.email,
      role: user.role ?? 'member' as const,
      phone: user.phone,
      country: user.country,
      dob: user.dob,
      avatarUrl: user.avatar ?? null,
      email_verified_at: user.email_verified_at ?? null,
    }
    return serialized
  }
}

class SnapshotProviderAdapter implements AuthProviderAdapter<UserRecord> {
  readonly users = new Map<number, UserRecord>()
  readonly usersByEmail = new Map<string, number>()
  nextId = 1

  async findById(id: string | number): Promise<UserRecord | null> {
    const numericId = typeof id === 'number' ? id : Number.parseInt(String(id), 10)
    const record = this.users.get(numericId)
    return record ? { ...record } : null
  }

  async findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<UserRecord | null> {
    const email = typeof credentials.email === 'string' ? credentials.email : undefined
    if (!email) {
      return null
    }

    const id = this.usersByEmail.get(email)
    const record = typeof id === 'number' ? this.users.get(id) : undefined
    return record ? { ...record } : null
  }

  async create(input: Readonly<Record<string, unknown>>): Promise<UserRecord> {
    const record: UserRecord = {
      id: this.nextId,
      name: typeof input.name === 'string' ? input.name : undefined,
      email: typeof input.email === 'string' ? input.email : '',
      password: typeof input.password === 'string' || input.password === null ? input.password as string | null : undefined,
      avatar: typeof input.avatar === 'string' || input.avatar === null ? input.avatar as string | null : undefined,
      email_verified_at: input.email_verified_at instanceof Date || input.email_verified_at === null
        ? input.email_verified_at as Date | null
        : undefined,
    }
    this.nextId += 1
    this.users.set(record.id, record)
    if (record.email) {
      this.usersByEmail.set(record.email, record.id)
    }
    return { ...record }
  }

  getId(user: UserRecord): string | number {
    return user.id
  }

  getPasswordHash(user: UserRecord): string | null | undefined {
    return user.password
  }

  getEmailVerifiedAt(user: UserRecord): Date | string | null | undefined {
    return user.email_verified_at
  }

  serialize(user: UserRecord): AuthUser {
    const serialized = {
      id: user.id,
      name: user.name ?? '',
      email: user.email,
      role: user.role ?? 'member' as const,
      avatarUrl: user.avatar ?? null,
      email_verified_at: user.email_verified_at ?? null,
    }
    return serialized
  }
}

class InMemoryTokenStore implements AuthTokenStore {
  readonly records = new Map<string, PersonalAccessTokenRecord>()

  async create(record: PersonalAccessTokenRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async findById(id: string): Promise<PersonalAccessTokenRecord | null> {
    return this.records.get(id) ?? null
  }

  async listByUserId(provider: string, userId: string | number): Promise<readonly PersonalAccessTokenRecord[]> {
    return [...this.records.values()].filter(record => record.provider === provider && record.userId === userId)
  }

  async update(record: PersonalAccessTokenRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }

  async deleteByUserId(provider: string, userId: string | number): Promise<number> {
    let deleted = 0
    for (const [id, record] of this.records.entries()) {
      if (record.provider === provider && record.userId === userId) {
        this.records.delete(id)
        deleted += 1
      }
    }

    return deleted
  }
}

class InMemoryEmailVerificationTokenStore implements EmailVerificationTokenStore {
  readonly records = new Map<string, EmailVerificationTokenRecord>()

  async create(record: EmailVerificationTokenRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async findById(id: string): Promise<EmailVerificationTokenRecord | null> {
    return this.records.get(id) ?? null
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }

  async deleteByUserId(provider: string, userId: string | number): Promise<number> {
    let deleted = 0
    for (const [id, record] of this.records.entries()) {
      if (record.provider === provider && record.userId === userId) {
        this.records.delete(id)
        deleted += 1
      }
    }

    return deleted
  }
}

class InMemoryPasswordResetTokenStore implements PasswordResetTokenStore {
  readonly records = new Map<string, PasswordResetTokenRecord>()

  async create(record: PasswordResetTokenRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async findById(id: string): Promise<PasswordResetTokenRecord | null> {
    return this.records.get(id) ?? null
  }

  async findLatestByEmail(provider: string, email: string, options?: { readonly table?: string }): Promise<PasswordResetTokenRecord | null> {
    let latest: PasswordResetTokenRecord | null = null
    for (const record of this.records.values()) {
      if (
        record.provider !== provider
        || record.email !== email
        || (options?.table && record.table !== options.table)
      ) {
        continue
      }
      if (!latest || record.createdAt.getTime() > latest.createdAt.getTime()) {
        latest = record
      }
    }

    return latest
  }

  async delete(id: string, options?: { readonly table?: string }): Promise<void> {
    const existing = this.records.get(id)
    if (existing && options?.table && existing.table !== options.table) {
      return
    }
    this.records.delete(id)
  }

  async deleteByEmail(provider: string, email: string, options?: { readonly table?: string }): Promise<number> {
    let deleted = 0
    for (const [id, record] of this.records.entries()) {
      if (
        record.provider === provider
        && record.email === email
        && (!options?.table || record.table === options.table)
      ) {
        this.records.delete(id)
        deleted += 1
      }
    }

    return deleted
  }
}

function configureRuntime(options: {
  emailVerificationRequired?: boolean
  adminProvider?: InMemoryProviderAdapter
  authConfig?: HoloAuthConfig
  passwordHasher?: NonNullable<Parameters<typeof configureAuthRuntime>[0]>['passwordHasher']
} = {}) {
  const sessionStore = new InMemorySessionStore()
  const tokenStore = new InMemoryTokenStore()
  const emailVerificationTokenStore = new InMemoryEmailVerificationTokenStore()
  const passwordResetTokenStore = new InMemoryPasswordResetTokenStore()
  const deliveries: Array<{ type: 'verification' | 'password-reset', email: string, tokenId: string, tokenValue: string }> = []
  const delivery: AuthDeliveryHook = {
    async sendEmailVerification(input) {
      deliveries.push({
        type: 'verification',
        email: input.email,
        tokenId: input.token.id,
        tokenValue: input.token.plainTextToken,
      })
    },
    async sendPasswordReset(input) {
      deliveries.push({
        type: 'password-reset',
        email: input.email,
        tokenId: input.token.id,
        tokenValue: input.token.plainTextToken,
      })
    },
  }
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
  const adminsProvider = options.adminProvider ?? new InMemoryProviderAdapter()
  const context = authRuntimeInternals.createMemoryAuthContext()

  const baseConfig = defineAuthConfig({
      defaults: {
        guard: 'web',
        passwords: 'users',
      },
      guards: {
        web: {
          driver: 'session',
          provider: 'users',
        },
        admin: {
          driver: 'session',
          provider: 'admins',
        },
        api: {
          driver: 'token',
          provider: 'users',
        },
      },
      providers: {
        users: {
          model: 'User',
        },
        admins: {
          model: 'Admin',
        },
      },
      emailVerification: {
        required: options.emailVerificationRequired === true,
      },
    })

  configureAuthRuntime({
    config: defineAuthConfig({
      ...baseConfig,
      ...options.authConfig,
      defaults: {
        ...baseConfig.defaults,
        ...options.authConfig?.defaults,
      },
      guards: {
        ...baseConfig.guards,
        ...options.authConfig?.guards,
      },
      providers: {
        ...baseConfig.providers,
        ...options.authConfig?.providers,
      },
      passwords: {
        ...options.authConfig?.passwords,
      },
      emailVerification: typeof options.authConfig?.emailVerification === 'undefined'
        ? baseConfig.emailVerification
        : options.authConfig.emailVerification,
    }),
    session: getSessionRuntime(),
    providers: {
      users: usersProvider,
      admins: adminsProvider,
    },
    tokens: tokenStore,
    emailVerificationTokens: emailVerificationTokenStore,
    passwordResetTokens: passwordResetTokenStore,
    delivery,
    context,
    passwordHasher: options.passwordHasher,
  })

  return {
    sessionStore,
    tokenStore,
    emailVerificationTokenStore,
    passwordResetTokenStore,
    usersProvider,
    adminsProvider,
    context,
    deliveries,
  }
}

function reconfigureAuthRuntimeWithSession(
  runtime: ReturnType<typeof configureRuntime>,
  session: unknown,
) {
  configureAuthRuntime({
    config: defineAuthConfig({
      defaults: {
        guard: 'web',
        passwords: 'users',
      },
      guards: {
        web: {
          driver: 'session',
          provider: 'users',
        },
        admin: {
          driver: 'session',
          provider: 'admins',
        },
        api: {
          driver: 'token',
          provider: 'users',
        },
      },
      providers: {
        users: {
          model: 'User',
        },
        admins: {
          model: 'Admin',
        },
      },
    }),
    session: session as NonNullable<Parameters<typeof configureAuthRuntime>[0]>['session'],
    providers: {
      users: runtime.usersProvider,
      admins: runtime.adminsProvider,
    },
    tokens: runtime.tokenStore,
    emailVerificationTokens: runtime.emailVerificationTokenStore,
    passwordResetTokens: runtime.passwordResetTokenStore,
    context: runtime.context,
  })
}

afterEach(() => {
  resetAuthRuntime()
  resetSessionRuntime()
  resetAuthClient()
  vi.unstubAllGlobals()
})

describe('@holo-js/auth package runtime', () => {
  it('declares the optional security package peer dependency', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly peerDependencies?: Record<string, string>
      readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
    }

    expect(packageJson.peerDependencies?.['@holo-js/security']).toBe('^0.1.4')
    expect(packageJson.peerDependenciesMeta?.['@holo-js/security']?.optional).toBe(true)
  })

  it('keeps the client auth entry read-only', () => {
    expect(clientAuth.user).toBeTypeOf('function')
    expect(clientAuth.check).toBeTypeOf('function')
    expect(clientAuth.refreshUser).toBeTypeOf('function')
    expect('login' in clientAuth).toBe(false)
    expect('loginUsing' in clientAuth).toBe(false)
    expect('loginUsingId' in clientAuth).toBe(false)
    expect('hashPassword' in clientAuth).toBe(false)
    expect('verifyPassword' in clientAuth).toBe(false)
    expect('needsPasswordRehash' in clientAuth).toBe(false)
    expect('impersonate' in clientAuth).toBe(false)
    expect('impersonateById' in clientAuth).toBe(false)
    expect('impersonation' in clientAuth).toBe(false)
    expect('stopImpersonating' in clientAuth).toBe(false)
  })

  it('supports default and named exports for default-guard operations', async () => {
    const runtime = configureRuntime()

    expect(auth.check).toBe(check)
    expect(auth.hashPassword).toBe(hashPassword)
    expect(auth.verifyPassword).toBe(verifyPassword)
    expect(auth.needsPasswordRehash).toBe(needsPasswordRehash)
    expect(auth.impersonate).toBe(impersonate)
    expect(auth.impersonateById).toBe(impersonateById)
    expect(auth.impersonation).toBe(impersonation)
    expect(auth.login).toBe(login)
    expect(auth.loginUsing).toBe(loginUsing)
    expect(auth.loginUsingId).toBe(loginUsingId)
    expect(auth.logout).toBe(logout)
    expect(auth.register).toBe(register)
    expect(auth.stopImpersonating).toBe(stopImpersonating)
    expect(auth.refreshUser).toBe(refreshUser)
    expect(auth.currentAccessToken).toBe(currentAccessToken)
    expect(typeof auth.guard('web').check).toBe('function')

    const created = await register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    expect(created).toMatchObject({
      id: 1,
      name: 'Ava',
      email: 'ava@example.com',
    })
    expect(runtime.usersProvider.users.get(1)?.password).toMatch(/^scrypt\$/)
  })

  it('registers users, logs them in, resolves current user state, and logs them out', async () => {
    const runtime = configureRuntime()

    const created = await auth.register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })
    expect(created.id).toBe(1)
    expect(await check()).toBe(false)

    const established = await login({
      email: 'ava@example.com',
      password: 'secret-secret',
      remember: true,
    }) as {
      readonly guard?: string
      readonly sessionId?: string
      readonly rememberToken?: string
      readonly cookies?: readonly string[]
      readonly user?: {
        readonly id?: number
        readonly email?: string
      }
    }

    expect(await check()).toBe(true)
    expect(await id()).toBe(1)
    expect(await user()).toMatchObject({
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
    })
    expect(established).toMatchObject({
      guard: 'web',
      sessionId: expect.any(String),
      rememberToken: expect.stringMatching(/\./),
      user: {
        id: 1,
        email: 'ava@example.com',
      },
    })
    expect(established.cookies).toHaveLength(2)
    expect(established.cookies?.[0]).toContain(`holo_session=${encodeURIComponent(established.sessionId ?? '')}`)
    expect(established.cookies?.[1]).toContain('holo_session_remember=')
    expect(runtime.context.getSessionId('web')).toBeTypeOf('string')
    expect(runtime.context.getRememberToken?.('web')).toMatch(/\./)
    expect(runtime.sessionStore.records.size).toBe(1)

    const loggedOut = await logout()

    expect(await check()).toBe(false)
    expect(await id()).toBeNull()
    expect(await user()).toBeNull()
    expect(runtime.context.getSessionId('web')).toBeUndefined()
    expect(runtime.sessionStore.records.size).toBe(0)
    expect(loggedOut).toMatchObject({
      guard: 'web',
    })
    expect(loggedOut.cookies).toHaveLength(2)
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('holo_session=;'))
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('holo_session_remember=;'))
  })

  it('does not auto-start email verification during registration', async () => {
    const runtime = configureRuntime()

    await expect(register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })).resolves.toMatchObject({
      id: 1,
      email: 'ava@example.com',
    })

    expect(runtime.deliveries).toEqual([])
    expect(runtime.emailVerificationTokenStore.records.size).toBe(0)
  })

  it('supports trusted session login with a user object or user id', async () => {
    const runtime = configureRuntime()

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const establishedByUser = await loginUsing(created, {
      remember: true,
    })

    expect(establishedByUser).toMatchObject({
      guard: 'web',
      sessionId: expect.any(String),
      rememberToken: expect.stringMatching(/\./),
      user: {
        id: created.id,
        email: created.email,
      },
    })
    expect(establishedByUser.cookies).toHaveLength(2)
    expect(await check()).toBe(true)
    expect(await id()).toBe(created.id)
    expect(runtime.context.getSessionId('web')).toBe(establishedByUser.sessionId)
    expect(runtime.sessionStore.records.size).toBe(1)

    await logout()

    const establishedById = await loginUsingId(created.id)
    expect(establishedById).toMatchObject({
      guard: 'web',
      sessionId: expect.any(String),
      user: {
        id: created.id,
        email: created.email,
      },
    })
    expect(establishedById.cookies).toHaveLength(1)
    expect(await user()).toMatchObject({
      id: created.id,
      email: created.email,
    })
  })

  it('rejects trusted login for provider-matched users that no longer exist', async () => {
    const runtime = configureRuntime()

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    Object.assign(runtime.usersProvider, {
      matchesUser(user: unknown) {
        return user === created
      },
    })

    runtime.usersProvider.users.delete(created.id)
    runtime.usersProvider.usersByEmail.delete(created.email)

    await expect(loginUsing(created)).rejects.toThrow(
      `Auth user "users:${created.id}" was not found for trusted login.`,
    )
    await expect(check()).resolves.toBe(false)
  })

  it('supports trusted login on named guards and rejects provider mismatches', async () => {
    const runtime = configureRuntime()
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const established = await auth.guard('admin').loginUsing(admin, {
      remember: true,
    })

    expect(established).toMatchObject({
      guard: 'admin',
      sessionId: expect.any(String),
      rememberToken: expect.stringMatching(/\./),
      user: {
        id: admin.id,
        email: admin.email,
      },
    })
    expect(await auth.guard('admin').user()).toMatchObject({
      id: admin.id,
      email: admin.email,
    })

    await expect(auth.guard('web').loginUsing(admin)).rejects.toThrow('requires a user from provider "users"')
  })

  it('accepts serialized trusted users in multi-provider apps', async () => {
    const runtime = configureRuntime()
    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(loginUsing({
      id: created.id,
      email: created.email,
    })).resolves.toMatchObject({
      guard: 'web',
      user: {
        id: created.id,
        email: created.email,
      },
    })

    await logout()

    await loginUsing(created)

    await expect(impersonate({
      id: created.id,
      email: created.email,
    })).resolves.toMatchObject({
      guard: 'web',
      user: {
        id: created.id,
        email: created.email,
      },
    })
  })

  it('rejects ambiguous trusted user objects when multiple providers are configured', async () => {
    const runtime = configureRuntime()
    Object.assign(runtime.adminsProvider, {
      matchesUser: undefined,
    })

    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(auth.guard('web').loginUsing(admin)).rejects.toThrow(
      'Pass a user id, a serialized auth user, or implement matchesUser() on the provider adapter.',
    )
    await expect(auth.guard('web').check()).resolves.toBe(false)
  })

  it('exposes public password hashing helpers', async () => {
    configureRuntime()

    const digest = await hashPassword('secret-secret')

    expect(digest).toMatch(/^scrypt\$/)
    await expect(verifyPassword('secret-secret', digest)).resolves.toBe(true)
    await expect(verifyPassword('wrong-secret', digest)).resolves.toBe(false)
    await expect(needsPasswordRehash(digest)).resolves.toBe(false)
  })

  it('supports impersonation within the same guard and restores the original user', async () => {
    const runtime = configureRuntime()
    const actor = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const target = await runtime.usersProvider.create({
      name: 'Mina',
      email: 'mina@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(actor)

    const established = await impersonate(target, {
      remember: true,
    })

    expect(established).toMatchObject({
      guard: 'web',
      user: {
        id: target.id,
        email: target.email,
      },
    })
    expect(await user()).toMatchObject({
      id: target.id,
      email: target.email,
    })
    expect(await impersonation()).toMatchObject({
      guard: 'web',
      actorGuard: 'web',
      user: {
        id: target.id,
        email: target.email,
      },
      actor: {
        id: actor.id,
        email: actor.email,
      },
      originalUser: {
        id: actor.id,
        email: actor.email,
      },
    })

    const restored = await stopImpersonating()
    expect(restored).toMatchObject({
      id: actor.id,
      email: actor.email,
    })
    expect(await user()).toMatchObject({
      id: actor.id,
      email: actor.email,
    })
    expect(await impersonation()).toBeNull()
  })

  it('preserves remember-me session state when impersonation stops', async () => {
    const runtime = configureRuntime()
    const actor = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const target = await runtime.usersProvider.create({
      name: 'Mina',
      email: 'mina@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(actor, {
      remember: true,
    })

    const originalSessionId = runtime.context.getSessionId('web')
    const originalRecord = originalSessionId
      ? runtime.sessionStore.records.get(originalSessionId)
      : null
    expect(originalRecord?.rememberTokenHash).toBeTypeOf('string')

    const impersonated = await impersonate(target)

    const duringImpersonation = runtime.sessionStore.records.get(impersonated.sessionId)
    expect(duringImpersonation).toMatchObject({
      id: impersonated.sessionId,
    })
    expect(duringImpersonation?.rememberTokenHash).toBeTypeOf('string')
    expect(duringImpersonation?.rememberTokenHash).not.toBe(originalRecord?.rememberTokenHash)
    expect(impersonated.rememberToken).toMatch(/\./)
    expect(impersonated.cookies).toContainEqual(expect.stringContaining('holo_session_remember='))
    expect(impersonated.cookies).toHaveLength(2)

    await stopImpersonating()

    const afterStop = runtime.sessionStore.records.get(impersonated.sessionId)
    expect(afterStop).toMatchObject({
      id: impersonated.sessionId,
    })
    expect(afterStop?.rememberTokenHash).toBe(duringImpersonation?.rememberTokenHash)
    expect(afterStop?.createdAt).toEqual(duringImpersonation?.createdAt)
    expect(afterStop?.expiresAt).toEqual(duringImpersonation?.expiresAt)
  })

  it('does not keep remember-me state when a normal login opts out of remember', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date(),
    })

    const remembered = await login({
      email: 'ava@example.com',
      password: 'secret-secret',
      remember: true,
    })

    const rememberedRecord = runtime.sessionStore.records.get(remembered.sessionId)
    expect(rememberedRecord?.rememberTokenHash).toBeTypeOf('string')

    const loggedInAgain = await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    const nextRecord = runtime.sessionStore.records.get(loggedInAgain.sessionId)
    expect(loggedInAgain.cookies).toHaveLength(1)
    expect(loggedInAgain.rememberToken).toBeUndefined()
    expect(runtime.context.getRememberToken?.('web')).toBeUndefined()
    expect(nextRecord?.rememberTokenHash).toBeUndefined()
  })

  it('supports impersonation across guards and removes the impersonated guard on stop', async () => {
    const runtime = configureRuntime()
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const target = await runtime.usersProvider.create({
      name: 'Mina',
      email: 'mina@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await auth.guard('admin').loginUsing(admin)

    const established = await auth.guard('web').impersonateById(target.id, {
      actorGuard: 'admin',
    })

    expect(established).toMatchObject({
      guard: 'web',
      user: {
        id: target.id,
        email: target.email,
      },
    })
    expect(await auth.guard('web').user()).toMatchObject({
      id: target.id,
      email: target.email,
    })
    expect(await auth.guard('admin').user()).toMatchObject({
      id: admin.id,
      email: admin.email,
    })
    expect(await auth.guard('web').impersonation()).toMatchObject({
      guard: 'web',
      actorGuard: 'admin',
      actor: {
        id: admin.id,
        email: admin.email,
      },
      user: {
        id: target.id,
        email: target.email,
      },
      originalUser: null,
    })

    await expect(auth.guard('web').impersonateById(target.id, {
      actorGuard: 'admin',
    })).rejects.toThrow('already impersonating')

    const stopped = await auth.guard('web').stopImpersonating()
    expect(stopped).toBeNull()
    expect(await auth.guard('web').user()).toBeNull()
    expect(await auth.guard('web').impersonation()).toBeNull()
    expect(await auth.guard('admin').user()).toMatchObject({
      id: admin.id,
      email: admin.email,
    })
  })

  it('rejects duplicate registration and mismatched password confirmation', async () => {
    configureRuntime()

    await register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    await expect(register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })).rejects.toThrow('already exists')

    await expect(register({
      name: 'Mina',
      email: 'mina@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'different-secret',
    })).rejects.toThrow('Password confirmation does not match')
  })

  it('accepts non-email credentials when the application passes validated input', async () => {
    const runtime = configureRuntime({
      authConfig: defineAuthConfig({
        providers: {
          users: {
            model: 'User',
            identifiers: ['phone'],
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
    })

    const created = await register({
      phone: '45545454',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    expect(created.id).toBe(1)

    await login({
      phone: '45545454',
      password: 'secret-secret',
    })

    expect(await check()).toBe(true)
    expect(runtime.usersProvider.usersByPhone.get('45545454')).toBe(1)
  })

  it('uses configured provider identifiers instead of arbitrary profile fields', async () => {
    const runtime = configureRuntime({
      authConfig: defineAuthConfig({
        providers: {
          users: {
            model: 'User',
            identifiers: ['email', 'phone'],
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
    })
    const findByCredentials = runtime.usersProvider.findByCredentials.bind(runtime.usersProvider)
    Object.assign(runtime.usersProvider, {
      async findByCredentials(credentials: Readonly<Record<string, unknown>>) {
        return Object.keys(credentials).length === 1
          ? findByCredentials(credentials)
          : null
      },
    })

    await register({
      name: 'Ava',
      email: 'ava@example.com',
      phone: '45545454',
      country: 'EG',
      dob: '1995-02-20',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    await expect(register({
      name: 'Mina',
      email: 'ava@example.com',
      phone: '99999999',
      country: 'US',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })).rejects.toThrow('email already exists')

    await expect(register({
      name: 'Noor',
      email: 'noor@example.com',
      phone: '45545454',
      country: 'SA',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })).rejects.toThrow('phone already exists')

    await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    expect(await check()).toBe(true)

    await logout()

    await login({
      email: 'ava@example.com',
      phone: '00000000',
      password: 'secret-secret',
    })
    expect(await check()).toBe(true)

    await logout()

    await login({
      phone: '45545454',
      password: 'secret-secret',
    })
    expect(await check()).toBe(true)
    expect(runtime.usersProvider.usersByEmail.get('ava@example.com')).toBe(1)
    expect(runtime.usersProvider.usersByPhone.get('45545454')).toBe(1)
  })

  it('rejects registration and login when none of the configured identifiers are present', async () => {
    configureRuntime({
      authConfig: defineAuthConfig({
        providers: {
          users: {
            model: 'User',
            identifiers: ['email', 'phone'],
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
    })

    await expect(register({
      name: 'Ava',
      country: 'EG',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })).rejects.toThrow('configured identifier field: email, phone')

    await expect(login({
      country: 'EG',
      password: 'secret-secret',
    })).rejects.toThrow('configured identifier field: email, phone')
  })

  it('rejects missing users, bad passwords, and unverified logins when verification is required', async () => {
    const runtime = configureRuntime({
      emailVerificationRequired: true,
    })

    const verifiedPassword = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: verifiedPassword,
      email_verified_at: null,
    })

    await expect(login({
      email: 'missing@example.com',
      password: 'secret-secret',
    })).rejects.toThrow('Invalid credentials')

    await expect(login({
      email: 'ava@example.com',
      password: 'bad-password',
    })).rejects.toThrow('Invalid credentials')

    await expect(login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })).rejects.toThrow('Email verification is required before login')

    runtime.usersProvider.users.get(1)!.email_verified_at = new Date('2026-04-08T00:00:00.000Z')
    await expect(login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })).resolves.toMatchObject({
      guard: 'web',
      sessionId: expect.any(String),
    })
  })

  it('creates, expires, rejects, and consumes email verification tokens', async () => {
    const runtime = configureRuntime()
    const created = await register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    const token = await verification.create(created)
    expect(token.plainTextToken).toContain('.')
    expect(runtime.deliveries).toHaveLength(1)
    expect(runtime.deliveries[0]).toMatchObject({
      type: 'verification',
      email: 'ava@example.com',
      tokenId: token.id,
    })
    expect(runtime.deliveries[0]?.tokenValue).toBe(token.plainTextToken)

    await expect(verification.consume('bad-token')).rejects.toThrow('Invalid email verification token')
    await expect(verification.consume(`${token.id}.wrong-secret`)).rejects.toThrow('Invalid or expired email verification token')

    const verified = await verification.consume(token.plainTextToken)
    expect(verified).toMatchObject({
      id: 1,
      email: 'ava@example.com',
    })
    expect(runtime.usersProvider.users.get(1)?.email_verified_at).toBeInstanceOf(Date)
    expect(runtime.emailVerificationTokenStore.records.size).toBe(0)

    await expect(verification.consume(token.plainTextToken)).rejects.toThrow('Invalid or expired email verification token')

    const expired = await verification.create(created, {
      expiresAt: new Date('2026-04-07T00:00:00.000Z'),
    })
    await expect(verification.consume(expired.plainTextToken)).rejects.toThrow('Invalid or expired email verification token')
  })

  it('fails verification and password reset flows when a provider cannot persist user changes', async () => {
    const sessionStore = new InMemorySessionStore()
    const emailVerificationTokenStore = new InMemoryEmailVerificationTokenStore()
    const passwordResetTokenStore = new InMemoryPasswordResetTokenStore()
    const usersProvider = new SnapshotProviderAdapter()
    const deliveries: Array<{ readonly type: 'verification' | 'password-reset', readonly tokenValue: string }> = []

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
          web: {
            driver: 'session',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
        },
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 0,
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: usersProvider,
      },
      emailVerificationTokens: emailVerificationTokenStore,
      passwordResetTokens: passwordResetTokenStore,
      delivery: {
        async sendEmailVerification(input) {
          deliveries.push({
            type: 'verification',
            tokenValue: input.token.plainTextToken,
          })
        },
        async sendPasswordReset(input) {
          deliveries.push({
            type: 'password-reset',
            tokenValue: input.token.plainTextToken,
          })
        },
      },
      context: authRuntimeInternals.createMemoryAuthContext(),
    })

    const initialPassword = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    const created = await usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: initialPassword,
      email_verified_at: null,
    })

    const verificationToken = await verification.create(created)
    await expect(verification.consume(verificationToken.plainTextToken)).rejects.toThrow('must implement update()')
    expect(usersProvider.users.get(1)?.email_verified_at).toBeNull()

    await passwords.request('ava@example.com')
    const resetDelivery = deliveries.find(delivery => delivery.type === 'password-reset')
    expect(resetDelivery).toBeDefined()
    await expect(passwords.consume({
      token: resetDelivery!.tokenValue,
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })).rejects.toThrow('must implement update()')
    await expect(
      authRuntimeInternals.createDefaultPasswordHasher().verify(
        'secret-secret',
        usersProvider.users.get(1)?.password ?? '',
      ),
    ).resolves.toBe(true)
  })

  it('creates, invalidates, and consumes password reset tokens', async () => {
    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 0,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')
    expect(runtime.deliveries).toHaveLength(1)
    const firstDelivery = runtime.deliveries[0]!
    expect(firstDelivery.type).toBe('password-reset')

    await expect(passwords.consume({
      token: 'bad-token',
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })).rejects.toThrow('Invalid password reset token')

    await expect(passwords.consume({
      token: firstDelivery.tokenValue,
      password: 'new-secret',
    } as never)).rejects.toThrow('Password confirmation does not match')

    await expect(passwords.consume({
      token: firstDelivery.tokenValue,
      password: 'new-secret',
      passwordConfirmation: 'wrong-secret',
    })).rejects.toThrow('Password confirmation does not match')

    await passwords.request('ava@example.com')
    expect(runtime.deliveries).toHaveLength(2)
    await expect(passwords.consume({
      token: firstDelivery.tokenValue,
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })).rejects.toThrow('Invalid or expired password reset token')

    const activeDelivery = runtime.deliveries[1]!
    const resetUser = await passwords.consume({
      token: activeDelivery.tokenValue,
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })
    expect(resetUser).toMatchObject({
      email: 'ava@example.com',
    })
    expect(runtime.passwordResetTokenStore.records.size).toBe(0)
    await expect(login({
      email: 'ava@example.com',
      password: 'new-secret',
    })).resolves.toMatchObject({
      guard: 'web',
      sessionId: expect.any(String),
    })

    await passwords.request('ava@example.com', {
      expiresAt: new Date('2026-04-07T00:00:00.000Z'),
    })
    const expiredDelivery = runtime.deliveries[2]!
    await expect(passwords.consume({
      token: expiredDelivery.tokenValue,
      password: 'another-secret',
      passwordConfirmation: 'another-secret',
    })).rejects.toThrow('Invalid or expired password reset token')
  })

  it('refreshes the session idle timeout when resolving a session-backed user', async () => {
    const runtime = configureRuntime()
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
        idleTimeout: 1,
        absoluteLifetime: 120,
        rememberMeLifetime: 43200,
      },
      stores: {
        database: runtime.sessionStore,
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const established = await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    const initialRecord = runtime.sessionStore.records.get(established.sessionId)
    expect(initialRecord).toBeDefined()

    await new Promise(resolve => setTimeout(resolve, 20))

    const resolvedUser = await user()
    const refreshedRecord = runtime.sessionStore.records.get(established.sessionId)

    expect(resolvedUser).toMatchObject({
      email: 'ava@example.com',
    })
    expect(refreshedRecord).toBeDefined()
    expect(refreshedRecord!.lastActivityAt.getTime()).toBeGreaterThan(initialRecord!.lastActivityAt.getTime())
    expect(refreshedRecord!.expiresAt.getTime()).toBeGreaterThan(initialRecord!.expiresAt.getTime())
  })

  it('rejects registration when password confirmation is omitted', async () => {
    configureRuntime()

    await expect(register({
      email: 'ava@example.com',
      password: 'secret-secret',
    } as never)).rejects.toThrow('Password confirmation does not match')
  })

  it('keeps password reset tokens scoped to their configured broker table', async () => {
    const runtime = configureRuntime({
      authConfig: {
        defaults: {
          passwords: 'admins',
        },
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
          admins: {
            provider: 'users',
            table: 'admin_password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com', {
      broker: 'users',
    })
    await passwords.request('ava@example.com', {
      broker: 'admins',
    })

    const records = Array.from(runtime.passwordResetTokenStore.records.values())
    expect(records).toHaveLength(2)
    expect(records.map(record => record.table).sort()).toEqual([
      'admin_password_reset_tokens',
      'password_reset_tokens',
    ])

    const userBrokerToken = runtime.deliveries[0]!.tokenValue
    await expect(passwords.consume({
      token: userBrokerToken,
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })).resolves.toMatchObject({
      email: 'ava@example.com',
    })

    const remainingRecords = Array.from(runtime.passwordResetTokenStore.records.values())
    expect(remainingRecords).toHaveLength(1)
    expect(remainingRecords[0]?.table).toBe('admin_password_reset_tokens')
  })

  it('honors password reset throttle windows without rotating the active token', async () => {
    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')
    expect(runtime.deliveries).toHaveLength(1)
    const firstDelivery = runtime.deliveries[0]!
    const firstRecord = runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)

    await passwords.request('ava@example.com')

    expect(runtime.deliveries).toHaveLength(1)
    expect(runtime.passwordResetTokenStore.records.size).toBe(1)
    expect(runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)).toBe(firstRecord)
  })

  it('prefers the shared security rate-limit store for password reset throttling when available', async () => {
    const attempts = new Map<string, number>()
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async (key: string) => {
              attempts.delete(key)
              return true
            }),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')
    expect(runtime.deliveries).toHaveLength(1)

    const firstDelivery = runtime.deliveries[0]
    if (!firstDelivery) {
      throw new Error('Expected first password reset delivery.')
    }

    const activeRecord = runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)
    if (!activeRecord) {
      throw new Error('Expected active password reset token record.')
    }

    runtime.passwordResetTokenStore.records.set(firstDelivery.tokenId, Object.freeze({
      ...activeRecord,
      createdAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
    }))

    await passwords.request('ava@example.com')

    expect(hit).toHaveBeenCalledTimes(2)
    expect(hit).toHaveBeenNthCalledWith(1, `auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('ava@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(runtime.deliveries).toHaveLength(1)
    expect(runtime.passwordResetTokenStore.records.size).toBe(1)
  })

  it('keys shared password reset throttles with the CSRF signing key when available', async () => {
    const hit = vi.fn(async (_key: string, _options: { readonly maxAttempts: number, readonly decaySeconds: number }) => ({
      limited: false,
    }))

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => true),
          },
          csrfSigningKey: 'signing-key',
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    expect(hit).toHaveBeenCalledWith(
      `auth:password-reset:${createHash('sha256').update('signing-key').digest('hex').slice(0, 16)}:users:users:password_reset_tokens:${hashPasswordResetEmail('ava@example.com', 'signing-key')}`,
      {
        maxAttempts: 1,
        decaySeconds: 3600,
      },
    )
  })

  it('releases shared password reset reservations when token persistence fails', async () => {
    const attempts = new Map<string, number>()
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async (key: string) => {
              attempts.delete(key)
              return true
            }),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    const create = vi.spyOn(runtime.passwordResetTokenStore, 'create')
    create.mockRejectedValueOnce(new Error('token persistence failed'))
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await expect(passwords.request('ava@example.com')).rejects.toThrow('token persistence failed')

    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()

    expect(findByCredentials).toHaveBeenCalledTimes(2)
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('deletes freshly created password reset tokens when delivery fails', async () => {
    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const bindings = authRuntimeInternals.getRuntimeBindings()
    const originalSendPasswordReset = bindings.delivery.sendPasswordReset
    bindings.delivery.sendPasswordReset = vi.fn(async () => {
      throw new Error('delivery failed')
    })

    await expect(passwords.request('ava@example.com')).rejects.toThrow('delivery failed')
    expect(runtime.passwordResetTokenStore.records.size).toBe(0)

    bindings.delivery.sendPasswordReset = originalSendPasswordReset

    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()
    expect(runtime.deliveries).toHaveLength(1)
    expect(runtime.passwordResetTokenStore.records.size).toBe(1)
  })

  it('preserves the original delivery error when password reset cleanup fails', async () => {
    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const bindings = authRuntimeInternals.getRuntimeBindings()
    const originalSendPasswordReset = bindings.delivery.sendPasswordReset
    const deleteSpy = vi.spyOn(runtime.passwordResetTokenStore, 'delete').mockRejectedValueOnce(new Error('cleanup failed'))
    bindings.delivery.sendPasswordReset = vi.fn(async () => {
      throw new Error('delivery failed')
    })

    await expect(passwords.request('ava@example.com')).rejects.toThrow('delivery failed')
    expect(deleteSpy).toHaveBeenCalledTimes(1)

    bindings.delivery.sendPasswordReset = originalSendPasswordReset
    deleteSpy.mockRestore()
  })

  it('keeps a failed password reset reserved when clearing the throttle entry throws', async () => {
    const attempts = new Map<string, number>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => {
              throw new Error('reservation cleanup failed')
            }),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    findByCredentials.mockRejectedValueOnce(new Error('provider lookup failed'))

    await expect(passwords.request('ava@example.com')).rejects.toThrow('provider lookup failed')
    expect(hit).toHaveBeenCalledTimes(1)
    expect((globalThis as typeof globalThis & {
      __holoAuthRuntime__?: { sharedPasswordResetThrottleFailures?: Set<string> }
    }).__holoAuthRuntime__?.sharedPasswordResetThrottleFailures?.size).toBe(0)

    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()

    expect(hit).toHaveBeenCalledTimes(2)
    expect(findByCredentials).toHaveBeenCalledTimes(1)
    expect((globalThis as typeof globalThis & {
      __holoAuthRuntime__?: { sharedPasswordResetThrottleFailures?: Set<string> }
    }).__holoAuthRuntime__?.sharedPasswordResetThrottleFailures?.size).toBe(0)
    expect(runtime.deliveries).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[@holo-js/auth] Failed to clear a password reset reservation after use.',
      expect.objectContaining({ message: 'reservation cleanup failed' }),
    )
  })

  it('does not let unknown-email probes consume the shared password reset limiter', async () => {
    const attempts = new Map<string, number>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => {
              throw new Error('reservation cleanup failed')
            }),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('missing@example.com')
    expect(runtime.deliveries).toHaveLength(0)

    await passwords.request('ava@example.com')

    expect(runtime.deliveries).toHaveLength(1)
    expect(hit).toHaveBeenCalledTimes(2)
    expect(hit).toHaveBeenNthCalledWith(1, `auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('missing@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(hit).toHaveBeenNthCalledWith(2, `auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('ava@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[@holo-js/auth] Failed to clear a password reset reservation after use.',
      expect.objectContaining({ message: 'reservation cleanup failed' }),
    )
  })

  it('keeps the shared password reset bypass for stores without clear support', async () => {
    const hit = vi.fn(async () => ({
      limited: false,
    }))

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    findByCredentials.mockRejectedValueOnce(new Error('provider lookup failed'))

    await expect(passwords.request('ava@example.com')).rejects.toThrow('provider lookup failed')
    expect(hit).toHaveBeenCalledTimes(1)

    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()

    expect(hit).toHaveBeenCalledTimes(1)
    expect(findByCredentials).toHaveBeenCalledTimes(2)
    expect((globalThis as typeof globalThis & {
      __holoAuthRuntime__?: { sharedPasswordResetThrottleFailures?: Set<string> }
    }).__holoAuthRuntime__?.sharedPasswordResetThrottleFailures?.size).toBe(0)
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('does not bypass the shared limiter for unknown-email probes when clear support is unavailable', async () => {
    const attempts = new Map<string, number>()
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })

    await passwords.request('missing@example.com')
    expect(runtime.deliveries).toHaveLength(0)

    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Missing User',
      email: 'missing@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('missing@example.com')

    expect(hit).toHaveBeenCalledTimes(2)
    expect(hit).toHaveBeenNthCalledWith(1, `auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('missing@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(hit).toHaveBeenNthCalledWith(2, `auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('missing@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(runtime.deliveries).toHaveLength(0)
  })

  it('stops password reset delivery when the shared limiter is already active for a known user without a local token', async () => {
    const attempts = new Map<string, number>([
      [`auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('ava@example.com')}`, 1],
    ])
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => true),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    expect(runtime.deliveries).toHaveLength(0)
    expect(runtime.passwordResetTokenStore.records.size).toBe(0)
    expect(hit).toHaveBeenCalledTimes(1)
    expect(hit).toHaveBeenCalledWith(`auth:password-reset:users:users:password_reset_tokens:${hashPasswordResetEmail('ava@example.com')}`, {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
  })

  it('namespaces shared password reset limiter buckets across apps using the same store', async () => {
    const hit = vi.fn(async (_key: string, _options: { readonly maxAttempts: number, readonly decaySeconds: number }) => ({
      limited: false,
    }))

    const sharedBindings = new Map<string, {
      readonly rateLimitStore: {
        hit: typeof hit
        clear: () => Promise<boolean>
      }
      readonly csrfSigningKey: string
    }>([
      ['app-a', { rateLimitStore: { hit, clear: vi.fn(async () => true) }, csrfSigningKey: 'app-a' }],
      ['app-b', { rateLimitStore: { hit, clear: vi.fn(async () => true) }, csrfSigningKey: 'app-b' }],
    ])

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return sharedBindings.get((globalThis as typeof globalThis & { __holoActiveAppKey__?: string }).__holoActiveAppKey__ ?? 'app-a')
      },
    })

    ;(globalThis as typeof globalThis & { __holoActiveAppKey__?: string }).__holoActiveAppKey__ = 'app-a'
    const firstRuntime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await firstRuntime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    resetAuthRuntime()
    resetSessionRuntime()

    ;(globalThis as typeof globalThis & { __holoActiveAppKey__?: string }).__holoActiveAppKey__ = 'app-b'
    const secondRuntime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    await secondRuntime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    expect(hit).toHaveBeenCalledTimes(2)
    expect(hit).toHaveBeenNthCalledWith(1, expect.stringMatching(/^auth:password-reset:[0-9a-f]{16}:users:users:password_reset_tokens:[0-9a-f]{64}$/), {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(hit).toHaveBeenNthCalledWith(2, expect.stringMatching(/^auth:password-reset:[0-9a-f]{16}:users:users:password_reset_tokens:[0-9a-f]{64}$/), {
      maxAttempts: 1,
      decaySeconds: 3600,
    })
    expect(hit.mock.calls[0]?.[0]).not.toBe(hit.mock.calls[1]?.[0])
  })

  it('skips provider lookups once password reset throttling is active in the shared security store', async () => {
    const attempts = new Map<string, number>()
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => true),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')
    expect(findByCredentials).toHaveBeenCalledTimes(1)

    const firstDelivery = runtime.deliveries[0]
    if (!firstDelivery) {
      throw new Error('Expected first password reset delivery.')
    }

    const activeRecord = runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)
    if (!activeRecord) {
      throw new Error('Expected active password reset token record.')
    }

    runtime.passwordResetTokenStore.records.set(firstDelivery.tokenId, Object.freeze({
      ...activeRecord,
      createdAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
    }))

    await passwords.request('ava@example.com')

    expect(hit).toHaveBeenCalledTimes(2)
    expect(findByCredentials).toHaveBeenCalledTimes(1)
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('falls back to the provider lookup path when no shared rate-limit store is configured', async () => {
    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return undefined
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    expect(findByCredentials).toHaveBeenCalledTimes(1)
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('skips shared limiter checks when an existing password reset token has no shared store available', async () => {
    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: undefined,
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')
    const firstDelivery = runtime.deliveries[0]
    if (!firstDelivery) {
      throw new Error('Expected first password reset delivery.')
    }

    const activeRecord = runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)
    if (!activeRecord) {
      throw new Error('Expected active password reset token record.')
    }

    runtime.passwordResetTokenStore.records.set(firstDelivery.tokenId, Object.freeze({
      ...activeRecord,
      createdAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
    }))

    await passwords.request('ava@example.com')

    expect(runtime.deliveries).toHaveLength(2)
  })

  it('skips provider lookups when the shared password reset limiter is already active without a token row', async () => {
    const hit = vi.fn(async () => ({
      limited: true,
    }))

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear: vi.fn(async () => true),
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await passwords.request('ava@example.com')

    expect(hit).toHaveBeenCalledTimes(1)
    expect(findByCredentials).not.toHaveBeenCalled()
    expect(runtime.deliveries).toHaveLength(0)
  })

  it('rethrows unexpected optional security import failures during password reset throttling', async () => {
    const runtime = configureRuntime()
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    vi.stubGlobal('__holoAuthSecurityImport__', async () => {
      throw 'boom'
    })

    await expect(passwords.request('ava@example.com')).rejects.toBe('boom')

    vi.stubGlobal('__holoAuthSecurityImport__', async () => {
      throw new Error('security import exploded')
    })

    await expect(passwords.request('ava@example.com')).rejects.toThrow('security import exploded')

    vi.stubGlobal('__holoAuthSecurityImport__', async () => {
      throw new Error('Could not resolve "@holo-js/other"')
    })

    await expect(passwords.request('ava@example.com')).rejects.toThrow('Could not resolve "@holo-js/other"')
  })

  it('treats resolver-style optional security import failures as missing packages during password reset throttling', async () => {
    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    vi.stubGlobal('__holoAuthSecurityImport__', async () => {
      throw new Error('Could not resolve "@holo-js/security"')
    })

    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('returns cached users from user() and refetches with refreshUser()', async () => {
    const runtime = configureRuntime()
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    expect(await user()).toMatchObject({
      name: 'Ava',
    })

    runtime.usersProvider.users.get(1)!.name = 'Ava Updated'

    expect(await user()).toMatchObject({
      name: 'Ava',
    })
    expect(await refreshUser()).toMatchObject({
      name: 'Ava Updated',
    })
  })

  it('releases shared password reset probes when an expired-token retry fails', async () => {
    const attempts = new Map<string, number>()
    const clear = vi.fn(async (key: string) => {
      attempts.delete(key)
      return true
    })
    const hit = vi.fn(async (key: string, options: { readonly maxAttempts: number }) => {
      const next = (attempts.get(key) ?? 0) + 1
      attempts.set(key, next)

      return {
        limited: next > options.maxAttempts,
      }
    })

    vi.stubGlobal('__holoAuthSecurityModule__', {
      getSecurityRuntimeBindings() {
        return {
          rateLimitStore: {
            hit,
            clear,
          },
        }
      },
    })

    const runtime = configureRuntime({
      authConfig: {
        passwords: {
          users: {
            provider: 'users',
            table: 'password_reset_tokens',
            expire: 60,
            throttle: 60,
          },
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    runtime.passwordResetTokenStore.records.set('reset-1', Object.freeze({
      id: 'reset-1',
      provider: 'users',
      email: 'ava@example.com',
      table: 'password_reset_tokens',
      tokenHash: 'expired-token-hash',
      createdAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
      expiresAt: new Date(Date.now() - (60 * 1000)),
    }))

    const findByCredentials = vi.spyOn(runtime.usersProvider, 'findByCredentials')
    findByCredentials.mockRejectedValueOnce(new Error('provider lookup failed'))

    await expect(passwords.request('ava@example.com')).rejects.toThrow('provider lookup failed')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(attempts.size).toBe(0)
    await expect(passwords.request('ava@example.com')).resolves.toBeUndefined()

    expect(findByCredentials).toHaveBeenCalledTimes(2)
    expect(runtime.deliveries).toHaveLength(1)
  })

  it('supports multiple guards and distinct providers safely', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: await hasher.hash('admin-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    await auth.guard('admin').login({
      email: 'admin@example.com',
      password: 'admin-secret',
    })

    expect(await auth.guard('web').user()).toMatchObject({
      name: 'User Ava',
    })
    expect(await auth.guard('admin').user()).toMatchObject({
      name: 'Admin Mina',
    })
    expect(await auth.user()).toMatchObject({
      name: 'User Ava',
    })

    const loggedOut = await auth.guard('admin').logout()
    expect(await auth.guard('admin').check()).toBe(false)
    expect(await auth.guard('web').check()).toBe(true)
    expect(loggedOut.cookies).toHaveLength(0)
  })

  it('clears configured hosted provider cookies through the same logout api', async () => {
    const runtime = configureRuntime({
      authConfig: {
        clerk: {
          app: {
            sessionCookie: '__session',
            guard: 'web',
          },
        },
        workos: {
          dashboard: {
            sessionCookie: 'wos-session',
            guard: 'web',
          },
        },
      },
    })

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(created, {
      remember: true,
    })

    const loggedOut = await logout()

    expect(loggedOut.cookies).toHaveLength(4)
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('holo_session=;'))
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('holo_session_remember=;'))
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('__session=;'))
    expect(loggedOut.cookies).toContainEqual(expect.stringContaining('wos-session=;'))
  })

  it('supports logout with legacy session bindings that only expose named cookie helpers', async () => {
    const runtime = configureRuntime()
    const session = getSessionRuntime()
    const legacySession = {
      create: session.create,
      read: session.read,
      touch: session.touch,
      invalidate: session.invalidate,
      issueRememberMeToken: session.issueRememberMeToken,
      sessionCookie: session.sessionCookie,
      rememberMeCookie: session.rememberMeCookie,
    }
    reconfigureAuthRuntimeWithSession(runtime, legacySession)

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(created, {
      remember: true,
    })

    await expect(logout()).resolves.toMatchObject({
      guard: 'web',
    })
  })

  it('clears hosted provider cookies without inheriting custom app session scope', async () => {
    const runtime = configureRuntime({
      authConfig: {
        clerk: {
          app: {
            sessionCookie: '__session',
            guard: 'web',
          },
        },
        workos: {
          dashboard: {
            sessionCookie: 'wos-session',
            guard: 'web',
          },
        },
      },
    })

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
          path: '/app',
          domain: 'app.test',
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
        database: runtime.sessionStore,
      },
    })

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(created, {
      remember: true,
    })

    const loggedOut = await logout()
    const clerkCookie = loggedOut.cookies.find(cookie => cookie.includes('__session=;'))
    const workosCookie = loggedOut.cookies.find(cookie => cookie.includes('wos-session=;'))

    expect(clerkCookie).toContain('Path=/')
    expect(clerkCookie).not.toContain('Path=/app')
    expect(clerkCookie).not.toContain('Domain=app.test')
    expect(workosCookie).toContain('Path=/')
    expect(workosCookie).not.toContain('Path=/app')
    expect(workosCookie).not.toContain('Domain=app.test')
  })

  it('keeps multiple session guards authenticated when they share the same browser session cookie', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: await hasher.hash('admin-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const webSession = await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    const originalRecord = runtime.sessionStore.records.get(webSession.sessionId)
    expect(originalRecord).toBeTruthy()
    const agedCreatedAt = new Date(Date.now() - (110 * 60 * 1000))
    const agedLastActivityAt = new Date(Date.now() - (109 * 60 * 1000))
    const agedExpiresAt = new Date(Date.now() + (60 * 1000))

    if (originalRecord) {
      runtime.sessionStore.records.set(webSession.sessionId, Object.freeze({
        ...originalRecord,
        createdAt: agedCreatedAt,
        lastActivityAt: agedLastActivityAt,
        expiresAt: agedExpiresAt,
      }))
    }

    runtime.context.setSessionId('admin', webSession.sessionId)

    const adminSession = await auth.guard('admin').login({
      email: 'admin@example.com',
      password: 'admin-secret',
    })

    expect(adminSession.sessionId).toBe(webSession.sessionId)
    expect(runtime.sessionStore.records).toHaveLength(1)
    const renewedRecord = runtime.sessionStore.records.get(adminSession.sessionId)
    expect(renewedRecord).toBeTruthy()
    expect(renewedRecord?.createdAt.getTime()).not.toBe(agedCreatedAt.getTime())
    expect(renewedRecord?.lastActivityAt.getTime()).not.toBe(agedLastActivityAt.getTime())
    expect(renewedRecord?.expiresAt.getTime()).not.toBe(agedExpiresAt.getTime())
    expect(renewedRecord?.createdAt.getTime()).toBeGreaterThan(agedCreatedAt.getTime())
    expect(renewedRecord?.expiresAt.getTime()).toBeGreaterThan(agedExpiresAt.getTime())
    expect((renewedRecord?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(60 * 60 * 1000)

    resetAuthRuntime()
    const restartedContext = authRuntimeInternals.createMemoryAuthContext()
    restartedContext.setSessionId('web', webSession.sessionId)
    restartedContext.setSessionId('admin', webSession.sessionId)
    configureAuthRuntime({
      config: defineAuthConfig({
        defaults: {
          guard: 'web',
          passwords: 'users',
        },
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          admin: {
            driver: 'session',
            provider: 'admins',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
        admins: runtime.adminsProvider,
      },
      tokens: runtime.tokenStore,
      emailVerificationTokens: runtime.emailVerificationTokenStore,
      passwordResetTokens: runtime.passwordResetTokenStore,
      delivery: {
        async sendEmailVerification() {},
        async sendPasswordReset() {},
      },
      context: restartedContext,
    })

    expect(await auth.guard('web').user()).toMatchObject({
      name: 'User Ava',
    })
    expect(await auth.guard('admin').user()).toMatchObject({
      name: 'Admin Mina',
    })
  })

  it('logs every configured guard out when logoutAll is called without a guard name', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: await hasher.hash('admin-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    await auth.guard('admin').login({
      email: 'admin@example.com',
      password: 'admin-secret',
    })

    const loggedOut = await getAuthRuntime().logoutAll()

    expect(await auth.guard('web').check()).toBe(false)
    expect(await auth.guard('admin').check()).toBe(false)
    expect(loggedOut).toEqual([
      {
        guard: 'web',
        cookies: [],
      },
      {
        guard: 'admin',
        cookies: [
          expect.stringContaining('holo_session=;'),
          expect.stringContaining('holo_session_remember=;'),
        ],
      },
      {
        guard: 'api',
        cookies: [],
      },
    ])
  })

  it('removes shared-session auth payloads when logoutAll logs out every guard', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: await hasher.hash('admin-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const webSession = await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    runtime.context.setSessionId('admin', webSession.sessionId)

    const adminSession = await auth.guard('admin').login({
      email: 'admin@example.com',
      password: 'admin-secret',
    })

    expect(adminSession.sessionId).toBe(webSession.sessionId)

    await getAuthRuntime().logoutAll()

    expect(runtime.sessionStore.records.size).toBe(0)

    resetAuthRuntime()
    const restartedContext = authRuntimeInternals.createMemoryAuthContext()
    restartedContext.setSessionId('web', webSession.sessionId)
    restartedContext.setSessionId('admin', webSession.sessionId)
    configureAuthRuntime({
      config: defineAuthConfig({
        defaults: {
          guard: 'web',
          passwords: 'users',
        },
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          admin: {
            driver: 'session',
            provider: 'admins',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
        admins: runtime.adminsProvider,
      },
      tokens: runtime.tokenStore,
      emailVerificationTokens: runtime.emailVerificationTokenStore,
      passwordResetTokens: runtime.passwordResetTokenStore,
      delivery: {
        async sendEmailVerification() {},
        async sendPasswordReset() {},
      },
      context: restartedContext,
    })

    await expect(auth.guard('web').user()).resolves.toBeNull()
    await expect(auth.guard('admin').user()).resolves.toBeNull()
  })

  it('supports shared-session logout with legacy session bindings that do not expose write()', async () => {
    const runtime = configureRuntime()
    const session = getSessionRuntime()
    const legacySession = {
      create: session.create,
      read: session.read,
      touch: session.touch,
      invalidate: session.invalidate,
      issueRememberMeToken: session.issueRememberMeToken,
      cookie: session.cookie,
      sessionCookie: session.sessionCookie,
      rememberMeCookie: session.rememberMeCookie,
    }
    reconfigureAuthRuntimeWithSession(runtime, legacySession)

    const createdUser = await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const createdAdmin = await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const webSession = await auth.guard('web').loginUsing(createdUser)
    runtime.context.setSessionId('admin', webSession.sessionId)
    await auth.guard('admin').loginUsing(createdAdmin)

    await expect(auth.guard('admin').logout()).resolves.toMatchObject({
      guard: 'admin',
      cookies: [],
    })
    await expect(auth.guard('web').user()).resolves.toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
    })
  })

  it('preserves hasher instance context when checking whether a password needs rehashing', async () => {
    const passwordHasher = {
      marker: 'rehash-digest',
      async hash(password: string) {
        return `hash:${password}`
      },
      async verify(password: string, digest: string) {
        return digest === `hash:${password}`
      },
      needsRehash(digest: string) {
        return digest === this.marker
      },
    }

    configureRuntime({
      passwordHasher,
    })

    await expect(needsPasswordRehash('rehash-digest')).resolves.toBe(true)
    await expect(needsPasswordRehash('other-digest')).resolves.toBe(false)
  })

  it('returns hosted-provider cookie clears from logoutAll for a named guard', async () => {
    const runtime = configureRuntime({
      authConfig: {
        clerk: {
          app: {
            sessionCookie: '__session',
            guard: 'web',
          },
        },
        workos: {
          dashboard: {
            sessionCookie: 'wos-session',
            guard: 'web',
          },
        },
      },
    })

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(created, {
      remember: true,
    })

    const loggedOut = await getAuthRuntime().logoutAll('web')

    expect(loggedOut).toEqual([
      expect.objectContaining({
        guard: 'web',
        cookies: expect.arrayContaining([
          expect.stringContaining('holo_session=;'),
          expect.stringContaining('holo_session_remember=;'),
          expect.stringContaining('__session=;'),
          expect.stringContaining('wos-session=;'),
        ]),
      }),
    ])
  })

  it('returns hosted-provider cookie clears from logoutAll when logging out every guard', async () => {
    const runtime = configureRuntime({
      authConfig: {
        clerk: {
          app: {
            sessionCookie: '__session',
            guard: 'web',
          },
        },
        workos: {
          dashboard: {
            sessionCookie: 'wos-session',
            guard: 'web',
          },
        },
      },
    })

    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(created, {
      remember: true,
    })

    const loggedOut = await getAuthRuntime().logoutAll()

    expect(loggedOut).toEqual([
      expect.objectContaining({
        guard: 'web',
        cookies: expect.arrayContaining([
          expect.stringContaining('holo_session=;'),
          expect.stringContaining('holo_session_remember=;'),
          expect.stringContaining('__session=;'),
          expect.stringContaining('wos-session=;'),
        ]),
      }),
      {
        guard: 'admin',
        cookies: [],
      },
      {
        guard: 'api',
        cookies: [],
      },
    ])
  })

  it('preserves the auth provider marker when a user is rehydrated from session storage', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    await runtime.usersProvider.create({
      name: 'User Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    await runtime.adminsProvider.create({
      name: 'Admin Mina',
      email: 'admin@example.com',
      password: await hasher.hash('admin-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    const sessionId = runtime.context.getSessionId('web')
    expect(sessionId).toBeTypeOf('string')

    resetAuthRuntime()
    const restartedContext = authRuntimeInternals.createMemoryAuthContext()
    restartedContext.setSessionId('web', sessionId)
    configureAuthRuntime({
      config: defineAuthConfig({
        defaults: {
          guard: 'web',
          passwords: 'users',
        },
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          admin: {
            driver: 'session',
            provider: 'admins',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
        admins: runtime.adminsProvider,
      },
      tokens: runtime.tokenStore,
      emailVerificationTokens: runtime.emailVerificationTokenStore,
      passwordResetTokens: runtime.passwordResetTokenStore,
      context: restartedContext,
    })

    const hydratedUser = await auth.guard('web').user()
    const created = await tokens.create(hydratedUser!, {
      name: 'rehydrated-user-token',
    })

    expect(created.provider).toBe('users')
    expect(runtime.tokenStore.records.get(created.id)?.provider).toBe('users')
  })

  it('replaces the previous session when logging in again and can clear all sessions through the runtime facade', async () => {
    const runtime = configureRuntime()

    await register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    const firstSessionId = runtime.context.getSessionId('web')
    const firstRecord = firstSessionId
      ? runtime.sessionStore.records.get(firstSessionId)
      : null

    expect(firstRecord).toBeTruthy()
    const agedCreatedAt = new Date(Date.now() - (110 * 60 * 1000))
    const agedLastActivityAt = new Date(Date.now() - (109 * 60 * 1000))
    const agedExpiresAt = new Date(Date.now() + (60 * 1000))

    if (firstRecord && firstSessionId) {
      runtime.sessionStore.records.set(firstSessionId, Object.freeze({
        ...firstRecord,
        createdAt: agedCreatedAt,
        lastActivityAt: agedLastActivityAt,
        expiresAt: agedExpiresAt,
      }))
    }

    await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    const secondSessionId = runtime.context.getSessionId('web')
    const secondRecord = secondSessionId
      ? runtime.sessionStore.records.get(secondSessionId)
      : null

    expect(secondSessionId).toBeTypeOf('string')
    expect(secondSessionId).not.toBe(firstSessionId)
    expect(firstSessionId ? runtime.sessionStore.records.has(firstSessionId) : false).toBe(false)
    expect(secondSessionId ? runtime.sessionStore.records.has(secondSessionId) : false).toBe(true)
    expect(secondRecord).toBeTruthy()
    expect(secondRecord?.createdAt.getTime()).not.toBe(agedCreatedAt.getTime())
    expect(secondRecord?.lastActivityAt.getTime()).not.toBe(agedLastActivityAt.getTime())
    expect(secondRecord?.expiresAt.getTime()).not.toBe(agedExpiresAt.getTime())
    expect(secondRecord?.createdAt.getTime()).toBeGreaterThan(agedCreatedAt.getTime())
    expect(secondRecord?.expiresAt.getTime()).toBeGreaterThan(agedExpiresAt.getTime())
    expect((secondRecord?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(60 * 60 * 1000)

    await auth.logout()
    expect(runtime.context.getSessionId('web')).toBeUndefined()
  })

  it('creates personal access tokens, authenticates them, updates last-used metadata, and enforces abilities', async () => {
    const runtime = configureRuntime()
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    const userRecord = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const created = await tokens.create(userRecord, {
      name: 'mobile-app',
      abilities: ['orders.read'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    expect(created.plainTextToken).toContain('.')
    expect(created.abilities).toEqual(['orders.read'])

    const stored = runtime.tokenStore.records.get(created.id)
    expect(stored?.tokenHash).toMatch(/^sha256\$/)
    expect(stored?.tokenHash).not.toContain(created.plainTextToken.split('.')[1]!)

    expect(await tokens.authenticate(created.plainTextToken)).toMatchObject({
      id: userRecord.id,
      email: 'ava@example.com',
    })
    expect(runtime.tokenStore.records.get(created.id)?.lastUsedAt).toBeInstanceOf(Date)
    await expect(tokens.can(created.plainTextToken, 'orders.read')).resolves.toBe(true)
    await expect(tokens.can(created.plainTextToken, 'orders.write')).resolves.toBe(false)
  })

  it('uses configured default token abilities when none are provided explicitly', async () => {
    const runtime = configureRuntime({
      authConfig: {
        personalAccessTokens: {
          defaultAbilities: ['projects.read'],
        },
      },
    })
    const password = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    const userRecord = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password,
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const created = await tokens.create(userRecord, {
      name: 'default-scope-token',
    })

    expect(created.abilities).toEqual(['projects.read'])
    expect(runtime.tokenStore.records.get(created.id)?.abilities).toEqual(['projects.read'])
  })

  it('lists tokens, revokes the current token, revokes all tokens for a user, and isolates revocation by user', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    const ava = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })
    const mina = await runtime.usersProvider.create({
      name: 'Mina',
      email: 'mina@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const tokenA = await tokens.create(ava, {
      name: 'first',
      abilities: ['*'],
    })
    const tokenB = await tokens.create(ava, {
      name: 'second',
      abilities: ['orders.read'],
    })
    const tokenC = await tokens.create(mina, {
      name: 'mina',
      abilities: ['reports.read'],
    })

    expect((await tokens.list(ava)).map(token => token.id).sort()).toEqual([tokenA.id, tokenB.id].sort())

    runtime.context.setAccessToken('api', tokenA.plainTextToken)
    await tokens.revoke({ guard: 'api' })
    expect(await tokens.authenticate(tokenA.plainTextToken)).toBeNull()
    expect(await tokens.authenticate(tokenB.plainTextToken)).toMatchObject({ id: ava.id })
    expect(await tokens.authenticate(tokenC.plainTextToken)).toMatchObject({ id: mina.id })

    await expect(tokens.revokeAll(ava)).resolves.toBe(1)
    expect(await tokens.authenticate(tokenB.plainTextToken)).toBeNull()
    expect(await tokens.authenticate(tokenC.plainTextToken)).toMatchObject({ id: mina.id })
  })

  it('requires an explicit guard when multiple providers are configured and a user did not come from auth', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    const storedAdmin = {
      id: 44,
      name: 'External Admin',
      email: 'admin@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    }

    runtime.adminsProvider.users.set(storedAdmin.id, storedAdmin)
    runtime.adminsProvider.usersByEmail.set(storedAdmin.email, storedAdmin.id)
    const externalUser = {
      ...storedAdmin,
    }

    await expect(tokens.create(externalUser, {
      name: 'admin-api',
      abilities: ['*'],
    })).rejects.toThrow('Pass a guard explicitly when multiple auth providers are configured')

    const created = await tokens.create(externalUser, {
      name: 'admin-api',
      abilities: ['*'],
      guard: 'admin',
    })
    expect(runtime.tokenStore.records.get(created.id)?.provider).toBe('admins')
  })

  it('returns the current access token for token guards and lets it delete itself', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    const ava = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    const token = await tokens.create(ava, {
      name: 'mobile-app',
      abilities: ['orders.read'],
      guard: 'api',
    })

    runtime.context.setAccessToken('api', token.plainTextToken)

    expect(await currentAccessToken()).toBeNull()

    const current = await auth.guard('api').currentAccessToken()
    expect(current).toMatchObject({
      id: token.id,
      name: 'mobile-app',
      abilities: ['orders.read'],
    })

    await current?.delete()
    expect(runtime.context.getAccessToken('api')).toBeUndefined()
    expect(await tokens.authenticate(token.plainTextToken)).toBeNull()
  })

  it('ignores current-token revocation when the selected guard has no active token', async () => {
    configureRuntime()

    await expect(tokens.revoke()).resolves.toBeUndefined()
    await expect(tokens.revoke({ guard: 'api' })).resolves.toBeUndefined()
  })

  it('rejects malformed, unknown, partial, and expired tokens and supports token guards alongside session guards', async () => {
    const runtime = configureRuntime()
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    const ava = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: await hasher.hash('secret-secret'),
      email_verified_at: new Date('2026-04-08T00:00:00.000Z'),
    })

    await auth.guard('web').login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })

    const activeToken = await tokens.create(ava, {
      name: 'api',
      abilities: ['orders.read'],
      guard: 'api',
    })
    const expiredToken = await tokens.create(ava, {
      name: 'expired',
      abilities: ['orders.read'],
      expiresAt: new Date('2026-04-07T00:00:00.000Z'),
      guard: 'api',
    })

    runtime.context.setAccessToken('api', activeToken.plainTextToken)
    expect(await auth.guard('api').check()).toBe(true)
    expect(await auth.guard('api').user()).toMatchObject({ id: ava.id, email: ava.email })
    expect(await auth.guard('web').check()).toBe(true)

    runtime.context.setAccessToken('api', 'malformed-token')
    expect(await auth.guard('api').check()).toBe(false)

    runtime.context.setAccessToken('api', `${activeToken.id}.bad-secret`)
    expect(await auth.guard('api').user()).toBeNull()

    runtime.context.setAccessToken('api', `${randomUUID()}.missing`)
    expect(await auth.guard('api').user()).toBeNull()

    runtime.context.setAccessToken('api', `${activeToken.id}.`)
    expect(await auth.guard('api').user()).toBeNull()

    runtime.context.setAccessToken('api', expiredToken.plainTextToken)
    expect(await auth.guard('api').user()).toBeNull()

    await auth.guard('api').logout()
    expect(runtime.context.getAccessToken('api')).toBeUndefined()
  })

  it('supports default and named client exports', () => {
    expect(clientAuth.check).toBe(clientCheck)
    expect(clientAuth.user).toBe(clientUser)
    expect(clientAuth.refreshUser).toBe(clientRefreshUser)
  })

  it('uses the current-auth endpoint in the client helpers, caches user state, supports refresh, guard selection, and surfaces fetch errors', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? new URL(input, 'https://example.com')
        : input instanceof URL
          ? input
          : new URL(input.url)

      const guard = url.searchParams.get('guard') ?? 'web'
      const name = guard === 'admin' ? 'Admin Mina' : 'Ava'
      return new Response(JSON.stringify({
        authenticated: true,
        guard,
        user: {
          id: guard === 'admin' ? 2 : 1,
          email: guard === 'admin' ? 'admin@example.com' : 'ava@example.com',
          name,
          hit: fetchMock.mock.calls.length,
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })

    configureAuthClient({
      endpoint: '/api/auth/user',
      fetch: fetchMock as typeof fetch,
      headers: {
        'x-auth-test': 'yes',
      },
    })

    const first = await clientUser()
    const second = await clientUser()
    expect(first).toMatchObject({
      name: 'Ava',
      hit: 1,
    })
    expect(second).toMatchObject({
      name: 'Ava',
      hit: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const refreshed = await clientRefreshUser()
    expect(refreshed).toMatchObject({
      name: 'Ava',
      hit: 2,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await clientCheck()).toBe(true)

    const adminUser = await clientUser({ guard: 'admin' })
    expect(adminUser).toMatchObject({
      name: 'Admin Mina',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/auth/user?guard=admin')

    const failureFetch = vi.fn(async () => new Response('nope', { status: 500 }))
    configureAuthClient({
      endpoint: '/api/auth/user',
      fetch: failureFetch as typeof fetch,
    })
    await expect(clientUser()).rejects.toThrow('Current-auth request failed with status 500')

    const invalidJsonFetch = vi.fn(async () => new Response('broken', {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }))
    configureAuthClient({
      endpoint: '/api/auth/user',
      fetch: invalidJsonFetch as typeof fetch,
    })
    await expect(clientRefreshUser()).rejects.toThrow('Current-auth response body was not valid JSON')
  })

  it('separates current-auth client cache entries by request headers', async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = typeof input === 'string' || input instanceof URL
        ? new Request(
            typeof input === 'string' && input.startsWith('/')
              ? new URL(input, 'https://holo.local')
              : input,
            init,
          )
        : input
      const authorization = request.headers.get('authorization') ?? ''

      return new Response(JSON.stringify({
        authenticated: true,
        guard: 'web',
        user: {
          id: authorization === 'Bearer token-b' ? 2 : 1,
          email: authorization === 'Bearer token-b' ? 'b@example.com' : 'a@example.com',
          token: authorization,
          hit: fetchMock.mock.calls.length,
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })

    configureAuthClient({
      endpoint: '/api/auth/user',
      fetch: fetchMock as typeof fetch,
    })

    const first = await clientUser({
      headers: {
        authorization: 'Bearer token-a',
      },
    })
    const second = await clientUser({
      headers: {
        authorization: 'Bearer token-b',
      },
    })
    const firstAgain = await clientUser({
      headers: {
        authorization: 'Bearer token-a',
      },
    })

    expect(first).toMatchObject({
      email: 'a@example.com',
      token: 'Bearer token-a',
      hit: 1,
    })
    expect(second).toMatchObject({
      email: 'b@example.com',
      token: 'Bearer token-b',
      hit: 2,
    })
    expect(firstAgain).toMatchObject({
      email: 'a@example.com',
      token: 'Bearer token-a',
      hit: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the runtime is missing, guards are unknown, or providers are not wired', async () => {
    await expect(check()).rejects.toThrow('Auth runtime is not configured yet')

    const runtime = configureRuntime()
    await expect(auth.guard('missing').check()).rejects.toThrow('Auth guard "missing" is not configured')

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {},
      tokens: runtime.tokenStore,
      context: runtime.context,
    })

    await expect(login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })).rejects.toThrow('Auth provider runtime "users" is not configured')
    await expect(tokens.create({ id: 1 }, {
      name: 'api',
      guard: 'api',
    })).rejects.toThrow('Auth provider runtime "users" is not configured')
  })

  it('uses the default delivery stub without leaking raw lifecycle tokens', async () => {
    const sessionStore = new InMemorySessionStore()
    const usersProvider = new InMemoryProviderAdapter()
    const emailVerificationTokenStore = new InMemoryEmailVerificationTokenStore()
    const passwordResetTokenStore = new InMemoryPasswordResetTokenStore()

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
        providers: {
          users: {
            model: 'User',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: usersProvider,
      },
      emailVerificationTokens: emailVerificationTokenStore,
      passwordResetTokens: passwordResetTokenStore,
      context: authRuntimeInternals.createMemoryAuthContext(),
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const created = await register({
      name: 'Ava',
      email: 'ava@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    })

    const verifyToken = await verification.create(created)
    await passwords.request('ava@example.com')

    const resetRecord = [...passwordResetTokenStore.records.values()][0]
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain(verifyToken.id)
    expect(warn.mock.calls[0]?.[0]).not.toContain(verifyToken.plainTextToken)
    expect(warn.mock.calls[1]?.[0]).toContain(resetRecord?.id ?? '')
    expect(warn.mock.calls[1]?.[0]).not.toContain(resetRecord?.tokenHash ?? '')
  })

  it('covers runtime helper branches for cookies, tokens, payloads, and async context', async () => {
    const hasher = authRuntimeInternals.createDefaultPasswordHasher()
    const digest = await hasher.hash('secret-secret')

    await expect(hasher.verify('secret-secret', 'invalid')).resolves.toBe(false)
    expect(authRuntimeInternals.verifyTokenSecret('secret', 'invalid')).toBe(false)
    expect(authRuntimeInternals.parsePlainTextToken('invalid')).toBeNull()
    expect(authRuntimeInternals.tokenHasAbility({
      id: 'token-1',
      provider: 'users',
      userId: 1,
      name: 'api',
      abilities: ['orders.read'],
      tokenHash: 'sha256$hash',
      createdAt: new Date(),
      expiresAt: null,
    }, '   ')).toBe(false)
    expect(authRuntimeInternals.toPlainTextTokenResult({
      id: 'token-2',
      provider: 'users',
      userId: 1,
      name: 'api',
      abilities: ['orders.read'],
      tokenHash: 'sha256$hash',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2024-01-02T00:00:00.000Z'),
      expiresAt: null,
    }, 'token-2.secret').lastUsedAt).toEqual(new Date('2024-01-02T00:00:00.000Z'))
    await expect(configureRuntime({
      passwordHasher: {
        hash: hasher.hash,
        verify: hasher.verify,
      },
    }) && needsPasswordRehash(digest)).resolves.toBe(false)

    expect(authRuntimeInternals.parseSetCookieDefinition('invalid')).toBeNull()
    expect(authRuntimeInternals.parseSetCookieDefinition(
      'session=value; ; Path=/app; Domain=example.com; Secure; HttpOnly; SameSite=None; Partitioned',
    )).toEqual({
      name: 'session',
      options: {
        path: '/app',
        domain: 'example.com',
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        partitioned: true,
      },
    })
    expect(authRuntimeInternals.serializeCookie('session', 'value', {
      path: '/app',
      domain: 'example.com',
      maxAge: 60,
      expires: new Date('2024-01-01T00:00:00.000Z'),
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      partitioned: true,
    })).toContain('Max-Age=60')
    expect(authRuntimeInternals.serializeCookie('session', 'value')).toBe('session=value; Path=/')
    expect(authRuntimeInternals.getPasswordHash({
      getId(user: UserRecord) {
        return user.id
      },
      async findById() {
        return null
      },
      async findByCredentials() {
        return null
      },
      async create() {
        throw new Error('not implemented')
      },
    }, {
      id: 1,
      email: 'ava@example.com',
      password: null,
    })).toBeNull()
    expect(authRuntimeInternals.writeSessionPayloads({
      keep: true,
      auth: 'remove-me',
    }, {} as never)).toEqual(Object.freeze({
      keep: true,
    }))

    const payload = Object.freeze({
      guard: 'web',
      provider: 'users',
      userId: 1,
      user: Object.freeze({
        id: 1,
        email: 'ava@example.com',
      }),
    })
    const record = {
      id: 'session-1',
      store: 'database',
      data: {
        auth: {
          admin: Object.freeze({
            guard: 'admin',
            provider: 'admins',
            userId: 2,
            user: Object.freeze({
              id: 2,
              email: 'admin@example.com',
            }),
          }),
          web: payload,
        },
      },
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }

    expect(authRuntimeInternals.readSessionPayload(null)).toBeNull()
    expect(authRuntimeInternals.readSessionPayload({
      ...record,
      data: {},
    })).toBeNull()
    expect(authRuntimeInternals.readSessionPayload({
      ...record,
      data: {
        auth: 'invalid',
      },
    })).toBeNull()
    expect(authRuntimeInternals.readSessionPayload({
      ...record,
      data: {
        auth: {
          invalid: 1,
        },
      },
    })).toBeNull()
    expect(authRuntimeInternals.readSessionPayload(record)).toEqual(
      (record.data.auth as Record<string, unknown>).admin,
    )
    expect(authRuntimeInternals.readSessionPayload(record, 'web')).toEqual(payload)
    expect(authRuntimeInternals.readSessionPayload(record, 'missing')).toBeNull()

    const context = authRuntimeInternals.createAsyncAuthContext()
    expect(context.getSessionId('web')).toBeUndefined()
    context.activate()
    context.setSessionId('web', 'session-1')
    context.setCachedUser('web', {
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
      role: 'member',
    })
    context.setAccessToken?.('api', 'token-value')
    context.setRememberToken?.('web', 'remember-value')
    expect(context.getSessionId('web')).toBe('session-1')
    expect(context.getCachedUser('web')).toEqual({
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
      role: 'member',
    })
    expect(context.getAccessToken?.('api')).toBe('token-value')
    expect(context.getRememberToken?.('web')).toBe('remember-value')
  })

  it('covers client internal fallback and tuple-header branches', async () => {
    vi.stubGlobal('fetch', undefined)
    expect(() => authClientInternals.resolveClientConfig()).toThrow('Fetch is not available')

    const fetchMock = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            authenticated: true,
            guard: 'admin',
            user: {
              id: 2,
              email: 'admin@example.com',
              header: init?.headers instanceof Headers ? init.headers.get('x-auth') : null,
            },
          }
        },
      } satisfies Partial<Response> as Response
    })

    vi.stubGlobal('fetch', fetchMock)
    resetAuthClient()
    expect(authClientInternals.resolveClientConfig().fetchImpl).toBe(fetchMock)
    expect(authClientInternals.resolveClientConfig({
      guard: 'admin',
    }).fetchImpl).toBe(fetchMock)

    configureAuthClient({
      fetch: fetchMock as typeof fetch,
    })

    expect(authClientInternals.createRequestUrl({
      endpoint: 'https://example.com/api/auth/user#hash',
      guard: 'admin',
      headers: undefined,
      fetchImpl: fetchMock as typeof fetch,
    })).toBe('https://example.com/api/auth/user?guard=admin#hash')

    await expect(authClientInternals.fetchCurrentUser({
      endpoint: 'https://example.com/api/auth/user',
      guard: 'admin',
      headers: [['x-auth', 'token-a']],
    })).resolves.toMatchObject({
      authenticated: true,
      guard: 'admin',
      user: {
        id: 2,
        header: 'token-a',
      },
    })
  })

  it('covers missing store, provider config, and non-session guard failures', async () => {
    const runtime = configureRuntime()
    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
      },
      context: runtime.context,
    })

    await expect(tokens.list(created, {
      guard: 'api',
    })).rejects.toThrow('Personal access token runtime is not configured yet')
    await expect(verification.create(created, {
      guard: 'web',
    })).rejects.toThrow('Email verification token runtime is not configured yet')
    await expect(passwords.request('ava@example.com')).rejects.toThrow('Password reset token runtime is not configured yet')
    await expect(auth.guard('api').loginUsing(created)).rejects.toThrow('does not support session login')

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          api: {
            driver: 'token',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: runtime.usersProvider,
      },
      tokens: runtime.tokenStore,
      context: runtime.context,
    })

    runtime.tokenStore.records.set('orphan-token', {
      id: 'orphan-token',
      provider: 'missing',
      userId: created.id,
      name: 'orphan',
      abilities: ['*'],
      tokenHash: authRuntimeInternals.hashTokenSecret('secret'),
      createdAt: new Date(),
      expiresAt: null,
    })

    await expect(tokens.authenticate('orphan-token.secret')).rejects.toThrow(
      'Auth provider "missing" is not configured',
    )
  })

  it('covers trusted-login compatibility and provider marker edge cases', async () => {
    const runtime = configureRuntime()
    const userRecord = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const adminRecord = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const markedAdmin = (await auth.guard('admin').loginUsing(adminRecord)).user
    await expect(auth.guard('web').loginUsing(markedAdmin)).rejects.toThrow(
      'requires a user from provider "users", received "admins"',
    )
    await expect(auth.guard('web').loginUsing(null as never)).rejects.toThrow(
      'Trusted login requires a user or user id',
    )
    await expect(auth.guard('web').loginUsingId(999)).rejects.toThrow(
      'Auth user "users:999" was not found for trusted login.',
    )
    await expect(loginUsing({
      id: userRecord.id,
      email: userRecord.email,
      ignored: undefined,
    })).resolves.toMatchObject({
      user: {
        id: userRecord.id,
        email: userRecord.email,
      },
    })
    await expect(loginUsing({
      id: userRecord.id,
      email: userRecord.email,
      extra: 'mismatch',
    } as never)).rejects.toThrow(
      'Pass a user id, a serialized auth user, or implement matchesUser() on the provider adapter.',
    )
    await expect(loginUsing({
      nope: true,
    } as never)).rejects.toThrow(
      'Trusted login for guard "web" requires a user value compatible with provider "users".',
    )

    const originalGetId = runtime.usersProvider.getId.bind(runtime.usersProvider)
    const candidateWithFallbackId = {
      id: userRecord.id,
      email: userRecord.email,
    }

    runtime.usersProvider.getId = ((user: UserRecord) => {
      if (user === candidateWithFallbackId) {
        throw new Error('cannot-read-id')
      }
      return originalGetId(user)
    }) as typeof runtime.usersProvider.getId
    runtime.usersProvider.matchesUser = (() => false) as typeof runtime.usersProvider.matchesUser

    await expect(loginUsing(candidateWithFallbackId)).resolves.toMatchObject({
      user: {
        id: userRecord.id,
        email: userRecord.email,
      },
    })

    runtime.usersProvider.matchesUser = (() => true) as typeof runtime.usersProvider.matchesUser

    await expect(loginUsing({
      email: userRecord.email,
    } as never)).rejects.toThrow(
      'Trusted login for guard "web" requires a user value compatible with provider "users".',
    )
  })

  it('covers refresh, impersonation, wrapper, and reset edge cases', async () => {
    const runtime = configureRuntime()
    const actor = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const target = await runtime.usersProvider.create({
      name: 'Mina',
      email: 'mina@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(auth.guard('web').refreshUser()).resolves.toBeNull()
    await expect(auth.guard('web').id()).resolves.toBeNull()
    await expect(auth.guard('web').stopImpersonating()).resolves.toBeNull()
    await expect(auth.guard('web').impersonateById(target.id)).rejects.toThrow(
      'requires an authenticated actor',
    )

    await auth.guard('web').loginUsingId(actor.id)
    await expect(auth.guard('web').impersonate(target)).resolves.toMatchObject({
      user: {
        id: target.id,
      },
    })
    await expect(impersonateById(actor.id)).rejects.toThrow('Nested impersonation is not supported')

    await stopImpersonating()
    runtime.usersProvider.users.delete(actor.id)
    runtime.usersProvider.usersByEmail.delete(actor.email)
    await expect(refreshUser()).resolves.toBeNull()
    expect(runtime.context.getSessionId('web')).toBeUndefined()

    await auth.guard('admin').loginUsing(admin)
    const impersonated = await auth.guard('web').impersonateById(target.id, {
      actorGuard: 'admin',
    })
    const sessionRecord = runtime.sessionStore.records.get(impersonated.sessionId)
    expect(sessionRecord).toBeTruthy()
    if (sessionRecord) {
      const webPayload = (sessionRecord.data.auth as Record<string, unknown>).web
      runtime.sessionStore.records.set(sessionRecord.id, {
        ...sessionRecord,
        data: {
          ...sessionRecord.data,
          auth: {
            web: webPayload,
          },
        },
      })
    }
    await expect(auth.guard('web').stopImpersonating()).resolves.toBeNull()
    expect(runtime.sessionStore.records.has(impersonated.sessionId)).toBe(false)

    const adminSession = await auth.guard('admin').loginUsing(admin)
    runtime.context.setSessionId('web', adminSession.sessionId)
    await auth.guard('web').logout()
    expect(runtime.sessionStore.records.has(adminSession.sessionId)).toBe(false)

    await auth.guard('admin').loginUsing(admin)
    await getAuthRuntime().impersonateById(target.id, {
      actorGuard: 'admin',
    })

    configureAuthRuntime()
    await expect(check()).rejects.toThrow('Auth runtime is not configured yet')
  })

  it('covers provider fallbacks and password or verification edge cases', async () => {
    const runtime = configureRuntime()
    const created = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(authRuntimeInternals.updateUserRecord('users', 999, {
      email: 'missing@example.com',
    })).rejects.toThrow('Auth user "users:999" no longer exists.')

    const noEmail = await runtime.usersProvider.create({
      name: 'No Email',
      email: '',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(verification.create(noEmail, {
      guard: 'web',
    })).rejects.toThrow('Email verification requires a user with an email address.')
    await expect(passwords.request('   ')).rejects.toThrow('Email is required to request a password reset.')
    await expect(passwords.request('ava@example.com', {
      broker: 'missing',
    })).rejects.toThrow('Password broker "missing" is not configured.')
    await expect(passwords.request('missing@example.com')).resolves.toBeUndefined()

    await passwords.request('ava@example.com')
    const resetDelivery = runtime.deliveries.find(entry => entry.type === 'password-reset')
    runtime.usersProvider.users.delete(created.id)
    runtime.usersProvider.usersByEmail.delete(created.email)
    await expect(passwords.consume({
      token: resetDelivery!.tokenValue,
      password: 'new-secret',
      passwordConfirmation: 'new-secret',
    })).rejects.toThrow('Password reset token user no longer exists.')

    const listedUser = await runtime.usersProvider.create({
      name: 'List Me',
      email: 'list@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    await tokens.create(listedUser, {
      guard: 'api',
      name: 'list-token',
    })
    await expect(tokens.list(listedUser, {
      guard: 'api',
    })).resolves.toHaveLength(1)
    await expect(tokens.revokeAll(listedUser, {
      guard: 'api',
    })).resolves.toBe(1)
    await expect(tokens.create(1 as never, {
      name: 'primitive-user',
    })).rejects.toThrow('Unable to resolve a provider for the given user.')
  })

  it('supports provider adapters without explicit serialize or credential helper hooks', async () => {
    const sessionStore = new InMemorySessionStore()
    const users = new Map<number, {
      id: number
      email: string
      password: string
      email_verified_at: Date
    }>()

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

    const hashedPassword = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    users.set(1, {
      id: 1,
      email: 'ava@example.com',
      password: hashedPassword,
      email_verified_at: new Date(),
    })

    configureAuthRuntime({
      config: defineAuthConfig({
        defaults: {
          guard: 'web',
        },
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
        },
        emailVerification: {
          required: true,
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: {
          async findById(id) {
            return users.get(Number(id)) ?? null
          },
          async findByCredentials(credentials) {
            return typeof credentials.email === 'string'
              ? [...users.values()].find(user => user.email === credentials.email) ?? null
              : null
          },
          async create() {
            throw new Error('not implemented')
          },
          getId(user: { id: number }) {
            return user.id
          },
        },
      },
      context: authRuntimeInternals.createMemoryAuthContext(),
    })

    await expect(login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })).resolves.toMatchObject({
      user: {
        id: 1,
        email: 'ava@example.com',
        password: hashedPassword,
      },
    })
  })

  it('covers session renewal without write support', async () => {
    const runtime = configureRuntime()
    const context = authRuntimeInternals.createMemoryAuthContext()
    const existingRecord = Object.freeze({
      id: 'shared-session',
      store: 'database',
      data: Object.freeze({
        auth: Object.freeze({
          guard: 'admin',
          provider: 'admins',
          userId: 9,
          user: Object.freeze({
            id: 9,
            email: 'admin@example.com',
          }),
        }),
      }),
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rememberTokenHash: 'remember-hash',
    })
    const createdSessions: string[] = []

    context.setSessionId('admin', existingRecord.id)

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          admin: {
            driver: 'session',
            provider: 'admins',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
      session: {
        async create(input = {}) {
          const record = Object.freeze({
            id: input.id ?? `session-${createdSessions.length + 1}`,
            store: 'database',
            data: input.data ?? {},
            createdAt: new Date(),
            lastActivityAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          })
          createdSessions.push(record.id)
          return record
        },
        async read(sessionId) {
          return sessionId === existingRecord.id ? existingRecord : null
        },
        async touch(sessionId) {
          return sessionId === existingRecord.id ? existingRecord : null
        },
        async invalidate() {},
        async issueRememberMeToken(sessionId) {
          return `${sessionId}.remember`
        },
        sessionCookie(value) {
          return `holo_session=${value}; Path=/`
        },
        rememberMeCookie(value) {
          return `holo_session_remember=${value}; Path=/`
        },
      },
      providers: {
        users: runtime.usersProvider,
        admins: runtime.adminsProvider,
      },
      context,
    })

    await expect(authRuntimeInternals.establishSessionForUser({
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
      role: 'member',
    }, {
      guard: 'web',
      provider: 'users',
    })).resolves.toMatchObject({
      sessionId: existingRecord.id,
      user: {
        id: 1,
        email: 'ava@example.com',
      },
    })
    expect(createdSessions).toEqual([existingRecord.id])
  })

  it('covers remaining token and shared-session edge branches', async () => {
    const runtime = configureRuntime()
    const ava = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const token = await tokens.create(ava, {
      guard: 'api',
      name: 'edge-token',
    })
    runtime.usersProvider.users.delete(ava.id)
    runtime.usersProvider.usersByEmail.delete(ava.email)
    await expect(tokens.authenticate(token.plainTextToken)).resolves.toBeNull()

    runtime.context.setAccessToken('api', 'malformed-token')
    await expect(auth.guard('api').currentAccessToken()).resolves.toBeNull()

    runtime.context.setAccessToken('api', `${token.id}.wrong-secret`)
    await expect(auth.guard('api').currentAccessToken()).resolves.toBeNull()
    runtime.context.setAccessToken('api')
    await expect(auth.guard('api').refreshUser()).resolves.toBeNull()

    const adminSession = await auth.guard('admin').loginUsing(admin)
    runtime.context.setSessionId('web', adminSession.sessionId)
    runtime.sessionStore.records.delete(adminSession.sessionId)
    await expect(auth.guard('web').impersonation()).resolves.toBeNull()

    const restoredAdminSession = await auth.guard('admin').loginUsing(admin)
    const restoredAdminRecord = runtime.sessionStore.records.get(restoredAdminSession.sessionId)
    expect(restoredAdminRecord).toBeTruthy()
    if (restoredAdminRecord) {
      runtime.sessionStore.records.set(restoredAdminRecord.id, {
        ...restoredAdminRecord,
        data: {
          ...restoredAdminRecord.data,
          auth: {},
        },
      })
    }
    runtime.context.setSessionId('web', restoredAdminSession.sessionId)
    await expect(auth.guard('web').impersonation()).resolves.toBeNull()
  })

  it('writes remaining shared-session payloads when a fresh user disappears', async () => {
    const runtime = configureRuntime()
    const ava = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const admin = await runtime.adminsProvider.create({
      name: 'Admin Ava',
      email: 'admin@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    const adminSession = await auth.guard('admin').loginUsing(admin)
    await loginUsing(ava)

    runtime.usersProvider.users.delete(ava.id)
    runtime.usersProvider.usersByEmail.delete(ava.email)

    await expect(auth.guard('web').refreshUser()).resolves.toBeNull()

    const record = runtime.sessionStore.records.get(adminSession.sessionId)
    expect(record).toBeTruthy()
    expect(record?.data.auth).toEqual({
      guard: 'admin',
      provider: 'admins',
      userId: admin.id,
      user: expect.objectContaining({
        id: admin.id,
        email: admin.email,
      }),
    })
  })

  it('covers remaining trusted-login compatibility branches', async () => {
    const runtime = configureRuntime()
    const userRecord = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await expect(loginUsing(true as never)).rejects.toThrow(
      'Trusted login for guard "web" requires a user value compatible with provider "users".',
    )

    const originalGetId = runtime.usersProvider.getId.bind(runtime.usersProvider)
    runtime.usersProvider.getId = ((user: UserRecord | boolean) => {
      if (user === true) {
        return userRecord.id
      }
      return originalGetId(user as UserRecord)
    }) as typeof runtime.usersProvider.getId

    await expect(loginUsing(true as never)).rejects.toThrow(
      'Pass a user id, a serialized auth user, or implement matchesUser() on the provider adapter.',
    )
  })

  it('preserves remember hashes when renewing shared sessions with write support', async () => {
    const runtime = configureRuntime()
    const context = authRuntimeInternals.createMemoryAuthContext()
    const existingRecord = Object.freeze({
      id: 'shared-session',
      store: 'database',
      data: Object.freeze({
        auth: Object.freeze({
          guard: 'admin',
          provider: 'admins',
          userId: 9,
          user: Object.freeze({
            id: 9,
            email: 'admin@example.com',
          }),
        }),
      }),
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rememberTokenHash: 'remember-hash',
    })
    const writtenRecords: Array<{ readonly id: string, readonly rememberTokenHash?: string }> = []

    context.setSessionId('admin', existingRecord.id)

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
          admin: {
            driver: 'session',
            provider: 'admins',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
      session: {
        async create(input = {}) {
          return Object.freeze({
            id: input.id ?? 'new-session',
            store: 'database',
            data: input.data ?? {},
            createdAt: new Date(),
            lastActivityAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          })
        },
        async write(record) {
          writtenRecords.push({
            id: record.id,
            rememberTokenHash: record.rememberTokenHash,
          })
          return record
        },
        async read(sessionId) {
          return sessionId === existingRecord.id ? existingRecord : null
        },
        async touch(sessionId) {
          return sessionId === existingRecord.id ? existingRecord : null
        },
        async invalidate() {},
        async issueRememberMeToken(sessionId) {
          return `${sessionId}.remember`
        },
        sessionCookie(value) {
          return `holo_session=${value}; Path=/`
        },
        rememberMeCookie(value) {
          return `holo_session_remember=${value}; Path=/`
        },
      },
      providers: {
        users: runtime.usersProvider,
        admins: runtime.adminsProvider,
      },
      context,
    })

    await authRuntimeInternals.establishSessionForUser({
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
      role: 'member',
    }, {
      guard: 'web',
      provider: 'users',
    })

    expect(writtenRecords).toEqual([{
      id: existingRecord.id,
      rememberTokenHash: 'remember-hash',
    }])
  })

  it('covers remaining branch-only auth paths', async () => {
    const runtime = configureRuntime({
      authConfig: {
        clerk: {
          app: {
            sessionCookie: '__session',
          },
        },
        workos: {
          dashboard: {
            sessionCookie: 'wos-session',
          },
        },
      },
    })
    const userRecord = await runtime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })

    await loginUsing(userRecord, {
      remember: true,
    })
    await expect(auth.guard('web').id()).resolves.toBe(userRecord.id)
    await expect(tokens.can('bad-token', 'orders.read')).resolves.toBe(false)
    await expect(verification.create({
      id: userRecord.id,
    } as never, {
      guard: 'web',
    })).rejects.toThrow('Email verification requires a user with an email address.')

    const loggedOut = await getAuthRuntime().logoutAll('web')
    expect(loggedOut[0]?.cookies).toEqual(expect.arrayContaining([
      expect.stringContaining('__session=;'),
      expect.stringContaining('wos-session=;'),
    ]))
  })

  it('covers identifier selection and missing-auth logout branches', async () => {
    const defaultRuntime = configureRuntime()
    expect(authRuntimeInternals.getProviderIdentifiers('users')).toEqual(['email'])
    expect(authRuntimeInternals.getProviderIdentifiers('missing')).toEqual(['email'])

    const created = await defaultRuntime.usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: null,
      email_verified_at: new Date(),
    })
    const established = await loginUsing(created)
    const sessionRecord = defaultRuntime.sessionStore.records.get(established.sessionId)
    expect(sessionRecord).toBeTruthy()
    if (sessionRecord) {
      defaultRuntime.sessionStore.records.set(sessionRecord.id, {
        ...sessionRecord,
        data: {},
      })
    }
    await logout()
    expect(defaultRuntime.sessionStore.records.has(established.sessionId)).toBe(false)

    const phoneRuntime = configureRuntime({
      authConfig: defineAuthConfig({
        providers: {
          users: {
            model: 'User',
            identifiers: ['phone'],
          },
          admins: {
            model: 'Admin',
          },
        },
      }),
    })
    expect(authRuntimeInternals.getProviderIdentifiers('users')).toEqual(['phone'])

    void phoneRuntime
  })

  it('creates a default auth context when one is not provided', async () => {
    const sessionStore = new InMemorySessionStore()
    const usersProvider = new InMemoryProviderAdapter()

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

    const hashedPassword = await authRuntimeInternals.createDefaultPasswordHasher().hash('secret-secret')
    await usersProvider.create({
      name: 'Ava',
      email: 'ava@example.com',
      password: hashedPassword,
      email_verified_at: new Date(),
    })

    configureAuthRuntime({
      config: defineAuthConfig({
        guards: {
          web: {
            driver: 'session',
            provider: 'users',
          },
        },
        providers: {
          users: {
            model: 'User',
          },
        },
      }),
      session: getSessionRuntime(),
      providers: {
        users: usersProvider,
      },
    })

    await expect(login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })).resolves.toMatchObject({
      user: {
        email: 'ava@example.com',
      },
    })
    expect(authRuntimeInternals.getRuntimeBindings().context.getSessionId('web')).toBeTypeOf('string')
  })
})
