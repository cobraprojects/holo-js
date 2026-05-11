import { describe, expectTypeOf, it } from 'vitest'
import { completeClerkAuth } from '../src'
import type { ClerkAuthFacade, ClerkCompleteAuthResult } from '../src'

describe('@holo-js/auth-clerk typing', () => {
  it('accepts hosted route request-like inputs and preserves mapped callback users', () => {
    type NuxtEventLike = {
      readonly node: {
        readonly req: {
          readonly method: 'GET'
          readonly url: '/api/auth/clerk/login'
          readonly headers: {
            readonly host: 'app.test'
          }
        }
      }
    }
    type MappedUser = Readonly<{
      email: string
      name: string
      avatar: string | null
      clerkUserId: string
    }>

    expectTypeOf<NuxtEventLike>().toMatchTypeOf<Parameters<ClerkAuthFacade['loginWithClerk']>[0]>()
    expectTypeOf<NuxtEventLike>().toMatchTypeOf<Parameters<ClerkAuthFacade['registerWithClerk']>[0]>()
    expectTypeOf<NuxtEventLike>().toMatchTypeOf<Parameters<ClerkAuthFacade['logoutWithClerk']>[0]>()
    expectTypeOf<NuxtEventLike>().toMatchTypeOf<Parameters<ClerkAuthFacade['completeClerkAuth']>[0]>()

    const result = completeClerkAuth(new Request('https://app.test/api/auth/clerk/callback'), {
      user: (clerkUser): MappedUser => ({
        email: clerkUser.email,
        name: clerkUser.name,
        avatar: clerkUser.imageUrl ?? null,
        clerkUserId: clerkUser.id,
      }),
    })

    expectTypeOf(result).toEqualTypeOf<Promise<ClerkCompleteAuthResult<MappedUser>>>()
  })
})
