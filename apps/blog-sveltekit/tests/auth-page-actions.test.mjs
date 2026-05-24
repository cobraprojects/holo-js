import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guardLogin: vi.fn(),
  guardLogout: vi.fn(),
  json: vi.fn((data, init) => new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
    },
  })),
  login: vi.fn(),
  loginForm: Symbol('loginForm'),
  loginUsing: vi.fn(),
  logout: vi.fn(),
  redirect: vi.fn((status, location) => {
    const error = new Error('SVELTEKIT_REDIRECT')
    error.status = status
    error.location = location
    throw error
  }),
  register: vi.fn(),
  registerForm: Symbol('registerForm'),
  validate: vi.fn(),
}))

vi.mock('@sveltejs/kit', () => ({
  json: mocks.json,
  redirect: mocks.redirect,
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: vi.fn(() => ({
      login: mocks.guardLogin,
      logout: mocks.guardLogout,
    })),
  },
  login: mocks.login,
  loginUsing: mocks.loginUsing,
  logout: mocks.logout,
  register: mocks.register,
}))

vi.mock('@holo-js/auth/sveltekit/server', () => ({
  auth: vi.fn(async () => ({
    authenticated: true,
    user: {
      email: 'super-admin@example.com',
      name: 'Super Admin',
    },
  })),
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('$lib/schemas/auth', () => ({
  loginForm: mocks.loginForm,
  registerForm: mocks.registerForm,
}))

const loginRoute = await import('../src/routes/api/login/+server.ts')
const logoutRoute = await import('../src/routes/logout/+server.ts')
const registerRoute = await import('../src/routes/api/register/+server.ts')
const superAdminPage = await import('../src/routes/super-admin/+page.server.ts')
const superAdminLoginRoute = await import('../src/routes/api/super-admin/login/+server.ts')

function createRequest(path = '/login') {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
  })
}

describe('SvelteKit login API route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before logging in', async () => {
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
    mocks.validate.mockResolvedValue(submission)

    const response = await loginRoute.POST({
      request: createRequest('/api/login'),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      csrf: true,
      throttle: 'login',
    })
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('returns the login redirect target after successful login', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'editor@example.com',
        password: 'secret-secret',
        remember: false,
      },
      fail: vi.fn(),
      success: vi.fn((data, status = 200) => ({
        ok: true,
        status,
        data,
      })),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.login.mockResolvedValue({
      data: {
        emailVerificationRequired: false,
        user: {
          email: 'editor@example.com',
        },
      },
      error: null,
    })

    const response = await loginRoute.POST({
      request: createRequest('/api/login'),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        redirectTo: '/admin',
      },
    })
    expect(mocks.login).toHaveBeenCalledWith(submission.data)
  })
})

describe('SvelteKit register API route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before registering', async () => {
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
    mocks.validate.mockResolvedValue(submission)

    const response = await registerRoute.POST({
      request: createRequest('/api/register'),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('returns the registration redirect target after successful registration', async () => {
    const created = {
      email: 'reader@example.com',
    }
    const submission = {
      valid: true,
      data: {
        name: 'Reader',
        email: 'reader@example.com',
        password: 'secret-secret',
        passwordConfirmation: 'secret-secret',
      },
      fail: vi.fn(),
      success: vi.fn((data, status = 200) => ({
        ok: true,
        status,
        data,
      })),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: created,
      error: null,
    })
    mocks.loginUsing.mockResolvedValue({
      emailVerificationRequired: true,
      emailVerificationRoute: '/verify-email?email=reader%40example.com',
      user: created,
    })

    const response = await registerRoute.POST({
      request: createRequest('/api/register'),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        redirectTo: '/verify-email?email=reader%40example.com',
      },
    })
    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
  })
})

describe('SvelteKit logout route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs out and redirects from the server', async () => {
    mocks.logout.mockResolvedValue({
      authenticated: false,
    })

    await expect(logoutRoute.POST()).rejects.toMatchObject({
      status: 303,
      location: '/',
    })

    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).toHaveBeenCalledWith(303, '/')
  })
})

describe('SvelteKit super admin page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs out the admin guard and redirects to super admin login', async () => {
    mocks.guardLogout.mockResolvedValue({
      authenticated: false,
    })

    await expect(superAdminPage.actions.default()).rejects.toMatchObject({
      status: 303,
      location: '/super-admin/login',
    })

    expect(mocks.guardLogout).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).toHaveBeenCalledWith(303, '/super-admin/login')
  })
})

describe('SvelteKit super admin login API route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before logging in the admin guard', async () => {
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
    mocks.validate.mockResolvedValue(submission)

    const response = await superAdminLoginRoute.POST({
      request: createRequest('/api/super-admin/login'),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.guardLogin).not.toHaveBeenCalled()
  })

  it('returns the super admin redirect target after login', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'super-admin@example.com',
        password: 'admin-secret',
        remember: false,
      },
      fail: vi.fn(),
      success: vi.fn((data, status = 200) => ({
        ok: true,
        status,
        data,
      })),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.guardLogin.mockResolvedValue({
      data: {
        emailVerificationRequired: false,
        user: {
          email: 'super-admin@example.com',
        },
      },
      error: null,
    })

    const response = await superAdminLoginRoute.POST({
      request: createRequest('/api/super-admin/login'),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        redirectTo: '/super-admin',
      },
    })
    expect(mocks.guardLogin).toHaveBeenCalledWith(submission.data)
  })
})
