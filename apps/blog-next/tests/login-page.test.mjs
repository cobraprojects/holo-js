import { beforeEach, describe, expect, it, vi } from 'vitest'

class RedirectSignal extends Error {
  constructor(url) {
    super(`Redirected to ${url}`)
    this.url = url
  }
}

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  login: mocks.login,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: {},
}))

const { loginAction } = await import('../app/login/actions.ts')

describe('login action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the shared forms validate API before the Next redirect', async () => {
    const formData = new FormData()
    formData.set('email', 'editor@example.com')
    formData.set('password', 'secret-secret')
    const input = {
      email: 'editor@example.com',
      password: 'secret-secret',
      remember: false,
    }
    mocks.validate.mockResolvedValue(input)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: false,
      user: {
        id: 'user-1',
        email: 'editor@example.com',
      },
    })
    mocks.redirect.mockImplementation((url) => {
      throw new RedirectSignal(url)
    })

    await expect(loginAction(formData)).rejects.toMatchObject({
      url: '/admin',
    })

    expect(mocks.validate).toHaveBeenCalledWith(formData, {}, {
      throttle: 'login',
    })
    expect(mocks.login).toHaveBeenCalledWith(input)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/admin')
  })

  it('returns validation failures without logging in', async () => {
    const validationError = new Error('Validation failed.')
    mocks.validate.mockRejectedValue(validationError)

    await expect(loginAction(new FormData())).rejects.toBe(validationError)

    expect(mocks.login).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
