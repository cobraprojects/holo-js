import { ValidationException } from '@holo-js/validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resendEmailVerification: vi.fn(),
  resendEmailVerificationForm: Symbol('resendEmailVerificationForm'),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  resendEmailVerification: mocks.resendEmailVerification,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  resendEmailVerificationForm: mocks.resendEmailVerificationForm,
}))

const resendRoute = await import('../app/api/verify-email/resend/route.ts')

async function readJson(response) {
  return response.json()
}

function createRequest() {
  return new Request('http://localhost/api/verify-email/resend', {
    method: 'POST',
  })
}

function createValidationError(message, status = 422) {
  return ValidationException.withMessages({
    email: [message],
  }, {
    status,
  })
}

const genericSuccessPayload = {
  ok: true,
  status: 200,
  data: {
    message: 'A fresh verification email has been sent.',
  },
}

describe('POST /api/verify-email/resend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves malformed input validation errors', async () => {
    const error = createValidationError('Enter a valid email address.')
    const request = createRequest()
    mocks.validate.mockRejectedValue(error)

    const response = await resendRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(readJson(response)).resolves.toEqual(error.toJSON())
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.resendEmailVerificationForm, {
      throttle: 'emailVerificationResend',
    })
    expect(mocks.resendEmailVerification).not.toHaveBeenCalled()
  })

  it('returns the same generic response for resendable and non-resendable accounts', async () => {
    for (const outcome of [
      undefined,
      createValidationError('Email address is already verified.', 409),
      createValidationError('No account was found for this email.', 401),
    ]) {
      vi.clearAllMocks()
      mocks.validate.mockResolvedValue({ email: 'reader@example.com' })
      if (outcome) {
        mocks.resendEmailVerification.mockRejectedValue(outcome)
      } else {
        mocks.resendEmailVerification.mockResolvedValue(undefined)
      }

      const response = await resendRoute.POST(createRequest())

      expect(response.status).toBe(200)
      await expect(readJson(response)).resolves.toEqual(genericSuccessPayload)
      expect(mocks.resendEmailVerification).toHaveBeenCalledWith('reader@example.com')
    }
  })

  it('throws unexpected resend failures', async () => {
    const error = new Error('mail transport failed')
    mocks.validate.mockResolvedValue({ email: 'reader@example.com' })
    mocks.resendEmailVerification.mockRejectedValue(error)

    await expect(resendRoute.POST(createRequest())).rejects.toBe(error)
  })
})
