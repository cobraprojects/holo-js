import { beforeEach, describe, expect, it } from 'vitest'
import authorization, {
  allow,
  authorize,
  AuthorizationError,
  authorizationInternals,
  can,
  cannot,
  defineAbility,
  definePolicy,
  deny,
  denyAsNotFound,
  inspect,
} from '../src'

type Actor = {
  readonly id: string
  readonly role: 'writer' | 'editor' | 'admin'
}

class BlogPost {
  constructor(
    public readonly authorId: string,
    public readonly publishedAt: Date | null,
    public readonly featured: boolean = false,
  ) {}
}

declare module '../src/contracts' {
  interface AuthorizationPolicyRegistry {
    'feature-posts': {
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
  }

  interface AuthorizationAbilityRegistry {
    'feature-reports.export': {
      actor: Actor
      input: {
        reportId: string
        format: 'csv' | 'pdf'
        includeDrafts: boolean
      }
    }
  }

  interface AuthorizationGuardRegistry {
    'feature-web': {
      user: Actor
    }

    'feature-admin': {
      user: Actor
    }
  }
}

describe('@holo-js/authorization feature flows', () => {
  beforeEach(() => {
    authorizationInternals.resetAuthorizationRuntimeState()
    authorizationInternals.resetAuthorizationAuthIntegration()
  })

  it('covers a blog and reporting workflow without mocks or auth integration seams', async () => {
    definePolicy('feature-posts', BlogPost, {
      class: {
        viewAny({ user }) {
          return Boolean(user)
        },
        create({ user }) {
          return Boolean(user)
        },
      },
      record: {
        view({ user }, post) {
          if (post.publishedAt) {
            return allow()
          }

          if (!user) {
            return denyAsNotFound()
          }

          return user.id === post.authorId || user.role === 'admin'
        },
        update({ user }, post) {
          return Boolean(user && (user.id === post.authorId || user.role === 'editor' || user.role === 'admin'))
        },
        delete({ user }, post) {
          if (!user) {
            return deny('Only signed-in staff can delete posts.')
          }

          if (user.role === 'admin') {
            return allow()
          }

          if (user.role === 'editor' && post.featured === false) {
            return allow('Editors can remove non-featured posts.')
          }

          return deny('Only admins can delete featured posts.')
        },
      },
    })

    defineAbility('feature-reports.export', ({ user }, input: {
      reportId: string
      format: 'csv' | 'pdf'
      includeDrafts: boolean
    }) => {
      if (!user) {
        return deny('You must be signed in to export reports.')
      }

      if (user.role === 'admin') {
        return allow()
      }

      if (input.format === 'pdf') {
        return denyAsNotFound('PDF exports are hidden from non-admin users.')
      }

      return input.includeDrafts === false
    })

    const guest = authorization.forUser(null)
    const author = authorization.forUser({ id: 'user-1', role: 'writer' } satisfies Actor)
    const editor = authorization.forUser({ id: 'user-2', role: 'editor' } satisfies Actor)
    const admin = authorization.forUser({ id: 'admin-1', role: 'admin' } satisfies Actor)
    let defaultActor: Actor | null = { id: 'user-1', role: 'writer' }
    let adminActor: Actor | null = { id: 'admin-1', role: 'admin' }

    authorizationInternals.configureAuthorizationAuthIntegration({
      hasGuard(guardName) {
        return guardName === 'feature-web' || guardName === 'feature-admin'
      },
      resolveDefaultActor() {
        return defaultActor
      },
      resolveGuardActor(guardName) {
        return guardName === 'feature-admin'
          ? adminActor
          : defaultActor
      },
    })

    const publishedPost = new BlogPost('user-1', new Date('2026-04-20T10:00:00Z'))
    const draftPost = new BlogPost('user-1', null)
    const featuredDraft = new BlogPost('user-1', null, true)

    await expect(guest.can('view', publishedPost)).resolves.toBe(true)
    await expect(guest.inspect('view', draftPost)).resolves.toEqual(denyAsNotFound())
    await expect(author.authorize('create', BlogPost)).resolves.toBeUndefined()
    await expect(author.can('update', draftPost)).resolves.toBe(true)
    await expect(editor.can('update', draftPost)).resolves.toBe(true)
    await expect(editor.inspect('delete', draftPost)).resolves.toEqual(allow('Editors can remove non-featured posts.'))
    await expect(editor.authorize('delete', featuredDraft)).rejects.toBeInstanceOf(AuthorizationError)
    await expect(admin.authorize('delete', featuredDraft)).resolves.toBeUndefined()
    await expect(authorize('update', draftPost)).resolves.toBeUndefined()
    await expect(can('view', publishedPost)).resolves.toBe(true)
    await expect(cannot('delete', featuredDraft)).resolves.toBe(true)
    await expect(inspect('view', draftPost)).resolves.toEqual(allow())
    await expect(authorization.guard('feature-admin').authorize('delete', featuredDraft)).resolves.toBeUndefined()
    await expect(authorization.guard('feature-admin').ability('feature-reports.export').can({
      reportId: 'rpt-1',
      format: 'pdf',
      includeDrafts: true,
    })).resolves.toBe(true)

    defaultActor = null
    adminActor = null

    await expect(author.policy('feature-posts').authorize('view', draftPost)).resolves.toBeUndefined()
    await expect(guest.policy('feature-posts').authorize('view', draftPost)).rejects.toBeInstanceOf(AuthorizationError)
    await expect(author.policy('feature-posts').can('viewAny', BlogPost)).resolves.toBe(true)
    await expect(authorize('view', draftPost)).rejects.toBeInstanceOf(AuthorizationError)
    await expect(authorization.guard('feature-web').inspect('view', draftPost)).resolves.toEqual(denyAsNotFound())

    await expect(author.ability('feature-reports.export').can({
      reportId: 'rpt-1',
      format: 'csv',
      includeDrafts: false,
    })).resolves.toBe(true)
    await expect(author.ability('feature-reports.export').inspect({
      reportId: 'rpt-1',
      format: 'pdf',
      includeDrafts: false,
    })).resolves.toEqual(denyAsNotFound('PDF exports are hidden from non-admin users.'))
    await expect(guest.ability('feature-reports.export').authorize({
      reportId: 'rpt-1',
      format: 'csv',
      includeDrafts: false,
    })).rejects.toBeInstanceOf(AuthorizationError)
    await expect(admin.ability('feature-reports.export').authorize({
      reportId: 'rpt-1',
      format: 'pdf',
      includeDrafts: true,
    })).resolves.toBeUndefined()
  })
})
