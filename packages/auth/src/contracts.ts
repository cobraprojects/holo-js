export { defineAuthConfig } from '@holo-js/config'
export type { AuthGuardConfig, AuthProviderConfig, HoloAuthConfig, NormalizedHoloAuthConfig } from '@holo-js/config'
import type { HoloAuthConfig, NormalizedHoloAuthConfig } from '@holo-js/config'

export interface AuthUserLike {
  readonly id?: string | number
  readonly email?: string
  readonly [key: string]: unknown
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloAuthTypeRegistry {}

export type AuthUser = HoloAuthTypeRegistry extends {
  readonly user: infer TUser
}
  ? TUser extends AuthUserLike
    ? TUser
    : AuthUserLike
  : AuthUserLike

export interface AuthCredentials extends Readonly<Record<string, unknown>> {
  readonly password: string
  readonly remember?: boolean
}

export interface AuthRegistrationInput extends AuthCredentials {
  readonly passwordConfirmation: string
}

export interface AuthSessionLoginOptions {
  readonly remember?: boolean
}

export interface AuthImpersonationOptions extends AuthSessionLoginOptions {
  readonly actorGuard?: string
}

export interface AuthImpersonationState {
  readonly guard: string
  readonly actorGuard: string
  readonly user: AuthUser
  readonly actor: AuthUser
  readonly originalUser: AuthUser | null
  readonly startedAt: Date
}

export interface AuthLogoutResult {
  readonly guard: string
  readonly cookies: readonly string[]
}

export interface AuthGuardFacade {
  check(): Promise<boolean>
  user(): Promise<AuthUser | null>
  refreshUser(): Promise<AuthUser | null>
  id(): Promise<string | number | null>
  currentAccessToken(): Promise<AuthCurrentAccessToken | null>
  login(credentials: AuthCredentials): Promise<AuthEstablishedSession>
  loginUsing(user: unknown, options?: AuthSessionLoginOptions): Promise<AuthEstablishedSession>
  loginUsingId(userId: string | number, options?: AuthSessionLoginOptions): Promise<AuthEstablishedSession>
  impersonate(user: unknown, options?: AuthImpersonationOptions): Promise<AuthEstablishedSession>
  impersonateById(userId: string | number, options?: AuthImpersonationOptions): Promise<AuthEstablishedSession>
  impersonation(): Promise<AuthImpersonationState | null>
  stopImpersonating(): Promise<AuthUser | null>
  logout(): Promise<AuthLogoutResult>
}

export interface AuthFacade extends AuthGuardFacade {
  register(input: AuthRegistrationInput): Promise<AuthUser>
  hashPassword(password: string): Promise<string>
  verifyPassword(password: string, digest: string): Promise<boolean>
  needsPasswordRehash(digest: string): Promise<boolean>
  guard(name: string): AuthGuardFacade
  tokens: AuthTokenFacade
  verification: AuthEmailVerificationFacade
  passwords: AuthPasswordResetFacade
}

export interface AuthProviderAdapter<TUser = unknown> {
  findById(id: string | number): Promise<TUser | null>
  findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<TUser | null>
  create(input: Readonly<Record<string, unknown>>): Promise<TUser>
  update?(user: TUser, input: Readonly<Record<string, unknown>>): Promise<TUser>
  matchesUser?(user: unknown): boolean
  getId(user: TUser): string | number
  getPasswordHash?(user: TUser): string | null | undefined
  getEmailVerifiedAt?(user: TUser): Date | string | null | undefined
  serialize?(user: TUser): AuthUser
}

export interface AuthPasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, digest: string): Promise<boolean>
  needsRehash?(digest: string): boolean | Promise<boolean>
}

export interface PersonalAccessTokenRecord {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly name: string
  readonly abilities: readonly string[]
  readonly tokenHash: string
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
}

export interface PersonalAccessTokenCreationOptions {
  readonly name: string
  readonly abilities?: readonly string[]
  readonly expiresAt?: Date | null
  readonly guard?: string
}

export interface PersonalAccessTokenResult {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly name: string
  readonly abilities: readonly string[]
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
  readonly plainTextToken: string
}

export interface AuthTokenStore {
  create(record: PersonalAccessTokenRecord): Promise<void>
  findById(id: string): Promise<PersonalAccessTokenRecord | null>
  listByUserId(provider: string, userId: string | number): Promise<readonly PersonalAccessTokenRecord[]>
  update(record: PersonalAccessTokenRecord): Promise<void>
  delete(id: string): Promise<void>
  deleteByUserId(provider: string, userId: string | number): Promise<number>
}

export interface AuthTokenFacade {
  create(user: unknown, options: PersonalAccessTokenCreationOptions): Promise<PersonalAccessTokenResult>
  list(user: unknown, options?: { readonly guard?: string }): Promise<readonly PersonalAccessTokenRecord[]>
  revoke(options?: { readonly guard?: string }): Promise<void>
  revokeAll(user: unknown, options?: { readonly guard?: string }): Promise<number>
  authenticate(plainTextToken: string): Promise<AuthUser | null>
  can(token: string, ability: string): Promise<boolean>
}

export interface AuthCurrentAccessToken extends Omit<PersonalAccessTokenRecord, 'abilities' | 'createdAt' | 'lastUsedAt' | 'expiresAt'> {
  readonly abilities: readonly string[]
  readonly createdAt: Date
  readonly lastUsedAt?: Date
  readonly expiresAt?: Date | null
  delete(): Promise<void>
}

