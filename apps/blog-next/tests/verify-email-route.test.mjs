import { ValidationException } from '@holo-js/validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  validate: vi.fn(),
  verifyEmail: vi.fn(),
  verifyEmailForm: Symbol('verifyEmailForm'),
}))

vi.mock('@holo-js/auth', () => ({
  check: mocks.check,
  verifyEmail: mocks.verifyEmail,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  verifyEmailForm: mocks.verifyEmailForm,
}))

const route = await import('../app/api/verify-email/route.ts')

function createRequest() {
  return new Request('http://localhost/api/verify-email', {
    method: 'POST',
  })
}

describe('POST /api/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation exception responses without verifying the email', async () => {
    const validationError = ValidationException.withMessages({
      token: ['The token is required.'],
    })
    mocks.validate.mockRejectedValue(validationError)

    const response = await route.POST(createRequest())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      errors: {
        token: ['The token is required.'],
      },
    })
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.verifyEmailForm)
    expect(mocks.verifyEmail).not.toHaveBeenCalled()
  })

  it('throws verification failures without remapping them in userland', async () => {
    const input = { token: 'bad-token' }
    const verificationError = new Error('Invalid verification token.')
    mocks.validate.mockResolvedValue(input)
    mocks.check.mockResolvedValue(false)
    mocks.verifyEmail.mockImplementation(async () => {
      throw verificationError
    })

    await expect(route.POST(createRequest())).rejects.toBe(verificationError)

    expect(mocks.verifyEmail).toHaveBeenCalledWith('bad-token')
  })

  it('redirects unauthenticated users to login after verification', async () => {
    mocks.validate.mockResolvedValue({ token: 'valid-token' })
    mocks.check.mockResolvedValue(false)
    mocks.verifyEmail.mockResolvedValue(undefined)

    const response = await route.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        redirectTo: '/login',
      },
    })
  })

  it('redirects authenticated users to admin after verification', async () => {
    mocks.validate.mockResolvedValue({ token: 'valid-token' })
    mocks.check.mockResolvedValue(true)
    mocks.verifyEmail.mockResolvedValue(undefined)

    const response = await route.POST(createRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        redirectTo: '/admin',
      },
    })
  })
})
