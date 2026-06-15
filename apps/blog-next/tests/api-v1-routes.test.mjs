import { ValidationException } from '@holo-js/validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    guard: vi.fn(),
  },
  validate: vi.fn(),
  loginForm: Symbol('loginForm'),
  Post: {
    with: vi.fn(),
  },
}))

vi.mock('@holo-js/auth', () => ({
  default: mocks.auth,
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: mocks.loginForm,
}))

vi.mock('@/server/models/Post', () => ({
  default: mocks.Post,
}))

const tokensRoute = await import('../app/api/v1/tokens/route.ts')
const postsRoute = await import('../app/api/v1/posts/route.ts')

async function readJson(response) {
  return response.json()
}

function createValidSubmission(data = {}) {
  return {
    email: 'reader@example.com',
    password: 'password123',
    remember: false,
    ...data,
  }
}

function createPostQuery(posts = []) {
  const query = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    get: vi.fn(async () => posts),
  }

  return query
}

function createValidationError(field, message, status = 422) {
  return ValidationException.withMessages({
    [field]: [message],
  }, {
    status,
  })
}

describe('POST /api/v1/tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures without attempting login', async () => {
    const validationError = createValidationError('email', 'Enter a valid email address.')
    const request = new Request('http://localhost/api/v1/tokens', {
      method: 'POST',
    })

    mocks.validate.mockRejectedValue(validationError)

    const response = await tokensRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(readJson(response)).resolves.toEqual(validationError.toJSON())
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.auth.guard).not.toHaveBeenCalled()
  })

  it('returns generic credential failures without exposing validation details', async () => {
    const authError = createValidationError('password', 'Password was incorrect.')
    const login = vi.fn(async () => {
      throw authError
    })
    const request = new Request('http://localhost/api/v1/tokens', {
      method: 'POST',
    })

    mocks.validate.mockResolvedValue(createValidSubmission())
    mocks.auth.guard.mockReturnValue({ login })

    const response = await tokensRoute.POST(request)

    expect(response.status).toBe(401)
    await expect(readJson(response)).resolves.toEqual({
      ok: false,
      status: 401,
      message: 'Invalid credentials.',
    })
    expect(mocks.auth.guard).toHaveBeenCalledWith('api')
    expect(login).toHaveBeenCalledWith({
      email: 'reader@example.com',
      password: 'password123',
      remember: false,
    })
  })

  it('throws unexpected API token login failures', async () => {
    const authError = new Error('token driver unavailable')
    const login = vi.fn(async () => {
      throw authError
    })
    const request = new Request('http://localhost/api/v1/tokens', {
      method: 'POST',
    })

    mocks.validate.mockResolvedValue(createValidSubmission())
    mocks.auth.guard.mockReturnValue({ login })

    await expect(tokensRoute.POST(request)).rejects.toBe(authError)
  })

  it('returns the issued API token with no-store caching', async () => {
    const token = {
      id: 'token_1',
      plainTextToken: 'plain-token',
      abilities: [],
    }
    const login = vi.fn(async () => token)
    const request = new Request('http://localhost/api/v1/tokens', {
      method: 'POST',
    })

    mocks.validate.mockResolvedValue(createValidSubmission({ remember: true }))
    mocks.auth.guard.mockReturnValue({ login })

    const response = await tokensRoute.POST(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      token: 'plain-token',
      tokenId: 'token_1',
      abilities: [],
    })
    expect(login).toHaveBeenCalledWith({
      email: 'reader@example.com',
      password: 'password123',
      remember: true,
    })
  })
})

describe('GET /api/v1/posts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no API user is authenticated', async () => {
    const user = vi.fn(async () => null)

    mocks.auth.guard.mockReturnValue({ user })

    const response = await postsRoute.GET()

    expect(response.status).toBe(401)
    await expect(readJson(response)).resolves.toEqual({
      ok: false,
      message: 'Unauthenticated.',
    })
    expect(mocks.auth.guard).toHaveBeenCalledWith('api')
    expect(user).toHaveBeenCalledTimes(1)
    expect(mocks.Post.with).not.toHaveBeenCalled()
  })

  it('returns 403 when the API user cannot read posts', async () => {
    const currentUser = {
      id: 'user_1',
      can: vi.fn(async () => false),
    }
    const user = vi.fn(async () => currentUser)

    mocks.auth.guard.mockReturnValue({ user })

    const response = await postsRoute.GET()

    expect(response.status).toBe(403)
    await expect(readJson(response)).resolves.toEqual({
      ok: false,
      message: 'Forbidden.',
    })
    expect(currentUser.can).toHaveBeenCalledWith('viewAny', mocks.Post)
    expect(mocks.Post.with).not.toHaveBeenCalled()
  })

  it('returns posts scoped to the authenticated API user', async () => {
    const posts = [
      {
        id: 1,
        title: 'Scoped post',
        user_id: 'user_1',
      },
    ]
    const query = createPostQuery(posts)
    const currentUser = {
      id: 'user_1',
      can: vi.fn(async () => true),
    }
    const user = vi.fn(async () => currentUser)

    mocks.auth.guard.mockReturnValue({ user })
    mocks.Post.with.mockReturnValue(query)

    const response = await postsRoute.GET()

    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      posts,
    })
    expect(mocks.Post.with).toHaveBeenCalledWith('category', 'tags')
    expect(query.where).toHaveBeenCalledWith('user_id', 'user_1')
    expect(query.orderBy).toHaveBeenCalledWith('published_at', 'desc')
    expect(query.get).toHaveBeenCalledTimes(1)
  })
})
