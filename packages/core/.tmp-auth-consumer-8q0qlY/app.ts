
import { expectTypeOf } from 'vitest'
import auth, { type AuthenticatedAuthUser, type AuthUser } from '@holo-js/auth'
import { type HoloRuntime } from '../src'
import { syncIdentity as syncClerkIdentity } from '@holo-js/auth-clerk'
import { syncIdentity as syncWorkosIdentity } from '@holo-js/auth-workos'
import { callback as authenticateSocial } from '@holo-js/auth-social'

type AppUser = {
  readonly id: number
  readonly email: string
  readonly name: string
  readonly role: 'admin' | 'member'
  readonly created_at: string
}

declare module '@holo-js/auth' {
  interface HoloAuthTypeRegistry {
    user: AppUser
  }
}

expectTypeOf<AuthUser>().toEqualTypeOf<AppUser>()
expectTypeOf(auth.user).returns.toEqualTypeOf<Promise<AuthenticatedAuthUser | null>>()
expectTypeOf<Awaited<ReturnType<NonNullable<HoloRuntime['auth']>['user']>>>().toEqualTypeOf<AuthenticatedAuthUser | null>()
void [syncClerkIdentity, syncWorkosIdentity, authenticateSocial]
