export { defineAuthConfig } from '@holo-js/config'
export type { AuthGuardConfig, AuthProviderConfig, HoloAuthConfig, NormalizedHoloAuthConfig } from '@holo-js/config'
import type { HoloAuthConfig, NormalizedHoloAuthConfig } from '@holo-js/config'

export const AUTH_ERROR_CODES = [
  'runtime_unconfigured',
  'token_runtime_unconfigured',
  'email_verification_runtime_unconfigured',
  'password_reset_runtime_unconfigured',
  'guard_not_configured',
  'provider_not_configured',
  'provider_runtime_not_configured',
  'guard_session_login_unsupported',
  'credentials_identifier_missing',
  'password_confirmation_mismatch',
  'invalid_credentials',
  'email_verification_required',
  'trusted_login_user_required',
  'trusted_login_provider_mismatch',
  'trusted_login_user_not_found',
  'trusted_login_user_incompatible',
  'impersonation_actor_required',
  'impersonation_nested_unsupported',
  'impersonation_already_active',
  'registration_identifier_taken',
  'auth_user_missing',
  'provider_resolution_required',
  'provider_update_unsupported',
  'email_required_for_verification',
  'email_verification_user_missing',
  'email_already_verified',
  'email_verification_token_invalid',
  'email_verification_token_expired',
  'password_reset_email_required',
  'password_broker_not_configured',
  'password_reset_token_invalid',
  'password_reset_token_expired',
  'password_reset_user_missing',
] as const

export type AuthErrorCode = typeof AUTH_ERROR_CODES[number]

export interface AuthErrorOptions {
  readonly cause?: unknown
  readonly details?: Readonly<Record<string, unknown>>
}

export class AuthError<TCode extends AuthErrorCode = AuthErrorCode> extends Error {
  readonly code: TCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: TCode, message: string, options: AuthErrorOptions = {}) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.details = options.details

    if ('cause' in options) {
      this.cause = options.cause
    }
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError
    || (
      !!value
      && typeof value === 'object'
      && (value as { name?: unknown }).name === 'AuthError'
      && typeof (value as { code?: unknown }).code === 'string'
      && (AUTH_ERROR_CODES as readonly string[]).includes((value as { code: string }).code)
      && typeof (value as { message?: unknown }).message === 'string'
    )
}

export type AuthFieldErrors<TField extends string = string> = Partial<Record<TField, readonly string[]>>

export type AuthInputFieldErrors<
  TInput extends Readonly<Record<string, unknown>>,
  TExtraField extends string = never,
> = AuthFieldErrors<Extract<keyof TInput, string> | TExtraField>

export interface AuthFailure<TCode extends AuthErrorCode = AuthErrorCode, TFields extends AuthFieldErrors = AuthFieldErrors> {
  readonly code: TCode
  readonly message: string
  readonly status: number
  readonly fields: TFields
}

export interface AuthSuccessResult<TData> {
  readonly data: TData
  readonly error: null
}

export interface AuthFailureResult<
  TCode extends AuthErrorCode = AuthErrorCode,
  TFields extends AuthFieldErrors = AuthFieldErrors,
> {
  readonly data: null
  readonly error: AuthFailure<TCode, TFields>
}

export type AuthResult<
  TData,
  TCode extends AuthErrorCode = AuthErrorCode,
  TFields extends AuthFieldErrors = AuthFieldErrors,
>
  = AuthSuccessResult<TData>
  | AuthFailureResult<TCode, TFields>

export type AuthLoginErrorCode
  = 'credentials_identifier_missing'
  | 'invalid_credentials'
  | 'email_verification_required'

export type AuthRegistrationErrorCode
  = 'credentials_identifier_missing'
  | 'password_confirmation_mismatch'
  | 'registration_identifier_taken'

export type AuthEmailVerificationConsumeErrorCode
  = 'email_verification_token_invalid'
  | 'email_verification_token_expired'
  | 'auth_user_missing'
  | 'provider_update_unsupported'

export type AuthEmailVerificationResendErrorCode
  = 'email_verification_user_missing'
  | 'email_already_verified'

export type AuthPasswordResetRequestErrorCode
  = 'password_reset_email_required'

export type AuthPasswordResetConsumeErrorCode
  = 'password_confirmation_mismatch'
  | 'password_reset_token_invalid'
  | 'password_reset_token_expired'
  | 'password_reset_user_missing'
  | 'auth_user_missing'
  | 'provider_update_unsupported'

