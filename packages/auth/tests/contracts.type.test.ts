import { describe, expectTypeOf, it } from 'vitest'
import auth, { AuthError, isAuthError, type AuthEmailVerificationConsumeErrorCode, type AuthEmailVerificationResendErrorCode, type AuthErrorCode, type AuthEstablishedSession, type AuthFailure, type AuthFieldErrors, type AuthGuardFacade, type AuthImpersonationState, type AuthLoginErrorCode, type AuthLogoutResult, type AuthPasswordResetConsumeErrorCode, type AuthPasswordResetRequestErrorCode, type AuthProviderAdapter, type AuthRegistrationErrorCode, type AuthResult, type AuthRuntimeBindings, type AuthUser, type CurrentAuthResponse, type EmailVerificationTokenResult, type getAuthRuntime, type HoloAuthUser, type PersonalAccessTokenResult, type register, type user, type verifyEmail } from '../src'
import clientAuth, { type provider as clientProvider, type refreshUser as refreshClientUser, type useAuth as clientUseAuth, type user as clientUser } from '../src/client'
import type { useAuth as useNextAuth } from '../src/next/client'
import type { useAuth as useNuxtAuth } from '../src/nuxt'
import type { useAuth as useSvelteKitAuth } from '../src/sveltekit/client'

declare module '../src' {
  interface HoloAuthTypeRegistry {
    user: {
      readonly id: number
      readonly email: string
      readonly name: string
      readonly role: 'admin' | 'member'
      readonly avatarUrl?: string | null
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace HoloAuth {
    export interface TypeRegistry {
      guards: {
        readonly web: 'session'
        readonly api: 'token'
      }
    }
  }
}

describe('@holo-js/auth typing', () => {
  it('preserves the augmented auth user shape across server and client helpers', () => {
    type AppAuthUser = {
      readonly id: number
      readonly email: string
      readonly name: string
      readonly role: 'admin' | 'member'
      readonly avatarUrl?: string | null
    }

    type RegisteredUser = Awaited<ReturnType<typeof register>>
    type CurrentServerUser = Awaited<ReturnType<typeof user>>
    type CurrentClientUser = Awaited<ReturnType<typeof clientUser>>
    type CurrentClientAuth = Awaited<ReturnType<typeof clientUseAuth>>
    type CurrentClientProvider = Awaited<ReturnType<typeof clientProvider>>
    type CurrentNextAuth = ReturnType<typeof useNextAuth>
    type CurrentNuxtAuth = Awaited<ReturnType<typeof useNuxtAuth>>
    type CurrentSvelteKitAuth = ReturnType<typeof useSvelteKitAuth>
    type RefreshedClientUser = Awaited<ReturnType<typeof refreshClientUser>>
    type GuardProvider = Awaited<ReturnType<AuthGuardFacade['provider']>>
    type GuardUser = Awaited<ReturnType<AuthGuardFacade['user']>>
    type GuardRefreshedUser = Awaited<ReturnType<AuthGuardFacade['refreshUser']>>
    type WebGuardLogin = Awaited<ReturnType<ReturnType<typeof auth.guard<'web'>>['login']>>
    type ApiGuardLogin = Awaited<ReturnType<ReturnType<typeof auth.guard<'api'>>['login']>>
    type ApiGuardRegister = Awaited<ReturnType<ReturnType<typeof auth.guard<'api'>>['register']>>
    type GuardLogin = Awaited<ReturnType<AuthGuardFacade['login']>>
    type GuardRegister = Awaited<ReturnType<AuthGuardFacade['register']>>
    type TrustedSession = Awaited<ReturnType<AuthGuardFacade['loginUsing']>>
    type TrustedIdSession = Awaited<ReturnType<AuthGuardFacade['loginUsingId']>>
    type ImpersonatedSession = Awaited<ReturnType<AuthGuardFacade['impersonate']>>
    type GuardImpersonation = Awaited<ReturnType<AuthGuardFacade['impersonation']>>
    type StopImpersonation = Awaited<ReturnType<AuthGuardFacade['stopImpersonating']>>
    type GuardLogout = Awaited<ReturnType<AuthGuardFacade['logout']>>
    type RuntimeLogoutAll = Awaited<ReturnType<ReturnType<typeof getAuthRuntime>['logoutAll']>>

    expectTypeOf<AuthUser>().toEqualTypeOf<AppAuthUser>()
    expectTypeOf<HoloAuthUser>().toEqualTypeOf<AppAuthUser>()
    expectTypeOf<RegisteredUser>().toEqualTypeOf<AuthResult<AppAuthUser, AuthRegistrationErrorCode>>()
    expectTypeOf<CurrentServerUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentClientUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentClientAuth>().toEqualTypeOf<CurrentAuthResponse & {
      readonly check: () => boolean
      readonly refreshUser: () => Promise<AppAuthUser | null>
    }>()
    expectTypeOf<CurrentClientProvider>().toEqualTypeOf<string | null>()
    expectTypeOf<CurrentNextAuth['user']>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentNextAuth['provider']>().toEqualTypeOf<string | null>()
    expectTypeOf<CurrentNuxtAuth['user']['value']>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentNuxtAuth['provider']['value']>().toEqualTypeOf<string | null>()
    expectTypeOf<CurrentSvelteKitAuth['user']>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentSvelteKitAuth['provider']>().toEqualTypeOf<string | null>()
    expectTypeOf<RefreshedClientUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardProvider>().toEqualTypeOf<string | null>()
    expectTypeOf<GuardUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardRefreshedUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<WebGuardLogin>().toEqualTypeOf<AuthResult<AuthEstablishedSession, AuthLoginErrorCode>>()
    expectTypeOf<ApiGuardLogin>().toEqualTypeOf<AuthResult<PersonalAccessTokenResult, AuthLoginErrorCode>>()
    expectTypeOf<ApiGuardRegister>().toEqualTypeOf<AuthResult<PersonalAccessTokenResult, AuthRegistrationErrorCode>>()
    expectTypeOf<GuardLogin>().toEqualTypeOf<AuthResult<AuthEstablishedSession | PersonalAccessTokenResult, AuthLoginErrorCode>>()
    expectTypeOf<GuardRegister>().toEqualTypeOf<AuthResult<AppAuthUser | PersonalAccessTokenResult, AuthRegistrationErrorCode>>()
    expectTypeOf<TrustedSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<TrustedIdSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<ImpersonatedSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<GuardImpersonation>().toEqualTypeOf<AuthImpersonationState | null>()
    expectTypeOf<StopImpersonation>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardLogout>().toEqualTypeOf<AuthLogoutResult>()
    expectTypeOf<RuntimeLogoutAll>().toEqualTypeOf<readonly AuthLogoutResult[]>()
    expectTypeOf<CurrentAuthResponse['user']>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentAuthResponse['provider']>().toEqualTypeOf<string | null>()

    const adapter: AuthProviderAdapter<{
      readonly id: number
      readonly email: string
      readonly firstName: string
      readonly lastName: string
      readonly role: 'admin' | 'member'
    }> = {
      async findById() {
        return null
      },
      async findByCredentials() {
        return null
      },
      async create() {
        return {
          id: 1,
          email: 'ava@example.com',
          firstName: 'Ava',
          lastName: 'Stone',
          role: 'admin',
        }
      },
      getId(userRecord) {
        return userRecord.id
      },
      serialize(userRecord) {
        return {
          id: userRecord.id,
          email: userRecord.email,
          name: `${userRecord.firstName} ${userRecord.lastName}`,
          role: userRecord.role,
          avatarUrl: null,
        }
      },
    }

    expectTypeOf(adapter.serialize).returns.toEqualTypeOf<AppAuthUser>()
    expectTypeOf(adapter.delete).toEqualTypeOf<((id: string | number) => Promise<void>) | undefined>()
    expectTypeOf(auth.user).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
    expectTypeOf(auth.provider).returns.toEqualTypeOf<Promise<string | null>>()
    expectTypeOf(auth.login).returns.toEqualTypeOf<Promise<AuthResult<AuthEstablishedSession, AuthLoginErrorCode>>>()
    expectTypeOf(auth.loginUsing).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.loginUsingId).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.hashPassword).returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf(auth.verifyPassword).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(auth.needsPasswordRehash).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(auth.impersonate).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.impersonation).returns.toEqualTypeOf<Promise<AuthImpersonationState | null>>()
    expectTypeOf(auth.stopImpersonating).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
    expectTypeOf(auth.logout).returns.toEqualTypeOf<Promise<AuthLogoutResult>>()
    expectTypeOf(auth.verifyEmail).parameter(0).toEqualTypeOf<string>()
    expectTypeOf(auth.verifyEmail).returns.toEqualTypeOf<Promise<AuthResult<AppAuthUser, AuthEmailVerificationConsumeErrorCode, AuthFieldErrors<'token'>>>>()
    expectTypeOf(auth.sendEmailVerification).parameter(0).toEqualTypeOf<string | undefined>()
    expectTypeOf(auth.sendEmailVerification).returns.toEqualTypeOf<Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>>()
    expectTypeOf(auth.resendEmailVerification).parameter(0).toEqualTypeOf<string | undefined>()
    expectTypeOf(auth.resendEmailVerification).returns.toEqualTypeOf<Promise<AuthResult<EmailVerificationTokenResult, AuthEmailVerificationResendErrorCode, AuthFieldErrors<'_root'>>>>()
    expectTypeOf(clientAuth.user).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
    expectTypeOf(clientAuth.provider).returns.toEqualTypeOf<Promise<string | null>>()
    expectTypeOf(clientAuth.useAuth).returns.toEqualTypeOf<Promise<CurrentAuthResponse & {
      readonly check: () => boolean
      readonly refreshUser: () => Promise<AppAuthUser | null>
    }>>()

    async function requestPasswordResetResult() {
      return await auth.requestPasswordReset({
        email: 'ava@example.com',
      })
    }

    async function resetPasswordResult() {
      return await auth.resetPassword({
        token: 'token-value',
        password: 'secret-secret',
        passwordConfirmation: 'secret-secret',
      })
    }

    expectTypeOf<Awaited<ReturnType<typeof requestPasswordResetResult>>>().toEqualTypeOf<
      AuthResult<void, AuthPasswordResetRequestErrorCode, {
        email?: readonly string[]
      }>
    >()
    expectTypeOf<Awaited<ReturnType<typeof resetPasswordResult>>>().toEqualTypeOf<
      AuthResult<AppAuthUser, AuthPasswordResetConsumeErrorCode, {
        token?: readonly string[]
        password?: readonly string[]
        passwordConfirmation?: readonly string[]
      }>
    >()
    expectTypeOf<Awaited<ReturnType<typeof verifyEmail>>>().toEqualTypeOf<
      AuthResult<AppAuthUser, AuthEmailVerificationConsumeErrorCode, AuthFieldErrors<'token'>>
    >()
  })

