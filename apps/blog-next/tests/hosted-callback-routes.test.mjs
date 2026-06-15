import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  completeClerkAuth: vi.fn(),
  completeWorkosAuth: vi.fn(),
}))

vi.mock('@holo-js/auth-clerk', () => ({
  completeClerkAuth: mocks.completeClerkAuth,
}))

vi.mock('@holo-js/auth-workos', () => ({
  completeWorkosAuth: mocks.completeWorkosAuth,
}))

const clerkCallbackRoute = await import('../app/api/auth/clerk/callback/route.ts')
const workosCallbackRoute = await import('../app/api/auth/workos/callback/route.ts')

const hostedCallbackRoutes = [
  {
    name: 'Clerk',
    route: clerkCallbackRoute,
    complete: mocks.completeClerkAuth,
    url: 'http://localhost/api/auth/clerk/callback?code=ok',
    failureCode: 'clerk callback failed',
  },
  {
    name: 'WorkOS',
    route: workosCallbackRoute,
    complete: mocks.completeWorkosAuth,
    url: 'http://localhost/api/auth/workos/callback?code=ok',
    failureCode: 'workos callback failed',
  },
]

describe('hosted auth callback routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  for (const hosted of hostedCallbackRoutes) {
    it(`redirects successful ${hosted.name} callbacks to admin`, async () => {
      const request = new Request(hosted.url)
      hosted.complete.mockResolvedValue({ error: null })

      const response = await hosted.route.GET(request)

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('http://localhost/admin')
      expect(hosted.complete).toHaveBeenCalledWith(request)
    })

    it(`encodes ${hosted.name} callback errors before redirecting to login`, async () => {
      hosted.complete.mockResolvedValue({
        error: {
          code: hosted.failureCode,
        },
      })

      const response = await hosted.route.GET(new Request(hosted.url))

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`http://localhost/login?error=${encodeURIComponent(hosted.failureCode)}`)
    })
  }
})
