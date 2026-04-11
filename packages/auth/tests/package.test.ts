import { randomUUID } from 'node:crypto'
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
  id,
  login,
  logout,
  passwords,
  refreshUser,
  register,
  resetAuthRuntime,
  tokens,
  user,
  verification,
} from '../src'
import clientAuth, {
  check as clientCheck,
  configureAuthClient,
  refreshUser as clientRefreshUser,
  resetAuthClient,
  user as clientUser,
} from '../src/client'
import type {
  AuthDeliveryHook,
  AuthProviderAdapter,
  HoloAuthConfig,
  AuthUserLike,
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

  serialize(user: UserRecord): AuthUserLike {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
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

  serialize(user: UserRecord): AuthUserLike {
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
        ...baseConfig.passwords,
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

afterEach(() => {
  resetAuthRuntime()
  resetSessionRuntime()
  resetAuthClient()
  vi.unstubAllGlobals()
})

describe('@holo-js/auth package runtime', () => {
  it('supports default and named exports for default-guard operations', async () => {
    const runtime = configureRuntime()

    expect(auth.check).toBe(check)
    expect(auth.login).toBe(login)
    expect(auth.logout).toBe(logout)
    expect(auth.register).toBe(register)
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
    expect(runtime.context.getRememberToken('web')).toMatch(/\./)
    expect(runtime.sessionStore.records.size).toBe(1)

    await logout()

    expect(await check()).toBe(false)
    expect(await id()).toBeNull()
    expect(await user()).toBeNull()
    expect(runtime.context.getSessionId('web')).toBeUndefined()
    expect(runtime.sessionStore.records.size).toBe(0)
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
    const runtime = configureRuntime()

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
    expect(runtime.passwordResetTokenStore.records).toHaveLength(1)
    expect(runtime.passwordResetTokenStore.records.get(firstDelivery.tokenId)).toBe(firstRecord)
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

    await auth.guard('admin').logout()
    expect(await auth.guard('admin').check()).toBe(false)
    expect(await auth.guard('web').check()).toBe(true)
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

    runtime.context.setSessionId('admin', webSession.sessionId)

    const adminSession = await auth.guard('admin').login({
      email: 'admin@example.com',
      password: 'admin-secret',
    })

    expect(adminSession.sessionId).toBe(webSession.sessionId)
    expect(runtime.sessionStore.records).toHaveLength(1)

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

    await getAuthRuntime().logoutAll()

    expect(await auth.guard('web').check()).toBe(false)
    expect(await auth.guard('admin').check()).toBe(false)
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

    await login({
      email: 'ava@example.com',
      password: 'secret-secret',
    })
    const secondSessionId = runtime.context.getSessionId('web')

    expect(secondSessionId).toBeTypeOf('string')
    expect(secondSessionId).not.toBe(firstSessionId)
    expect(firstSessionId ? runtime.sessionStore.records.has(firstSessionId) : false).toBe(false)
    expect(secondSessionId ? runtime.sessionStore.records.has(secondSessionId) : false).toBe(true)

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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof input === 'string' || input instanceof URL
        ? new Request(
            typeof input === 'string' && input.startsWith('/')
              ? new URL(input, 'https://holo.local')
              : input,
            init,
          )
        : input instanceof Request
          ? input
          : new Request(input.url, input)
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
})
