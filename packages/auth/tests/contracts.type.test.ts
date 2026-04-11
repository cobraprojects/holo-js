import { describe, expectTypeOf, it } from 'vitest'
import auth, { getAuthRuntime, type AuthEstablishedSession, type AuthGuardFacade, type AuthImpersonationState, type AuthLogoutResult, type AuthProviderAdapter, type AuthRuntimeBindings, type AuthUser, type CurrentAuthResponse, type register, type user } from '../src'
import clientAuth, { type refreshUser as refreshClientUser, type user as clientUser } from '../src/client'

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
    type RefreshedClientUser = Awaited<ReturnType<typeof refreshClientUser>>
    type GuardUser = Awaited<ReturnType<AuthGuardFacade['user']>>
    type GuardRefreshedUser = Awaited<ReturnType<AuthGuardFacade['refreshUser']>>
    type TrustedSession = Awaited<ReturnType<AuthGuardFacade['loginUsing']>>
    type TrustedIdSession = Awaited<ReturnType<AuthGuardFacade['loginUsingId']>>
    type ImpersonatedSession = Awaited<ReturnType<AuthGuardFacade['impersonate']>>
    type GuardImpersonation = Awaited<ReturnType<AuthGuardFacade['impersonation']>>
    type StopImpersonation = Awaited<ReturnType<AuthGuardFacade['stopImpersonating']>>
    type GuardLogout = Awaited<ReturnType<AuthGuardFacade['logout']>>
    type RuntimeLogoutAll = Awaited<ReturnType<ReturnType<typeof getAuthRuntime>['logoutAll']>>

    expectTypeOf<AuthUser>().toEqualTypeOf<AppAuthUser>()
    expectTypeOf<RegisteredUser>().toEqualTypeOf<AppAuthUser>()
    expectTypeOf<CurrentServerUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<CurrentClientUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<RefreshedClientUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardRefreshedUser>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<TrustedSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<TrustedIdSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<ImpersonatedSession>().toEqualTypeOf<AuthEstablishedSession>()
    expectTypeOf<GuardImpersonation>().toEqualTypeOf<AuthImpersonationState | null>()
    expectTypeOf<StopImpersonation>().toEqualTypeOf<AppAuthUser | null>()
    expectTypeOf<GuardLogout>().toEqualTypeOf<AuthLogoutResult>()
    expectTypeOf<RuntimeLogoutAll>().toEqualTypeOf<readonly AuthLogoutResult[]>()
    expectTypeOf<CurrentAuthResponse['user']>().toEqualTypeOf<AppAuthUser | null>()

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
    expectTypeOf(auth.user).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
    expectTypeOf(auth.loginUsing).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.loginUsingId).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.hashPassword).returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf(auth.verifyPassword).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(auth.needsPasswordRehash).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(auth.impersonate).returns.toEqualTypeOf<Promise<AuthEstablishedSession>>()
    expectTypeOf(auth.impersonation).returns.toEqualTypeOf<Promise<AuthImpersonationState | null>>()
    expectTypeOf(auth.stopImpersonating).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
    expectTypeOf(auth.logout).returns.toEqualTypeOf<Promise<AuthLogoutResult>>()
    expectTypeOf(clientAuth.user).returns.toEqualTypeOf<Promise<AppAuthUser | null>>()
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
    const invalidPasswordResetInput: Parameters<typeof auth.passwords.consume>[0] = {
      token: 'token-value',
      password: 'secret-secret',
    }

    void invalidRegisterInput
    void invalidPasswordResetInput
  })
})