export interface AuthUserLike {
  readonly id?: string | number
  readonly email?: string
  readonly name?: string
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

export type HoloAuthUser = AuthUser

export interface AuthCredentials extends Readonly<Record<string, unknown>> {
  readonly password: string
  readonly remember?: boolean
}

export interface AuthRegistrationInput extends AuthCredentials {
  readonly passwordConfirmation: string
}

export interface AuthPasswordResetRequestInput extends Readonly<Record<string, unknown>> {
  readonly email: string
}

export interface AuthPasswordResetInput extends Readonly<Record<string, unknown>> {
  readonly token: string
  readonly password: string
  readonly passwordConfirmation: string
}

export interface AuthPasswordResetRequestOptions {
  readonly broker?: string
  readonly expiresAt?: Date
}

export interface AuthEmailVerificationSendOptions {
  readonly guard?: string
  readonly expiresAt?: Date
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
  login<TCredentials extends AuthCredentials>(
    credentials: TCredentials,
  ): Promise<AuthResult<AuthEstablishedSession, AuthLoginErrorCode, AuthInputFieldErrors<TCredentials>>>
  loginUsing(user: unknown, options?: AuthSessionLoginOptions): Promise<AuthEstablishedSession>
  loginUsingId(userId: string | number, options?: AuthSessionLoginOptions): Promise<AuthEstablishedSession>
  impersonate(user: unknown, options?: AuthImpersonationOptions): Promise<AuthEstablishedSession>
  impersonateById(userId: string | number, options?: AuthImpersonationOptions): Promise<AuthEstablishedSession>
  impersonation(): Promise<AuthImpersonationState | null>
  stopImpersonating(): Promise<AuthUser | null>
  logout(): Promise<AuthLogoutResult>
}

export interface AuthFacade extends AuthGuardFacade {
  register<TInput extends AuthRegistrationInput>(
    input: TInput,
  ): Promise<AuthResult<AuthUser, AuthRegistrationErrorCode, AuthInputFieldErrors<TInput>>>
  requestPasswordReset<TInput extends AuthPasswordResetRequestInput>(
    input: TInput,
    options?: AuthPasswordResetRequestOptions,
  ): Promise<AuthResult<void, AuthPasswordResetRequestErrorCode, AuthInputFieldErrors<TInput>>>
  resetPassword<TInput extends AuthPasswordResetInput>(
    input: TInput,
  ): Promise<AuthResult<AuthUser, AuthPasswordResetConsumeErrorCode, AuthInputFieldErrors<TInput>>>
  verifyEmail(token: string): Promise<AuthResult<AuthUser, AuthEmailVerificationConsumeErrorCode, AuthFieldErrors<'token'>>>
  sendEmailVerification(): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  sendEmailVerification(email: string): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  sendEmailVerification(email: string | undefined): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  sendEmailVerification(email: string | undefined, options: AuthEmailVerificationSendOptions): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  resendEmailVerification(): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  resendEmailVerification(email: string): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  resendEmailVerification(email: string | undefined): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  resendEmailVerification(email: string | undefined, options: AuthEmailVerificationSendOptions): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  hashPassword(password: string): Promise<string>
  verifyPassword(password: string, digest: string): Promise<boolean>
  needsPasswordRehash(digest: string): Promise<boolean>
  guard(name: string): AuthGuardFacade
  tokens: AuthTokenFacade
  verification: AuthEmailVerificationFacade
}

type AuthProviderAdapterBase<TUser> = {
  findById(id: string | number): Promise<TUser | null>
  findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<TUser | null>
  create(input: Readonly<Record<string, unknown>>): Promise<TUser>
  delete?(id: string | number): Promise<void>
  update?(user: TUser, input: Readonly<Record<string, unknown>>): Promise<TUser>
  matchesUser?(user: unknown): boolean
  getId(user: TUser): string | number
  getPasswordHash?(user: TUser): string | null | undefined
  getEmailVerifiedAt?(user: TUser): Date | string | null | undefined
}

export type AuthProviderAdapter<TUser = AuthUser> = AuthProviderAdapterBase<TUser> & (
  TUser extends AuthUser
    ? {
        serialize?(user: TUser): AuthUser
      }
    : {
        serialize(user: TUser): AuthUser
      }
)

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
    readonly route: string
  }): Promise<void>
  sendPasswordReset(input: {
    readonly broker: string
    readonly provider: string
    readonly email: string
    readonly token: PasswordResetTokenResult
    readonly route: string
  }): Promise<void>
}

export interface AuthEmailVerificationFacade {
  create(user: unknown, options?: { readonly guard?: string, readonly expiresAt?: Date }): Promise<EmailVerificationTokenResult>
  resend(options?: { readonly guard?: string, readonly expiresAt?: Date, readonly email?: string }): Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>
  consume(plainTextToken: string): Promise<AuthResult<AuthUser, AuthEmailVerificationConsumeErrorCode, AuthFieldErrors<'token'>>>
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
  consumeRememberMeToken?(
    token: string,
    options?: { readonly store?: string },
  ): Promise<AuthSessionRecord | null>
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
  getRequestCookie?(name: string): string | undefined | Promise<string | undefined>
  getRequestHeader?(name: string): string | undefined | Promise<string | undefined>
  appendResponseCookie?(cookie: string): void | Promise<void>
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
  readonly emailVerificationRequired?: boolean
  readonly emailVerificationRoute?: string
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
