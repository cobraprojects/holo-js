import type {
  AuthCredentials,
  AuthCurrentAccessToken,
  AuthEmailVerificationFacade,
  AuthEstablishedSession,
  AuthImpersonationOptions,
  AuthImpersonationState,
  AuthLogoutResult,
  AuthPasswordResetInput,
  AuthPasswordResetRequestInput,
  AuthPasswordResetRequestOptions,
  AuthRegistrationInput,
  AuthSessionLoginOptions,
  AuthTokenFacade,
  AuthenticatedAuthUser,
  PersonalAccessTokenCreationOptions,
} from './contracts'
import { getAuthRuntime } from './runtime'

export async function check(): Promise<boolean> {
  return getAuthRuntime().check()
}

export async function user(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().user()
}

export async function refreshUser(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().refreshUser()
}

export async function provider(): Promise<string | null> {
  return getAuthRuntime().provider()
}

export async function id(): Promise<string | number | null> {
  return getAuthRuntime().id()
}

export async function currentAccessToken(): Promise<AuthCurrentAccessToken | null> {
  return getAuthRuntime().currentAccessToken()
}

export async function login<TCredentials extends AuthCredentials>(
  credentials: TCredentials,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().login(credentials)
}

export async function loginUsing(
  authenticatedUser: unknown,
  options?: AuthSessionLoginOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().loginUsing(authenticatedUser, options)
}

export async function loginUsingId(
  userId: string | number,
  options?: AuthSessionLoginOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().loginUsingId(userId, options)
}

export async function impersonate(
  authenticatedUser: unknown,
  options?: AuthImpersonationOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().impersonate(authenticatedUser, options)
}

export async function impersonateById(
  userId: string | number,
  options?: AuthImpersonationOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().impersonateById(userId, options)
}

export async function impersonation(): Promise<AuthImpersonationState | null> {
  return getAuthRuntime().impersonation()
}

export async function stopImpersonating(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().stopImpersonating()
}

export async function logout(): Promise<AuthLogoutResult> {
  return getAuthRuntime().logout()
}

export async function register<TInput extends AuthRegistrationInput>(
  input: TInput,
): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().register(input)
}

export async function requestPasswordReset<TInput extends AuthPasswordResetRequestInput>(
  input: TInput,
  options?: AuthPasswordResetRequestOptions,
): Promise<void> {
  return getAuthRuntime().requestPasswordReset(input, options)
}

export async function resetPassword<TInput extends AuthPasswordResetInput>(
  input: TInput,
): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().resetPassword(input)
}

export function verifyEmail(token: string): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().verifyEmail(token)
}

export const tokens: AuthTokenFacade = Object.freeze({
  create(authenticatedUser: unknown, options: PersonalAccessTokenCreationOptions) {
    return getAuthRuntime().tokens.create(authenticatedUser, options)
  },
  list(authenticatedUser: unknown, options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.list(authenticatedUser, options)
  },
  revoke(options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.revoke(options)
  },
  revokeAll(authenticatedUser: unknown, options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.revokeAll(authenticatedUser, options)
  },
  authenticate(plainTextToken: string) {
    return getAuthRuntime().tokens.authenticate(plainTextToken)
  },
  can(token: string, ability: string) {
    return getAuthRuntime().tokens.can(token, ability)
  },
})

export const verification: AuthEmailVerificationFacade = Object.freeze({
  create(authenticatedUser: unknown, options?: { readonly guard?: string, readonly expiresAt?: Date }) {
    return getAuthRuntime().verification.create(authenticatedUser, options)
  },
  resend(options?: { readonly guard?: string, readonly expiresAt?: Date, readonly email?: string }) {
    return getAuthRuntime().verification.resend(options)
  },
  consume(plainTextToken: string) {
    return getAuthRuntime().verification.consume(plainTextToken)
  },
})
