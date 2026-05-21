import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resetPassword: vi.fn(),
  resetPasswordForm: Symbol('resetPasswordForm'),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  resetPassword: mocks.resetPassword,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  resetPasswordForm: mocks.resetPasswordForm,
}))

const resetPasswordRoute = await import('../app/api/reset-password/route.ts')

async function readJson(response) {
  return response.json()
}

function createRequest() {
  return new Request('http://localhost/api/reset-password', {
    method: 'POST',
  })
}

function createValidSubmission() {
  return {
    valid: true,
    data: {
      token: 'reset-token',
      password: 'password123',
      passwordConfirmation: 'password123',
    },
    fail: vi.fn(),
    success: vi.fn(data => ({
      ok: true,
      data,
    })),
  }
}

describe('POST /api/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures without attempting a password reset', async () => {
    const failure = {
      ok: false,
      status: 422,
      errors: {
        token: ['Reset token is required.'],
      },
    }
    const submission = {
      valid: false,
      fail: vi.fn(() => failure),
    }
    const request = createRequest()

    mocks.validate.mockResolvedValue(submission)

    const response = await resetPasswordRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(readJson(response)).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.resetPasswordForm)
    expect(mocks.resetPassword).not.toHaveBeenCalled()
  })

  it('maps password reset errors onto the form submission response', async () => {
    const failure = {
      ok: false,
      status: 400,
      errors: {
        token: ['This reset link is invalid.'],
      },
    }
    const submission = createValidSubmission()
    submission.fail.mockReturnValue(failure)
    mocks.validate.mockResolvedValue(submission)
    mocks.resetPassword.mockResolvedValue({
      error: {
        status: 400,
        fields: failure.errors,
      },
    })

    const response = await resetPasswordRoute.POST(createRequest())

    expect(response.status).toBe(400)
    await expect(readJson(response)).resolves.toEqual(failure)
    expect(mocks.resetPassword).toHaveBeenCalledWith(submission.data)
    expect(submission.fail).toHaveBeenCalledWith({
      status: 400,
      errors: failure.errors,
    })
    expect(submission.success).not.toHaveBeenCalled()
  })

  it('returns a success payload after resetting the password', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.resetPassword.mockResolvedValue({
      error: null,
    })

    const response = await resetPasswordRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      data: {
        message: 'Password reset successfully. You can sign in with your new password.',
        redirectTo: '/login',
      },
    })
    expect(mocks.resetPassword).toHaveBeenCalledWith(submission.data)
    expect(submission.success).toHaveBeenCalledWith({
      message: 'Password reset successfully. You can sign in with your new password.',
      redirectTo: '/login',
    })
  })
})
