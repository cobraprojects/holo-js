import { beforeEach, describe, expect, it } from 'vitest'
import authorization from '../src'
import {
  allow,
  defineAbility,
  definePolicy,
  deny,
  denyAsNotFound,
  authorizationInternals,
  AuthorizationPolicyNotFoundError,
  AuthorizationError,
} from '../src'

class Project {
  constructor(public readonly ownerId: string) {}
}

class Document {
  constructor(public readonly ownerId: string) {}
}

class LockedProject {
  constructor(public readonly ownerId: string) {}
}

type BlogRecord = {
  get(key: 'id' | 'user_id' | 'published_at'): string | null
  getRepository(): {
    definition: typeof Blog.definition
  }
}

const Blog = {
  definition: {
    name: 'BlogPost',
    table: {
      tableName: 'posts',
    },
  },
  query() {
    return {
      async first() {
        return undefined as BlogRecord | undefined
      },
      async firstOrFail() {
        throw new Error('not implemented')
      },
    }
  },
}

function createBlogRecord(values: {
  readonly id: string
  readonly userId: string
  readonly publishedAt: string | null
}): BlogRecord {
  return {
    get(key) {
      if (key === 'id') return values.id
      if (key === 'user_id') return values.userId
      return values.publishedAt
    },
    getRepository() {
      return {
        definition: Blog.definition,
      }
    },
  }
}

const LooseBlog = {
  definition: {
    name: 'LooseBlog',
  },
  query() {
    return {
      async first() {
        return undefined as BlogRecord | undefined
      },
      async firstOrFail() {
        throw new Error('not implemented')
      },
    }
  },
}

declare module '../src/contracts' {
  interface AuthorizationPolicyRegistry {
    projects: {
      target: typeof Project
      classActions: {
        create: true
      }
      recordActions: {
        view: true
        update: true
        delete: true
      }
    }

    documents: {
      target: typeof Document
      classActions: {
        create: true
      }
      recordActions: {
        view: true
        delete: true
      }
    }

    'locked-projects': {
      target: typeof LockedProject
      classActions: {
        create: true
      }
      recordActions: {
        view: true
      }
    }

    'blog-posts': {
      target: typeof Blog
      classActions: {
        viewAny: true
      }
      recordActions: {
        view: true
      }
    }

    'loose-blogs': {
      target: typeof LooseBlog
      classActions: {
        viewAny: true
      }
      recordActions: {
        view: true
      }
    }
  }
}

