import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  revalidatePath: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  logout: mocks.logout,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

const { logoutAction } = await import('../app/logout/actions.ts')

describe('logoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs out, revalidates the layout, and redirects home', async () => {
    mocks.logout.mockResolvedValue({
      authenticated: false,
    })

    await expect(logoutAction()).rejects.toMatchObject({
      location: '/',
    })

    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/')
  })
})
