import { ValidationException } from '@holo-js/validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginForm: Symbol('loginForm'),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  login: mocks.login,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: mocks.loginForm,
}))

const loginRoute = await import('../app/api/login/route.ts')

function createRequest() {
  return new Request('http://localhost/api/login', {
    method: 'POST',
  })
}

function createValidSubmission() {
  return {
    email: 'author@example.com',
    password: 'password123',
  }
}

describe('POST /api/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the admin redirect target for verified users', async () => {
    const submission = createValidSubmission()
    const user = {
      id: 1,
      email: 'author@example.com',
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: false,
      user,
    })

    const response = await loginRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'Signed in successfully.',
        redirectTo: '/admin',
        user,
      },
    })
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.login).toHaveBeenCalledWith(submission)
  })

  it('uses the session email verification route for unverified users', async () => {
    const submission = createValidSubmission()
    const user = {
      id: 2,
      email: 'unverified@example.com',
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: true,
      emailVerificationRoute: '/verify-email?email=unverified%40example.com',
      user,
    })

    const response = await loginRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'Signed in. Verify your email address to continue.',
        redirectTo: '/verify-email?email=unverified%40example.com',
        user,
      },
    })
  })

  it('falls back to the default verification route when the session omits one', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: true,
      user: {
        id: 3,
        email: 'fallback@example.com',
      },
    })

    const response = await loginRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        redirectTo: '/verify-email',
      },
    })
  })

  it('returns validation exception responses without attempting login', async () => {
    const validationError = ValidationException.withMessages({
      email: ['The email field is required.'],
    })
    mocks.validate.mockRejectedValue(validationError)

    const response = await loginRoute.POST(createRequest())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(validationError.toJSON())
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('throws unexpected login failures without remapping them in userland', async () => {
    const submission = createValidSubmission()
    const loginError = new Error('Session store unavailable.')
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockImplementation(async () => {
      throw loginError
    })

    await expect(loginRoute.POST(createRequest())).rejects.toBe(loginError)

    expect(mocks.login).toHaveBeenCalledWith(submission)
  })
})
