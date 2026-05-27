import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  login: vi.fn(),
  loginForm: Symbol('loginForm'),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: mocks.guard,
  },
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: mocks.loginForm,
}))

const route = await import('../app/api/super-admin/login/route.ts')

function createRequest() {
  return new Request('http://localhost/api/super-admin/login', {
    method: 'POST',
  })
}

function createValidSubmission() {
  return {
    email: 'super-admin@example.com',
    password: 'admin-secret',
  }
}

describe('POST /api/super-admin/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.guard.mockReturnValue({
      login: mocks.login,
    })
  })

  it('redirects verified super admins to the super-admin dashboard', async () => {
    const submission = createValidSubmission()
    const user = {
      id: 1,
      email: 'super-admin@example.com',
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: false,
      user,
    })

    const response = await route.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'Signed in as super admin.',
        redirectTo: '/super-admin',
        user,
      },
    })
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.guard).toHaveBeenCalledWith('admin')
    expect(mocks.login).toHaveBeenCalledWith(submission)
  })

  it('redirects unverified super admins to the email verification route', async () => {
    const submission = createValidSubmission()
    const user = {
      id: 2,
      email: 'unverified-admin@example.com',
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: true,
      emailVerificationRoute: '/verify-email?email=unverified-admin%40example.com',
      user,
    })

    const response = await route.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'Signed in. Verify your email address to continue.',
        redirectTo: '/verify-email?email=unverified-admin%40example.com',
        user,
      },
    })
  })

  it('uses the default verification route when the session omits a route', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: true,
      user: {
        id: 3,
        email: 'fallback-admin@example.com',
      },
    })

    const response = await route.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        redirectTo: '/verify-email',
      },
    })
  })
})
