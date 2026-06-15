import { ValidationException } from '@holo-js/validation'
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
    token: 'reset-token',
    password: 'password123',
    passwordConfirmation: 'password123',
  }
}

function createValidationError(field, message, status = 422) {
  return ValidationException.withMessages({
    [field]: [message],
  }, {
    status,
  })
}

describe('POST /api/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures without attempting a password reset', async () => {
    const validationError = createValidationError('token', 'The reset token is required.')
    const request = createRequest()

    mocks.validate.mockRejectedValue(validationError)

    const response = await resetPasswordRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(readJson(response)).resolves.toEqual(validationError.toJSON())
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.resetPasswordForm)
    expect(mocks.resetPassword).not.toHaveBeenCalled()
  })

  it('returns password confirmation validation failures', async () => {
    const validationError = createValidationError('passwordConfirmation', 'The password confirmation does not match.')
    mocks.validate.mockRejectedValue(validationError)

    const response = await resetPasswordRoute.POST(createRequest())

    expect(response.status).toBe(422)
    await expect(readJson(response)).resolves.toEqual(validationError.toJSON())
    expect(mocks.resetPassword).not.toHaveBeenCalled()
  })

  it('throws password reset errors without mapping them in userland', async () => {
    const resetError = new Error('This reset link is invalid.')
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.resetPassword.mockImplementation(async () => {
      throw resetError
    })

    await expect(resetPasswordRoute.POST(createRequest())).rejects.toBe(resetError)

    expect(mocks.resetPassword).toHaveBeenCalledWith(submission)
  })

  it('returns a success payload after resetting the password', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.resetPassword.mockResolvedValue(undefined)

    const response = await resetPasswordRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'Password reset successfully. You can sign in with your new password.',
        redirectTo: '/login',
      },
    })
    expect(mocks.resetPassword).toHaveBeenCalledWith(submission)
  })
})
