import { beforeEach, describe, expect, it } from 'vitest'
import authorization, {
  allow,
  deny,
  denyAsNotFound,
  isAuthorizationAbilityDefinition,
  isAuthorizationDecision,
  isAuthorizationPolicyDefinition,
  defineAbility,
  definePolicy,
  forUser,
  authorizationInternals,
  normalizeAuthorizationDecision,
  type AuthorizationPolicyDefinition,
  AuthorizationAuthIntegrationMissingError as AuthorizationAuthIntegrationMissingErrorClass,
  AuthorizationError,
  AuthorizationPolicyNotFoundError,
  AuthorizationAbilityNotFoundError,
  AuthorizationGuardNotFoundError,
} from '../src'
import type { AuthorizationAbilityDefinition } from '../src/contracts'

declare module '../src/contracts' {
  interface AuthorizationPolicyRegistry {
    articles: {
      target: typeof Article
      classActions: {
        create: true
      }
      recordActions: {
        view: true
        delete: true
      }
    }

    'guarded-projects': {
      target: typeof Article
      classActions: {
        create: true
      }
      recordActions: {
        view: true
      }
    }
  }

  interface AuthorizationAbilityRegistry {
    'articles.export': {
      input: {
        articleId: string
        format: 'csv' | 'pdf'
      }
    }

    'guarded.export': {
      input: {
        articleId: string
        format: 'csv' | 'pdf'
      }
    }
  }

  interface AuthorizationGuardRegistry {
    web: {
      user: {
        id: string
        role: 'user'
      }
    }

    admin: {
      user: {
        id: string
        role: 'admin'
      }
    }
  }
}

class Article {
  constructor(
    public readonly authorId: string,
    public readonly publishedAt: Date | null = null,
  ) {}
}

