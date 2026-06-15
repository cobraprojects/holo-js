import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  logout: vi.fn(),
  user: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: mocks.guard,
  },
}))

const route = await import('../app/api/super-admin/logout/route.ts')

describe('POST /api/super-admin/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.guard.mockReturnValue({
      logout: mocks.logout,
      user: mocks.user,
    })
  })

  it('logs out through the admin guard before returning current auth state', async () => {
    mocks.logout.mockResolvedValue(undefined)
    mocks.user.mockResolvedValue(null)

    const response = await route.POST()
    const payload = await response.json()

    expect(mocks.guard).toHaveBeenCalledWith('admin')
    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(mocks.user).toHaveBeenCalledTimes(1)
    expect(mocks.logout.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.user.mock.invocationCallOrder[0],
    )
    expect(payload).toEqual({
      ok: true,
      authenticated: false,
      message: 'Signed out of super admin.',
      user: null,
    })
  })
})
