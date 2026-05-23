import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  guard: vi.fn(),
  provider: vi.fn(),
  user: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: mocks.guard,
  },
  check: mocks.check,
  isAuthError: value => Boolean(
    value
      && typeof value === 'object'
      && value.name === 'AuthError'
      && typeof value.code === 'string',
  ),
  provider: mocks.provider,
  user: mocks.user,
}))

const route = await import('../app/api/auth/user/route.ts')

function createAuthError(code, message) {
  const error = new Error(message)
  error.name = 'AuthError'
  error.code = code

  return error
}

describe('current auth route', () => {
  it('returns a controlled unauthenticated response for unknown guard queries', async () => {
    mocks.guard.mockImplementation(() => {
      throw createAuthError('guard_not_configured', 'Auth guard "missing" is not configured.')
    })

    const response = await route.GET(new Request('http://localhost/api/auth/user?guard=missing'))
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      authenticated: false,
      guard: 'missing',
      provider: null,
      user: null,
    })
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
    expect(mocks.user).not.toHaveBeenCalled()
  })
})