  it('keeps legacy custom session runtimes assignable to auth runtime bindings', () => {
    const legacySession: AuthRuntimeBindings['session'] = {
      async create() {
        throw new Error('not implemented')
      },
      async read() {
        return null
      },
      async touch() {
        return null
      },
      async invalidate() {},
      async issueRememberMeToken() {
        return 'remember-token'
      },
      sessionCookie() {
        return 'session=value'
      },
      rememberMeCookie() {
        return 'remember=value'
      },
    }

    expectTypeOf(legacySession).toEqualTypeOf<AuthRuntimeBindings['session']>()
  })

  it('requires password confirmation for registration and password reset consumption', () => {
    // @ts-expect-error passwordConfirmation must be required
    const invalidRegisterInput: Parameters<typeof auth.register>[0] = {
      email: 'ava@example.com',
      password: 'secret-secret',
    }
    // @ts-expect-error passwordConfirmation must be required
    const invalidPasswordResetInput: Parameters<typeof auth.resetPassword>[0] = {
      token: 'token-value',
      password: 'secret-secret',
    }

    void invalidRegisterInput
    void invalidPasswordResetInput
  })

  it('exposes a public auth error discriminator for catch-time narrowing', () => {
    expectTypeOf<AuthErrorCode>().toEqualTypeOf<
      | 'runtime_unconfigured'
      | 'token_runtime_unconfigured'
      | 'email_verification_runtime_unconfigured'
      | 'password_reset_runtime_unconfigured'
      | 'guard_not_configured'
      | 'provider_not_configured'
      | 'provider_runtime_not_configured'
      | 'guard_session_login_unsupported'
      | 'credentials_identifier_missing'
      | 'password_confirmation_mismatch'
      | 'invalid_credentials'
      | 'email_verification_required'
      | 'trusted_login_user_required'
      | 'trusted_login_provider_mismatch'
      | 'trusted_login_user_not_found'
      | 'trusted_login_user_incompatible'
      | 'impersonation_actor_required'
      | 'impersonation_nested_unsupported'
      | 'impersonation_already_active'
      | 'registration_identifier_taken'
      | 'auth_user_missing'
      | 'provider_resolution_required'
      | 'provider_update_unsupported'
      | 'email_required_for_verification'
      | 'email_verification_user_missing'
      | 'email_already_verified'
      | 'email_verification_token_invalid'
      | 'email_verification_token_expired'
      | 'password_reset_email_required'
      | 'password_broker_not_configured'
      | 'password_reset_token_invalid'
      | 'password_reset_token_expired'
      | 'password_reset_user_missing'
    >()

    const error: unknown = null
    if (isAuthError(error)) {
      const code: AuthErrorCode = error.code
      void code
    }
  })

  it('exposes plain auth failure objects in result unions', () => {
    expectTypeOf<AuthFailure<AuthLoginErrorCode, {
      email?: readonly string[]
      password?: readonly string[]
    }>>().toMatchTypeOf<{
      code: AuthLoginErrorCode
      message: string
      status: number
      fields: {
        email?: readonly string[]
        password?: readonly string[]
      }
    }>()
  })
})