describe('@holo-js/authorization contracts', () => {
  beforeEach(() => {
    authorizationInternals.resetAuthorizationRuntimeState()
    authorizationInternals.resetAuthorizationAuthIntegration()
  })

  it('rejects malformed policy and ability definitions', () => {
    expect(() => definePolicy(' ', Project, {})).toThrow(TypeError)
    // @ts-expect-error invalid target is intentional in this runtime validation test
    expect(() => definePolicy('projects', null, {})).toThrow(TypeError)
    expect(() => definePolicy('projects', Project, {
      class: {
        // @ts-expect-error invalid handler is intentional in this runtime validation test
        create: 123,
      },
    })).toThrow(TypeError)
    expect(() => definePolicy('projects', Project, {
      // @ts-expect-error invalid handler map is intentional in this runtime validation test
      class: [],
    })).toThrow(TypeError)
    expect(() => definePolicy('projects', Project, {
      // @ts-expect-error invalid before hook is intentional in this runtime validation test
      before: 123,
    })).toThrow(TypeError)
    expect(() => defineAbility(' ', () => true)).toThrow(TypeError)
    // @ts-expect-error invalid handler is intentional in this runtime validation test
    expect(() => defineAbility('projects.export', null)).toThrow(TypeError)
    expect(allow('phase-1')).toEqual({ allowed: true, status: 200, message: 'phase-1' })
  })

  it('rejects duplicate policy and ability registration', () => {
    definePolicy('projects', Project, {
      class: {
        create() {
          return allow()
        },
      },
    })
    expect(() => definePolicy('projects', class OtherProject {}, {
      class: {
        create() {
          return deny()
        },
      },
    })).toThrow('Policy "projects" is already registered.')
    expect(() => definePolicy('other-projects', Project, {
      class: {
        create() {
          return denyAsNotFound()
        },
      },
    })).toThrow('A policy is already registered for this target.')

    defineAbility('projects.export', () => true)
    expect(() => defineAbility('projects.export', () => false)).toThrow('Ability "projects.export" is already registered.')
  })

  it('keeps runtime registries observable for phase 0 tests', () => {
    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.size).toBe(0)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.size).toBe(0)
    definePolicy('projects', Project, {
      class: {
        create() {
          return true
        },
      },
    })
    defineAbility('projects.export', () => true)
    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.size).toBe(1)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.size).toBe(1)
  })

  it('unregisters policy and ability definitions from the runtime registry', () => {
    class RemovableProject {
      constructor(public readonly ownerId: string) {}
    }
    const RemovableProjectModel = {
      definition: {
        name: 'RemovableProject',
        table: {
          tableName: 'removable_projects',
        },
      },
      query() {
        return {
          async first() {
            return undefined as undefined
          },
          async firstOrFail() {
            throw new Error('not implemented')
          },
        }
      },
    }

    const removablePolicy = definePolicy('removable-projects', RemovableProject, {
      class: {
        create() {
          return true
        },
      },
      record: {
        view() {
          return true
        },
      },
    })
    definePolicy('removable-project-models', RemovableProjectModel, {
      class: {
        create() {
          return true
        },
      },
    })
    defineAbility('removable-projects.export', () => true)

    expect(authorizationInternals.getPolicyByTarget(RemovableProject)).toBe(removablePolicy)
    expect(authorizationInternals.getPolicyByTarget(RemovableProjectModel)).toBeDefined()
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('removable-projects.export')).toBe(true)

    authorizationInternals.unregisterPolicyDefinition('removable-projects')
    authorizationInternals.unregisterPolicyDefinition('removable-project-models')
    authorizationInternals.unregisterAbilityDefinition('removable-projects.export')
    authorizationInternals.unregisterPolicyDefinition('missing-policy')
    authorizationInternals.unregisterAbilityDefinition('missing-ability')

    expect(() => authorizationInternals.getPolicyByTarget(RemovableProject)).toThrow(AuthorizationPolicyNotFoundError)
    expect(() => authorizationInternals.getPolicyByTarget(RemovableProjectModel)).toThrow(AuthorizationPolicyNotFoundError)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('removable-projects.export')).toBe(false)
  })

  it('evaluates before hooks and target-specific authorization paths', async () => {
    const policy = definePolicy('projects', Project, {
      before({ user }, target) {
        if (target instanceof Project && target.ownerId === 'blocked') {
          return denyAsNotFound()
        }

        return user !== null
      },
      class: {
        create() {
          return allow()
        },
      },
      record: {
        view() {
          return allow()
        },
        update({ user }, project) {
          return user !== null && 'id' in user && user.id === project.ownerId
        },
      },
    })

    const current = authorization.forUser({ id: 'user-1' })
    await expect(current.policy('projects').authorize('create', Project)).resolves.toBeUndefined()
    await expect(current.policy('projects').can('update', new Project('user-1'))).resolves.toBe(true)
    await expect(current.policy('projects').can('view', new Project('blocked'))).resolves.toBe(false)
    await expect(current.policy('projects').inspect('view', new Project('blocked'))).resolves.toEqual(denyAsNotFound())
    await expect(current.can('view', new Project('blocked'))).resolves.toBe(false)
    await expect(current.policy('projects').authorize('view', new Project('blocked'))).rejects.toBeInstanceOf(AuthorizationError)

    expect(policy.name).toBe('projects')
  })

  it('throws clear policy lookup and mismatch errors', async () => {
    definePolicy('projects', Project, {
      class: {
        create() {
          return true
        },
      },
      record: {
        view() {
          return true
        },
      },
    })

    // @ts-expect-error missing policy name is intentional in this lookup test
    await expect(authorization.forUser({ id: 'user-1' }).policy('missing').authorize('create', Project))
      .rejects.toBeInstanceOf(AuthorizationPolicyNotFoundError)
    expect(() => authorizationInternals.getPolicyByTarget(Object.create(null)))
      .toThrow(AuthorizationPolicyNotFoundError)

    await expect(authorization.forUser({ id: 'user-1' }).authorize('delete', Project))
      .rejects.toBeInstanceOf(AuthorizationError)
    // @ts-expect-error intentionally mismatched class action lookup for runtime coverage
    await expect(authorization.forUser({ id: 'user-1' }).policy('projects').authorize('view', Project))
      .rejects.toBeInstanceOf(AuthorizationError)
    // @ts-expect-error intentionally mismatched record action lookup for runtime coverage
    await expect(authorization.forUser({ id: 'user-1' }).policy('projects').authorize('create', new Project('user-1')))
      .rejects.toBeInstanceOf(AuthorizationError)

    class OtherProject {}

    await expect(authorization.forUser({ id: 'user-1' }).can('view', new OtherProject()))
      .rejects.toBeInstanceOf(AuthorizationPolicyNotFoundError)
    
    // @ts-expect-error null is not a valid target object
    await expect(authorization.forUser({ id: 'user-1' }).can('view', null))
      .rejects.toBeInstanceOf(TypeError)
  })

  it('supports record-only policies and fallback denial messages', async () => {
    definePolicy('documents', Document, {
      record: {
        view() {
          return true
        },
        delete() {
          return {
            allowed: false,
            status: 403,
          }
        },
      },
    })

    const current = authorization.forUser({ id: 'user-1' })
    await expect(current.can('view', new Document('user-1'))).resolves.toBe(true)
    await expect(current.authorize('delete', new Document('user-1'))).rejects.toThrow('You are not authorized to perform this action.')
  })

  it('covers class before denials and missing record handlers', async () => {
    definePolicy('locked-projects', LockedProject, {
      before() {
        return denyAsNotFound()
      },
      class: {
        create() {
          return allow()
        },
      },
      record: {
        view() {
          return allow()
        },
      },
    })
    definePolicy('projects', Project, {
      class: {
        create() {
          return allow()
        },
      },
      record: {
        view() {
          return allow()
        },
      },
    })

    const current = authorization.forUser({ id: 'user-1' })
    await expect(current.can('create', LockedProject)).resolves.toBe(false)
    await expect(current.policy('locked-projects').can('create', LockedProject)).resolves.toBe(false)
    await expect(current.can('delete', new Project('user-1'))).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('supports model-reference targets and entity-instance lookup by repository definition', async () => {
    definePolicy('blog-posts', Blog, {
      class: {
        viewAny() {
          return allow()
        },
      },
      record: {
        view({ user }, post) {
          const isPublished = post.get('published_at') !== null
          if (isPublished) {
            return allow()
          }

          if (!user) {
            return denyAsNotFound()
          }

          return 'id' in user && user.id === post.get('user_id')
        },
      },
    })

    const current = authorization.forUser({ id: 'user-1' })
    const publishedPost = createBlogRecord({ id: 'post-1', userId: 'user-2', publishedAt: '2026-04-20T10:00:00Z' })
    const draftPost = createBlogRecord({ id: 'post-2', userId: 'user-1', publishedAt: null })
    const hiddenDraft = createBlogRecord({ id: 'post-3', userId: 'user-9', publishedAt: null })

    await expect(current.can('viewAny', Blog)).resolves.toBe(true)
    await expect(current.can('view', publishedPost)).resolves.toBe(true)
    await expect(current.authorize('view', draftPost)).resolves.toBeUndefined()
    await expect(authorization.forUser(null).inspect('view', hiddenDraft)).resolves.toEqual(denyAsNotFound())
  })

  it('covers fallback lookup branches for model references and repository metadata', () => {
    definePolicy('blog-posts', Blog, {
      record: {
        view() {
          return allow()
        },
      },
    })
    definePolicy('loose-blogs', LooseBlog, {
      class: {
        viewAny() {
          return allow()
        },
      },
      record: {
        view() {
          return allow()
        },
      },
    })

    const unregisteredBlogModel = {
      definition: {
        name: 'MissingBlog',
        table: {
          tableName: 'missing_posts',
        },
      },
      query: Blog.query,
    }
    const aliasedBlogModel = {
      definition: Blog.definition,
      query: Blog.query,
    }
    const invalidRepositoryTarget = {
      getRepository() {
        return null
      },
    }
    const invalidDefinitionTarget = {
      getRepository() {
        return {
          definition: {
            name: 123,
          },
        }
      },
    }
    const looseBlogRecord = {
      get(key: 'id' | 'user_id' | 'published_at') {
        return key === 'published_at' ? null : 'value'
      },
      getRepository() {
        return {
          definition: LooseBlog.definition,
        }
      },
    }

    expect(() => definePolicy('blog-alias', aliasedBlogModel, {
      record: {
        view() {
          return allow()
        },
      },
    })).toThrow('A policy is already registered for target definition "BlogPost:posts".')
    expect(authorizationInternals.getPolicyByTarget(looseBlogRecord)).toBeDefined()
    expect(authorizationInternals.getPolicyByTarget(aliasedBlogModel)).toBeDefined()
    expect(() => authorizationInternals.getPolicyByTarget(unregisteredBlogModel)).toThrow(AuthorizationPolicyNotFoundError)
    expect(() => authorizationInternals.getPolicyByTarget(invalidRepositoryTarget)).toThrow(AuthorizationPolicyNotFoundError)
    expect(() => authorizationInternals.getPolicyByTarget(invalidDefinitionTarget)).toThrow(AuthorizationPolicyNotFoundError)
  })
})
