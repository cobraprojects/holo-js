import { beforeEach, describe, expectTypeOf, it } from 'vitest'
import authorization, {
  defineAbility,
  definePolicy,
  authorizationInternals,
  type AbilityInput,
  type HoloAuthorizationGuardName,
  type HoloPolicyName,
  type PolicyActionFor,
  type PolicyActionForPolicy,
  type PolicyClassActionFor,
  type PolicyRecordActionFor,
} from '../src'

class Post {
  constructor(
    public readonly authorId: string,
    public readonly publishedAt: Date | null = null,
  ) {}
}

type PostActor = {
  readonly id: string
  readonly role: 'user'
}

declare module '../src/contracts' {
  interface AuthorizationPolicyRegistry {
    posts: {
      actor: PostActor
      target: typeof Post
      classActions: {
        create: true
        viewAny: true
      }
      recordActions: {
        view: true
        update: true
        delete: true
      }
    }
  }

  interface AuthorizationAbilityRegistry {
    'reports.export': {
      input: {
        reportId: string
        format: 'csv' | 'pdf'
      }
    }
  }

  interface AuthorizationGuardRegistry {
    'typing-web': {
      user: PostActor
    }
  }
}

describe('@holo-js/authorization typing', () => {
  beforeEach(() => {
    authorizationInternals.resetAuthorizationRuntimeState()
    authorizationInternals.resetAuthorizationAuthIntegration()
    authorizationInternals.configureAuthorizationAuthIntegration({
      hasGuard(guardName) {
        return guardName === 'typing-web'
      },
      async resolveDefaultActor() {
        return { id: 'user-1', role: 'user' as const }
      },
      async resolveGuardActor() {
        return { id: 'user-1', role: 'user' as const }
      },
    })
  })

  it('preserves policy, ability, and guard inference from the generated registry seams', () => {
    definePolicy('posts', Post, {
      before({ user }) {
        return user?.id === 'admin-1' ? true : undefined
      },
      class: {
        create() {
          return true
        },
        viewAny() {
          return true
        },
      },
      record: {
        view() {
          return true
        },
        update() {
          return true
        },
        delete() {
          return true
        },
      },
    })

    defineAbility('reports.export', (_context, input: { reportId: string, format: 'csv' | 'pdf' }) => input.format === 'csv')

    expectTypeOf<'articles' | 'documents' | 'locked-projects' | 'posts' | 'projects'>().toExtend<HoloPolicyName>()
    expectTypeOf<'typing-web'>().toExtend<HoloAuthorizationGuardName>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyClassActionFor<typeof Post>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyRecordActionFor<Post>>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyActionFor<typeof Post>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyActionFor<Post>>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyActionForPolicy<'posts', typeof Post>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyActionForPolicy<'posts', Post>>()
    expectTypeOf<{ reportId: string, format: 'csv' | 'pdf' }>().toExtend<AbilityInput<'reports.export'>>()

    const actor = { id: 'user-1', role: 'user' } as const
    const guest = authorization.forUser(null)
    const userAuth = authorization.forUser(actor)
    const guardedAuth = authorization.guard('typing-web')
    const policyBuilder = userAuth.policy('posts')
    const abilityBuilder = userAuth.ability('reports.export')

    const invokePolicyAuthorize = () => policyBuilder.authorize('create', Post)
    const invokePolicyCan = () => policyBuilder.can('view', new Post('user-1'))
    // @ts-expect-error class builders must not accept record actions
    const invalidClassPolicyCall = () => policyBuilder.authorize('view', Post)
    // @ts-expect-error record actions require record instances
    const invalidRecordPolicyCall = () => policyBuilder.can('create', new Post('user-1'))
    // @ts-expect-error ability input must include the full inferred payload
    const invalidAbilityCall = () => abilityBuilder.can({ reportId: 'r-1' })

    const invokeAbilityCan = () => abilityBuilder.can({ reportId: 'r-1', format: 'csv' })
    const invokeGuestCan = () => guest.can('create', Post)
    const invokeUserAuthorize = () => userAuth.authorize('create', Post)
    const invokeGuardedCan = () => guardedAuth.can('create', Post)

    expectTypeOf<ReturnType<typeof invokePolicyAuthorize>>().toEqualTypeOf<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokePolicyCan>>().toEqualTypeOf<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeAbilityCan>>().toEqualTypeOf<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeGuestCan>>().toEqualTypeOf<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeUserAuthorize>>().toEqualTypeOf<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokeGuardedCan>>().toEqualTypeOf<Promise<boolean>>()

    void actor
    void guest
    void userAuth
    void guardedAuth
    void policyBuilder
    void abilityBuilder
    void invalidClassPolicyCall
    void invalidRecordPolicyCall
    void invalidAbilityCall
  })
})
