import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loginWithWorkos: vi.fn(),
}))

vi.mock('@holo-js/auth-workos', () => ({
  loginWithWorkos: mocks.loginWithWorkos,
}))

const workosLoginRoute = await import('../app/api/auth/workos/login/route.ts')

describe('hosted auth login routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes WorkOS login requests to the framework helper', async () => {
    const request = new Request('http://localhost/api/auth/workos/login?returnTo=/admin')
    const expected = Response.redirect('https://accounts.test/login', 302)
    mocks.loginWithWorkos.mockResolvedValue(expected)

    const response = await workosLoginRoute.GET(request)

    expect(response).toBe(expected)
    expect(mocks.loginWithWorkos).toHaveBeenCalledWith(request)
  })
})
