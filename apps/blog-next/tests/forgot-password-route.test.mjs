import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  forgotPasswordForm: Symbol('forgotPasswordForm'),
  requestPasswordReset: vi.fn(),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  requestPasswordReset: mocks.requestPasswordReset,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  forgotPasswordForm: mocks.forgotPasswordForm,
}))

const forgotPasswordRoute = await import('../app/api/forgot-password/route.ts')

function createRequest() {
  return new Request('http://localhost/api/forgot-password', {
    method: 'POST',
  })
}

function createValidSubmission() {
  return {
    valid: true,
    data: {
      email: 'ava@example.com',
    },
    fail: vi.fn(),
    success: vi.fn(data => ({
      ok: true,
      data,
    })),
  }
}

describe('POST /api/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures without requesting a reset', async () => {
    const failure = {
      ok: false,
      status: 422,
      errors: {
        email: ['Email is required.'],
      },
    }
    const submission = {
      valid: false,
      fail: vi.fn(() => failure),
    }
    const request = createRequest()

    mocks.validate.mockResolvedValue(submission)

    const response = await forgotPasswordRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.forgotPasswordForm)
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled()
  })

  it('maps reset request errors onto the form submission response', async () => {
    const failure = {
      ok: false,
      status: 429,
      errors: {
        email: ['Try again later.'],
      },
    }
    const submission = createValidSubmission()
    submission.fail.mockReturnValue(failure)
    mocks.validate.mockResolvedValue(submission)
    mocks.requestPasswordReset.mockResolvedValue({
      error: {
        status: 429,
        fields: failure.errors,
      },
    })

    const response = await forgotPasswordRoute.POST(createRequest())

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith(submission.data)
    expect(submission.fail).toHaveBeenCalledWith({
      status: 429,
      errors: failure.errors,
    })
    expect(submission.success).not.toHaveBeenCalled()
  })

  it('returns the generic success message after requesting a reset', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.requestPasswordReset.mockResolvedValue({
      error: null,
    })

    const response = await forgotPasswordRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        message: 'If an account exists for that email, a reset link has been sent.',
      },
    })
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith(submission.data)
    expect(submission.success).toHaveBeenCalledWith({
      message: 'If an account exists for that email, a reset link has been sent.',
    })
  })
})
