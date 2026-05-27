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
    email: 'ava@example.com',
  }
}

describe('POST /api/forgot-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures without requesting a reset', async () => {
    const validationError = new Error('Validation failed.')
    const request = createRequest()

    mocks.validate.mockRejectedValue(validationError)

    await expect(forgotPasswordRoute.POST(request)).rejects.toBe(validationError)

    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.forgotPasswordForm)
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled()
  })

  it('throws reset request errors without mapping them in userland', async () => {
    const resetError = new Error('Try again later.')
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.requestPasswordReset.mockImplementation(async () => {
      throw resetError
    })

    await expect(forgotPasswordRoute.POST(createRequest())).rejects.toBe(resetError)

    expect(mocks.requestPasswordReset).toHaveBeenCalledWith(submission)
  })

  it('returns the generic success message after requesting a reset', async () => {
    const submission = createValidSubmission()
    mocks.validate.mockResolvedValue(submission)
    mocks.requestPasswordReset.mockResolvedValue(undefined)

    const response = await forgotPasswordRoute.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        message: 'If an account exists for that email, a reset link has been sent.',
      },
    })
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith(submission)
  })
})
