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

function createValidSubmission(data) {
  return {
    valid: true,
    data,
  }
}

function createInvalidSubmission(payload) {
  return {
    valid: false,
    fail: vi.fn(() => payload),
  }
}

describe('login action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the shared forms validate API before the Next redirect', async () => {
    const formData = new FormData()
    formData.set('email', 'editor@example.com')
    formData.set('password', 'secret-secret')
    mocks.validate.mockResolvedValue(createValidSubmission({
      email: 'editor@example.com',
      password: 'secret-secret',
      remember: false,
    }))
    mocks.login.mockResolvedValue({
      data: {
        emailVerificationRequired: false,
        user: {
          id: 'user-1',
          email: 'editor@example.com',
        },
      },
      error: null,
    })
    mocks.redirect.mockImplementation((url) => {
      throw new RedirectSignal(url)
    })

    await expect(loginAction(formData)).rejects.toMatchObject({
      url: '/admin',
    })

    expect(mocks.validate).toHaveBeenCalledWith(formData, {}, {
      csrf: true,
      throttle: 'login',
    })
    expect(mocks.login).toHaveBeenCalledWith({
      email: 'editor@example.com',
      password: 'secret-secret',
      remember: false,
    })
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/admin')
  })

  it('returns validation failures without logging in', async () => {
    const failure = {
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: '',
      },
      errors: {
        email: ['Email is required.'],
      },
    }
    mocks.validate.mockResolvedValue(createInvalidSubmission(failure))

    await expect(loginAction(new FormData())).resolves.toBe(failure)

    expect(mocks.login).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
