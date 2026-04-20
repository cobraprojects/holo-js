import { beforeEach, describe, expectTypeOf, it } from 'vitest'
import authorization, {
  authorize,
  authorizationInternals,
  can,
  cannot,
  defineAbility,
  definePolicy,
  inspect,
  type AbilityInput,
  type HoloAbilityName,
  type HoloAuthorizationGuardName,
  type HoloPolicyName,
  type PolicyActionFor,
  type PolicyActionForPolicy,
  type PolicyClassActionFor,
  type PolicyRecordActionFor,
} from '../src'

type Actor = {
  readonly id: string
  readonly role: 'writer' | 'editor' | 'admin'
}

class BlogPost {
  constructor(
    public readonly authorId: string,
    public readonly publishedAt: Date | null,
  ) {}
}

type BlogModelRecord = {
  get(key: 'id' | 'user_id' | 'published_at'): string | null
  getRepository(): {
    definition: typeof BlogModel.definition
  }
}

const BlogModel = {
  definition: {
    name: 'BlogPost',
    table: {
      tableName: 'posts',
    },
  },
  query() {
    return {
      async first() {
        return undefined as BlogModelRecord | undefined
      },
      async firstOrFail() {
        throw new Error('not implemented')
      },
    }
  },
}

declare module '../src/contracts' {
  interface AuthorizationPolicyRegistry {
    'feature-type-posts': {
      actor: Actor
      target: typeof BlogPost
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

    'feature-type-model-posts': {
      actor: Actor
      target: typeof BlogModel
      classActions: {
        create: true
      }
      recordActions: {
        view: true
        update: true
      }
    }
  }

  interface AuthorizationAbilityRegistry {
    'feature-type-reports.export': {
      actor: Actor
      input: {
        reportId: string
        format: 'csv' | 'pdf'
        includeDrafts: boolean
      }
    }
  }

  interface AuthorizationGuardRegistry {
    'feature-type-web': {
      user: Actor
    }