describe('@holo-js/authorization package', () => {
  beforeEach(() => {
    authorizationInternals.resetAuthorizationRuntimeState()
    authorizationInternals.resetAuthorizationAuthIntegration()
    authorizationInternals.configureAuthorizationAuthIntegration()
  })

  it('exposes helper type guards and error classes', () => {
    const policy = definePolicy('articles', Article, {
      class: {
        create() {
          return allow()
        },
      },
      record: {
        view() {
          return true
        },
      },
    })
    const ability = defineAbility('articles.export', () => true)

    expect(isAuthorizationPolicyDefinition(policy)).toBe(true)
    expect(isAuthorizationAbilityDefinition(ability)).toBe(true)
    expect(isAuthorizationDecision(allow())).toBe(true)
    expect(allow('ok')).toEqual({ allowed: true, status: 200, message: 'ok' })
    expect(isAuthorizationDecision({ allowed: true, status: 200 })).toBe(true)
    expect(isAuthorizationDecision(null)).toBe(false)
    expect(isAuthorizationDecision({ allowed: true, status: 201 })).toBe(false)
    expect(normalizeAuthorizationDecision(undefined, 'fallback')).toEqual(deny('fallback'))
    expect(normalizeAuthorizationDecision(true, 'fallback')).toEqual(allow())
    expect(normalizeAuthorizationDecision(undefined)).toEqual(deny())
    expect(normalizeAuthorizationDecision({ allowed: false, status: 403, message: 'blocked', code: 'E_BLOCKED' }))
      .toEqual({ allowed: false, status: 403, message: 'blocked', code: 'E_BLOCKED' })
    expect(new AuthorizationError('Denied', deny('Denied'))).toBeInstanceOf(Error)
    expect(new AuthorizationGuardNotFoundError()).toBeInstanceOf(Error)
    expect(new AuthorizationPolicyNotFoundError()).toBeInstanceOf(Error)
    expect(new AuthorizationAbilityNotFoundError()).toBeInstanceOf(Error)
    expect(new AuthorizationAuthIntegrationMissingErrorClass()).toBeInstanceOf(Error)
  })

  it('defines policies, abilities, and decision helpers with stable runtime contracts', async () => {
    const policy = definePolicy('articles', Article, {
      class: {
        create() {
          return allow()
        },
      },
      record: {
        view({ user }, article) {
          if (article.publishedAt) {
            return true
          }

          return user !== null && 'id' in user && user.id === article.authorId
        },
        delete() {
          return deny('Nope')
        },
      },
    })

    const ability = defineAbility('articles.export', (_context, input: { articleId: string, format: 'csv' | 'pdf' }) => {
      if (input.format === 'csv') {
        return true
      }

      return denyAsNotFound('CSV only')
    })

    const typedPolicy: AuthorizationPolicyDefinition<'articles', typeof Article, 'create', 'view' | 'delete'> = policy
    const typedAbility: AuthorizationAbilityDefinition<'articles.export', { articleId: string, format: 'csv' | 'pdf' }> = ability

    expect(typedPolicy.name).toBe('articles')
    expect(typedAbility.name).toBe('articles.export')
    expect(allow()).toEqual({ allowed: true, status: 200 })
    expect(deny('blocked')).toEqual({ allowed: false, status: 403, message: 'blocked' })
    expect(denyAsNotFound()).toEqual({ allowed: false, status: 404, message: 'Resource not found.' })

    const current = forUser({ id: 'user-1' })
    await expect(current.policy('articles').cannot('delete', new Article('user-1'))).resolves.toBe(true)
    await expect(current.can('create', Article)).resolves.toBe(true)
    await expect(current.authorize('create', Article)).resolves.toBeUndefined()
    await expect(current.can('view', new Article('user-1'))).resolves.toBe(true)
    await expect(current.inspect('view', new Article('user-1'))).resolves.toEqual(allow())
    await expect(current.cannot('delete', new Article('user-1'))).resolves.toBe(true)
    await expect(current.authorize('delete', new Article('user-1'))).rejects.toBeInstanceOf(AuthorizationError)
    await expect(current.ability('articles.export').can({ articleId: 'a-1', format: 'csv' })).resolves.toBe(true)
    await expect(current.ability('articles.export').cannot({ articleId: 'a-1', format: 'pdf' })).resolves.toBe(true)
    await expect(current.ability('articles.export').inspect({ articleId: 'a-1', format: 'csv' })).resolves.toEqual(allow())
    await expect(current.ability('articles.export').inspect({ articleId: 'a-1', format: 'pdf' }))
      .resolves.toEqual(denyAsNotFound('CSV only'))
    await expect(current.ability('articles.export').authorize({ articleId: 'a-1', format: 'pdf' }))
      .rejects.toBeInstanceOf(AuthorizationError)

    authorizationInternals.configureAuthorizationAuthIntegration({
      hasGuard(guardName) {
        return guardName === 'web'
      },
      async resolveDefaultActor() {
        return { id: 'user-1', role: 'user' as const }
      },
      async resolveGuardActor() {
        return { id: 'user-1', role: 'user' as const }
      },
    })
    await expect(authorization.cannot('delete', new Article('user-1'))).resolves.toBe(true)
    await expect(authorization.inspect('view', new Article('user-1'))).resolves.toEqual(allow())
  })

  it('short-circuits when a before hook returns allow()', async () => {
    definePolicy('articles', Article, {
      before({ user }) {
        if (user && 'role' in user && user.role === 'admin') {
          return allow()
        }

        return deny('Not an admin')
      },
      record: {
        view() {
          throw new Error('record handler should not run after before() allows')
        },
      },
    })

    await expect(forUser({ id: 'admin-1', role: 'admin' }).authorize('delete', new Article('user-1')))
      .resolves.toBeUndefined()
    await expect(forUser({ id: 'user-1', role: 'user' }).authorize('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationError)
  })

  it('falls through to action handlers when a before hook returns nothing', async () => {
    definePolicy('articles', Article, {
      before({ user }) {
        return user && 'role' in user && user.role === 'admin'
          ? allow()
          : undefined
      },
      class: {
        create({ user }) {
          return Boolean(user)
        },
      },
      record: {
        view({ user }, article) {
          return user !== null && 'id' in user && user.id === article.authorId
        },
      },
    })

    await expect(forUser({ id: 'user-1', role: 'user' }).authorize('view', new Article('user-1')))
      .resolves.toBeUndefined()
    await expect(forUser({ id: 'user-1', role: 'user' }).authorize('create', Article))
      .resolves.toBeUndefined()
    await expect(forUser(null).inspect('view', new Article('user-1'))).resolves.toEqual(deny())
    await expect(forUser(null).inspect('create', Article)).resolves.toEqual(deny())
    await expect(forUser({ id: 'admin-1', role: 'admin' }).inspect('view', new Article('user-1')))
      .resolves.toEqual(allow())
    await expect(forUser({ id: 'admin-1', role: 'admin' }).inspect('create', Article))
      .resolves.toEqual(allow())
  })

  it('resolves current actors from the auth integration seam for default and named guards', async () => {
    authorizationInternals.configureAuthorizationAuthIntegration({
      hasGuard(guardName) {
        return guardName === 'web' || guardName === 'admin'
      },
      async resolveDefaultActor() {
        return { id: 'user-1', role: 'user' as const }
      },
      async resolveGuardActor(guardName) {
        return guardName === 'admin'
          ? { id: 'admin-1', role: 'admin' as const }
          : { id: 'user-1', role: 'user' as const }
      },
    })

    definePolicy('guarded-projects', Article, {
      class: {
        create({ user }) {
          return Boolean(user && 'role' in user && user.role === 'admin')
        },
      },
      record: {
        view({ guard, user }, article) {
          if (guard !== 'admin') {
            return denyAsNotFound()
          }

          return Boolean(user && 'id' in user && user.id === article.authorId)
        },
      },
    })

    defineAbility('guarded.export', ({ guard }, input: { articleId: string, format: 'csv' | 'pdf' }) => {
      return guard === 'admin' && input.format === 'csv'
    })

    await expect(authorization.authorize('create', Article))
      .rejects.toBeInstanceOf(AuthorizationError)
    await expect(authorization.can('create', Article)).resolves.toBe(false)
    await expect(authorization.guard('admin').authorize('create', Article)).resolves.toBeUndefined()
    await expect(authorization.guard('admin').can('create', Article)).resolves.toBe(true)
    await expect(authorization.guard('admin').policy('guarded-projects').authorize('create', Article))
      .resolves.toBeUndefined()
    await expect(authorization.guard('admin').inspect('view', new Article('admin-1'))).resolves.toEqual(allow())
    await expect(authorization.guard('web').inspect('view', new Article('user-1'))).resolves.toEqual(denyAsNotFound())
    await expect(authorization.guard('admin').ability('guarded.export').can({ articleId: 'a-1', format: 'csv' }))
      .resolves.toBe(true)
    await expect(authorization.guard('web').ability('guarded.export').can({ articleId: 'a-1', format: 'csv' }))
      .resolves.toBe(false)
    // @ts-expect-error missing guard name is intentional in this runtime test
    expect(() => authorization.guard('missing')).toThrow(AuthorizationGuardNotFoundError)
  })

  it('throws targeted runtime errors for missing auth integration and missing lookups', async () => {
    await expect(authorization.authorize('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationAuthIntegrationMissingErrorClass)
    await expect(authorization.can('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationAuthIntegrationMissingErrorClass)
    await expect(authorization.cannot('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationAuthIntegrationMissingErrorClass)
    await expect(authorization.inspect('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationAuthIntegrationMissingErrorClass)
    expect(() => authorization.guard('web')).toThrow(AuthorizationAuthIntegrationMissingErrorClass)
    // @ts-expect-error missing policy name is intentional in this lookup test
    await expect(forUser({ id: 'user-1' }).policy('missing').authorize('view', new Article('user-1')))
      .rejects.toBeInstanceOf(AuthorizationPolicyNotFoundError)
    // @ts-expect-error missing ability name is intentional in this lookup test
    await expect(forUser({ id: 'user-1' }).ability('missing').authorize({}))
      .rejects.toBeInstanceOf(AuthorizationAbilityNotFoundError)
  })
})
