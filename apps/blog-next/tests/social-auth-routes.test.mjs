import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callback: vi.fn(),
  guard: vi.fn(),
  loginUsing: vi.fn(),
  nextRedirect: vi.fn(),
  socialRedirect: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: mocks.guard,
  },
}))

vi.mock('@holo-js/auth-social', () => ({
  callback: mocks.callback,
  redirect: mocks.socialRedirect,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.nextRedirect,
}))

const githubRoute = await import('../app/auth/github/route.ts')
const githubCallbackRoute = await import('../app/auth/github/callback/route.ts')
const googleRoute = await import('../app/auth/google/route.ts')
const googleCallbackRoute = await import('../app/auth/google/callback/route.ts')

const providers = [
  {
    name: 'GitHub',
    provider: 'github',
    route: githubRoute,
    callbackRoute: githubCallbackRoute,
    url: 'http://localhost/auth/github',
    callbackUrl: 'http://localhost/auth/github/callback?code=abc',
  },
  {
    name: 'Google',
    provider: 'google',
    route: googleRoute,
    callbackRoute: googleCallbackRoute,
    url: 'http://localhost/auth/google',
    callbackUrl: 'http://localhost/auth/google/callback?code=abc',
  },
]

function createRedirectError() {
  const error = new Error('NEXT_REDIRECT')
  error.digest = 'NEXT_REDIRECT'

  return error
}

describe('social auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nextRedirect.mockImplementation(() => {
      throw createRedirectError()
    })
  })

  for (const social of providers) {
    it(`starts ${social.name} login through the configured social provider`, async () => {
      const request = new Request(social.url)
      const redirectResponse = Response.redirect('http://localhost/social/start', 302)
      mocks.socialRedirect.mockResolvedValue(redirectResponse)

      await expect(social.route.GET(request)).resolves.toBe(redirectResponse)
      expect(mocks.socialRedirect).toHaveBeenCalledWith(social.provider, request)
    })

    it(`returns ${social.name} callback failures as JSON`, async () => {
      const request = new Request(social.callbackUrl)
      mocks.callback.mockResolvedValue({
        ok: false,
        message: 'Invalid or expired OAuth state.',
        status: 400,
      })

      const response = await social.callbackRoute.GET(request)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        message: 'Invalid or expired OAuth state.',
      })
      expect(mocks.callback).toHaveBeenCalledWith(social.provider, request)
      expect(mocks.guard).not.toHaveBeenCalled()
      expect(mocks.nextRedirect).not.toHaveBeenCalled()
    })

    it(`logs in ${social.name} callback users before redirecting to admin`, async () => {
      const request = new Request(social.callbackUrl)
      const user = {
        id: 10,
        email: `${social.provider}@example.com`,
      }

      mocks.callback.mockResolvedValue({
        ok: true,
        guard: 'web',
        user,
      })
      mocks.guard.mockReturnValue({
        loginUsing: mocks.loginUsing,
      })

      await expect(social.callbackRoute.GET(request)).rejects.toMatchObject({
        digest: 'NEXT_REDIRECT',
      })

      expect(mocks.callback).toHaveBeenCalledWith(social.provider, request)
      expect(mocks.guard).toHaveBeenCalledWith('web')
      expect(mocks.loginUsing).toHaveBeenCalledWith(user)
      expect(mocks.nextRedirect).toHaveBeenCalledWith('/admin')
    })
  }
})