    'feature-type-admin': {
      user: Actor
    }
  }
}

describe('@holo-js/authorization feature typing', () => {
  beforeEach(() => {
    authorizationInternals.resetAuthorizationRuntimeState()
    authorizationInternals.resetAuthorizationAuthIntegration()
    authorizationInternals.configureAuthorizationAuthIntegration({
      hasGuard(guardName) {
        return guardName === 'feature-type-web' || guardName === 'feature-type-admin'
      },
      resolveDefaultActor() {
        return { id: 'user-1', role: 'writer' as const }
      },
      resolveGuardActor(guardName) {
        return guardName === 'feature-type-admin'
          ? { id: 'admin-1', role: 'admin' as const }
          : { id: 'user-1', role: 'writer' as const }
      },
    })
  })

  it('keeps a real-world policy and ability flow inferred for users', () => {
    definePolicy('feature-type-posts', BlogPost, {
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

    definePolicy('feature-type-model-posts', BlogModel, {
      class: {
        create() {
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
      },
    })

    defineAbility('feature-type-reports.export', (_context, input: {
      reportId: string
      format: 'csv' | 'pdf'
      includeDrafts: boolean
    }) => input.format === 'csv')

    expectTypeOf<'feature-type-posts'>().toExtend<HoloPolicyName>()
    expectTypeOf<'feature-type-reports.export'>().toExtend<HoloAbilityName>()
    expectTypeOf<'feature-type-web' | 'feature-type-admin'>().toExtend<HoloAuthorizationGuardName>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyClassActionFor<typeof BlogPost>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyRecordActionFor<BlogPost>>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyActionFor<typeof BlogPost>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyActionFor<BlogPost>>()
    expectTypeOf<'create' | 'viewAny'>().toExtend<PolicyActionForPolicy<'feature-type-posts', typeof BlogPost>>()
    expectTypeOf<'view' | 'update' | 'delete'>().toExtend<PolicyActionForPolicy<'feature-type-posts', BlogPost>>()
    expectTypeOf<'create'>().toExtend<PolicyActionFor<typeof BlogModel>>()
    expectTypeOf<'view' | 'update'>().toExtend<PolicyActionFor<BlogModelRecord>>()
    expectTypeOf<'create'>().toExtend<PolicyActionForPolicy<'feature-type-model-posts', typeof BlogModel>>()
    expectTypeOf<'view' | 'update'>().toExtend<PolicyActionForPolicy<'feature-type-model-posts', BlogModelRecord>>()
    expectTypeOf<{
      reportId: string
      format: 'csv' | 'pdf'
      includeDrafts: boolean
    }>().toExtend<AbilityInput<'feature-type-reports.export'>>()

    const actor = { id: 'user-1', role: 'writer' } as const satisfies Actor
    const current = authorization.forUser(actor)
    const guest = authorization.forUser(null)
    const posts = current.policy('feature-type-posts')
    const modelPosts = current.policy('feature-type-model-posts')
    const reports = current.ability('feature-type-reports.export')
    const admin = authorization.guard('feature-type-admin')
    const blogRecord = {} as BlogModelRecord

    const invokeCurrentAuthorize = () => current.authorize('create', BlogPost)
    const invokeCurrentCan = () => current.can('view', new BlogPost('user-1', null))
    const invokePostsAuthorize = () => posts.authorize('create', BlogPost)
    const invokePostsCan = () => posts.can('update', new BlogPost('user-1', null))
    const invokeModelPostsAuthorize = () => modelPosts.authorize('create', BlogModel)
    const invokeModelPostsCan = () => modelPosts.can('update', blogRecord)
    const invokeReportsCan = () => reports.can({ reportId: 'rpt-1', format: 'csv', includeDrafts: false })
    const invokeTopLevelAuthorize = () => authorize('update', new BlogPost('user-1', null))
    const invokeTopLevelCan = () => can('view', new BlogPost('user-1', null))
    const invokeTopLevelCannot = () => cannot('delete', new BlogPost('user-1', null))
    const invokeTopLevelInspect = () => inspect('view', new BlogPost('user-1', null))
    const invokeAdminAuthorize = () => admin.authorize('delete', new BlogPost('user-1', null))

    // @ts-expect-error class targets must not accept record actions
    const invalidPolicyClassTarget = () => posts.authorize('view', BlogPost)
    // @ts-expect-error record targets must not accept class actions
    const invalidPolicyRecordTarget = () => posts.can('create', new BlogPost('user-1', null))
    // @ts-expect-error model targets must not accept record actions on the model facade
    const invalidModelPolicyClassTarget = () => modelPosts.authorize('view', BlogModel)
    // @ts-expect-error model record instances must not accept class actions
    const invalidModelPolicyRecordTarget = () => modelPosts.can('create', blogRecord)
    // @ts-expect-error inferred ability payload requires includeDrafts
    const invalidAbilityPayload = () => reports.authorize({ reportId: 'rpt-1', format: 'csv' })
    // @ts-expect-error top-level helpers still enforce record vs class actions
    const invalidTopLevelClassTarget = () => authorize('view', BlogPost)
    // @ts-expect-error top-level helpers still enforce class vs record actions
    const invalidTopLevelRecordTarget = () => can('create', new BlogPost('user-1', null))

    const invokeGuestCan = () => guest.can('create', BlogPost)
    const invokePostInspect = () => posts.inspect('view', new BlogPost('user-1', null))
    const invokeReportAuthorize = () => reports.authorize({ reportId: 'rpt-1', format: 'csv', includeDrafts: false })

    expectTypeOf<ReturnType<typeof invokeCurrentAuthorize>>().toExtend<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokeCurrentCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokePostsAuthorize>>().toExtend<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokePostsCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeModelPostsAuthorize>>().toExtend<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokeModelPostsCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeReportsCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeGuestCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokePostInspect>>().toExtend<Promise<{ allowed: boolean, status: 200 | 403 | 404, message?: string, code?: string }>>()
    expectTypeOf<ReturnType<typeof invokeReportAuthorize>>().toExtend<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokeTopLevelAuthorize>>().toExtend<Promise<void>>()
    expectTypeOf<ReturnType<typeof invokeTopLevelCan>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeTopLevelCannot>>().toExtend<Promise<boolean>>()
    expectTypeOf<ReturnType<typeof invokeTopLevelInspect>>().toExtend<Promise<{ allowed: boolean, status: 200 | 403 | 404, message?: string, code?: string }>>()
    expectTypeOf<ReturnType<typeof invokeAdminAuthorize>>().toExtend<Promise<void>>()

    void invalidPolicyClassTarget
    void invalidPolicyRecordTarget
    void invalidModelPolicyClassTarget
    void invalidModelPolicyRecordTarget
    void invalidAbilityPayload
    void invalidTopLevelClassTarget
    void invalidTopLevelRecordTarget
  })
})
