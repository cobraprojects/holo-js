import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registerWithWorkos: vi.fn(),
}))

vi.mock('@holo-js/auth-workos', () => ({
  registerWithWorkos: mocks.registerWithWorkos,
}))

const workosRegisterRoute = await import('../app/api/auth/workos/register/route.ts')

describe('hosted auth register routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes WorkOS register requests to the framework helper', async () => {
    const request = new Request('http://localhost/api/auth/workos/register?returnTo=/admin')
    const expected = Response.redirect('https://accounts.test/register', 302)
    mocks.registerWithWorkos.mockResolvedValue(expected)

    const response = await workosRegisterRoute.GET(request)

    expect(response).toBe(expected)
    expect(mocks.registerWithWorkos).toHaveBeenCalledWith(request)
  })
})
