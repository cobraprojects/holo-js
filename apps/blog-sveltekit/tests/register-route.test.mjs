import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loginUsing: vi.fn(),
  register: vi.fn(),
  registerForm: Symbol('registerForm'),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  loginUsing: mocks.loginUsing,
  register: mocks.register,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('$lib/schemas/auth', () => ({
  registerForm: mocks.registerForm,
}))

const registerRoute = await import('../src/routes/api/register/+server.ts')

function createRequest() {
  return new Request('http://localhost/api/register', {
    method: 'POST',
  })
}

function createValidSubmission() {
  return {
    valid: true,
    data: {
      name: 'Reader',
      email: 'reader@example.com',
      password: 'password123',
      passwordConfirmation: 'password123',
    },
    fail: vi.fn(),
    success: vi.fn((data, status) => ({
      ok: true,
      status,
      data,
    })),
  }
}

describe('POST /api/register', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures before creating an account', async () => {
    const failure = {
      ok: false,
      status: 422,
      errors: {
        email: ['Enter a valid email address.'],
      },
    }
    const submission = {
      valid: false,
      fail: vi.fn(() => failure),
    }
    const request = createRequest()

    mocks.validate.mockResolvedValue(submission)

    const response = await registerRoute.POST({ request })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.loginUsing).not.toHaveBeenCalled()
  })

  it('returns registration field errors without logging in', async () => {
    const submission = createValidSubmission()
    const failure = {
      ok: false,
      status: 422,
      errors: {
        email: ['The email has already been taken.'],
      },
    }

    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: null,
      error: {
        status: 422,
        fields: failure.errors,
      },
    })
    submission.fail.mockReturnValue(failure)

    const response = await registerRoute.POST({ request: createRequest() })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(submission.fail).toHaveBeenCalledWith({
      status: 422,
      errors: failure.errors,
    })
    expect(mocks.loginUsing).not.toHaveBeenCalled()
  })

  it('returns the verification redirect when email verification is required', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const session = {
      emailVerificationRequired: true,
      emailVerificationRoute: '/verify-email?email=reader%40example.com',
      user: created,
    }
    const submission = createValidSubmission()

    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: created,
      error: null,
    })
    mocks.loginUsing.mockResolvedValue(session)

    const response = await registerRoute.POST({ request: createRequest() })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 201,
      data: {
        message: 'Account created. Check your inbox to verify your email address.',
        redirectTo: '/verify-email?email=reader%40example.com',
        user: created,
      },
    })
    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
  })

  it('returns the admin redirect when verification is not required', async () => {
    const created = {
      id: 8,
      email: 'verified@example.com',
    }
    const session = {
      emailVerificationRequired: false,
      user: created,
    }
    const submission = createValidSubmission()

    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: created,
      error: null,
    })
    mocks.loginUsing.mockResolvedValue(session)

    const response = await registerRoute.POST({ request: createRequest() })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 201,
      data: {
        message: 'Account created and signed in successfully.',
        redirectTo: '/admin',
        user: created,
      },
    })
    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
  })
})