export interface EmailVerificationTokenRecord {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly email: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface EmailVerificationTokenResult {
  readonly id: string
  readonly provider: string
  readonly userId: string | number
  readonly email: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly plainTextToken: string
}

export interface PasswordResetTokenRecord {
  readonly id: string
  readonly provider: string
  readonly email: string
  readonly table?: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface PasswordResetTokenResult {
  readonly id: string
  readonly provider: string
  readonly email: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly plainTextToken: string
}

export interface EmailVerificationTokenStore {
  create(record: EmailVerificationTokenRecord): Promise<void>
  findById(id: string): Promise<EmailVerificationTokenRecord | null>
  delete(id: string): Promise<void>
  deleteByUserId(provider: string, userId: string | number): Promise<number>
}

export interface PasswordResetTokenStore {
  create(record: PasswordResetTokenRecord): Promise<void>
  findById(id: string): Promise<PasswordResetTokenRecord | null>
  findLatestByEmail(
    provider: string,
    email: string,
    options?: { readonly table?: string },
  ): Promise<PasswordResetTokenRecord | null>
  delete(id: string, options?: { readonly table?: string }): Promise<void>
  deleteByEmail(provider: string, email: string, options?: { readonly table?: string }): Promise<number>
}

export interface AuthDeliveryHook {
  sendEmailVerification(input: {
    readonly provider: string
    readonly user: AuthUser
    readonly email: string
    readonly token: EmailVerificationTokenResult
  }): Promise<void>
  sendPasswordReset(input: {
    readonly provider: string
    readonly email: string
    readonly token: PasswordResetTokenResult
  }): Promise<void>
}

export interface AuthEmailVerificationFacade {
  create(user: unknown, options?: { readonly guard?: string, readonly expiresAt?: Date }): Promise<EmailVerificationTokenResult>
  consume(plainTextToken: string): Promise<AuthUser>
}

export interface AuthPasswordResetFacade {
  request(email: string, options?: { readonly broker?: string, readonly expiresAt?: Date }): Promise<void>
  consume(input: {
    readonly token: string
    readonly password: string
    readonly passwordConfirmation: string
  }): Promise<AuthUser>
}

export interface AuthSessionRecord {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}

export interface AuthSessionRuntime {
  create(input?: {
    readonly store?: string
    readonly data?: Readonly<Record<string, unknown>>
    readonly id?: string
  }): Promise<AuthSessionRecord>
  write?(record: AuthSessionRecord): Promise<AuthSessionRecord>
  read(
    sessionId: string,
    options?: { readonly store?: string },
  ): Promise<AuthSessionRecord | null>
  touch(
    sessionId: string,
    options?: { readonly store?: string },
  ): Promise<AuthSessionRecord | null>
  invalidate(
    sessionId: string,
    options?: { readonly store?: string },
  ): Promise<void>
  issueRememberMeToken(
    sessionId: string,
    options?: { readonly store?: string },
  ): Promise<string>
  cookie?(
    name: string,
    value: string,
    options?: Record<string, unknown>,
  ): string
  sessionCookie(
    value: string,
    options?: Record<string, unknown>,
  ): string
  rememberMeCookie(
    value: string,
    options?: Record<string, unknown>,
  ): string
}

export interface AuthRuntimeContext {
  getSessionId(guardName: string): string | undefined
  setSessionId(guardName: string, sessionId?: string): void
  getCachedUser(guardName: string): AuthUser | null | undefined
  setCachedUser(guardName: string, user: AuthUser | null): void
  getAccessToken?(guardName: string): string | undefined
  setAccessToken?(guardName: string, token?: string): void
  getRememberToken?(guardName: string): string | undefined
  setRememberToken?(guardName: string, token?: string): void
}

export interface AuthRuntimeBindings {
  readonly config: HoloAuthConfig | NormalizedHoloAuthConfig
  readonly session: AuthSessionRuntime
  readonly providers: Readonly<Record<string, AuthProviderAdapter>>
  readonly tokens?: AuthTokenStore
  readonly emailVerificationTokens?: EmailVerificationTokenStore
  readonly passwordResetTokens?: PasswordResetTokenStore
  readonly delivery?: AuthDeliveryHook
  readonly context?: AuthRuntimeContext
  readonly passwordHasher?: AuthPasswordHasher
}

export interface AuthRuntimeFacade extends AuthFacade {
  logoutAll(guardName?: string): Promise<readonly AuthLogoutResult[]>
}

export interface AuthEstablishedSession {
  readonly guard: string
  readonly user: AuthUser
  readonly sessionId: string
  readonly rememberToken?: string
  readonly cookies: readonly string[]
}

export interface CurrentAuthResponse {
  readonly authenticated: boolean
  readonly guard: string
  readonly user: AuthUser | null
}

export interface AuthClientConfig {
  readonly endpoint?: string
  readonly guard?: string
  readonly headers?: Record<string, string> | readonly (readonly [string, string])[]
  readonly fetch?: typeof fetch
}

export interface AuthClientRequestOptions {
  readonly guard?: string
  readonly endpoint?: string
  readonly headers?: Record<string, string> | readonly (readonly [string, string])[]
}
