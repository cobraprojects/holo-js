import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logoutWithClerk: vi.fn(),
  logoutWithWorkos: vi.fn(),
}))

vi.mock('@holo-js/auth-clerk', () => ({
  logoutWithClerk: mocks.logoutWithClerk,
}))

vi.mock('@holo-js/auth-workos', () => ({
  logoutWithWorkos: mocks.logoutWithWorkos,
}))

const clerkLogoutRoute = await import('../app/api/auth/clerk/logout/route.ts')
const workosLogoutRoute = await import('../app/api/auth/workos/logout/route.ts')

const hostedLogoutRoutes = [
  {
    name: 'Clerk',
    provider: 'clerk',
    route: clerkLogoutRoute,
    logout: mocks.logoutWithClerk,
    url: 'http://localhost/api/auth/clerk/logout',
    failureCode: 'clerk_logout_failed',
    failureMessage: 'Unable to complete Clerk logout.',
  },
  {
    name: 'WorkOS',
    provider: 'workos',
    route: workosLogoutRoute,
    logout: mocks.logoutWithWorkos,
    url: 'http://localhost/api/auth/workos/logout',
    failureCode: 'workos_logout_failed',
    failureMessage: 'Unable to complete WorkOS logout.',
  },
]

function createRequest(url) {
  return new Request(url, {
    method: 'POST',
  })
}

describe('hosted auth logout routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const hosted of hostedLogoutRoutes) {
    it(`returns the ${hosted.name} framework helper response`, async () => {
      const expected = Response.redirect('https://accounts.test/logout', 303)
      hosted.logout.mockResolvedValue(expected)

      const request = createRequest(hosted.url)
      const response = await hosted.route.POST(request)

      expect(response).toBe(expected)
      expect(hosted.logout).toHaveBeenCalledWith(request)
    })

    it(`passes through sanitized ${hosted.name} logout failures from the framework helper`, async () => {
      const expected = Response.json({
        data: null,
        error: {
          code: hosted.failureCode,
          message: hosted.failureMessage,
          status: 500,
          fields: {
            _root: [hosted.failureMessage],
          },
        },
      }, { status: 500 })
      hosted.logout.mockResolvedValue(expected)

      const response = await hosted.route.POST(createRequest(hosted.url))
      const payload = await response.json()

      expect(response.status).toBe(500)
      expect(payload).toEqual({
        data: null,
        error: {
          code: hosted.failureCode,
          message: hosted.failureMessage,
          status: 500,
          fields: {
            _root: [hosted.failureMessage],
          },
        },
      })
      expect(JSON.stringify(payload)).not.toContain('secret')
    })
  }
})
