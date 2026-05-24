import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  csrfField: vi.fn(),
  fail: vi.fn((status, data) => ({
    status,
    data,
  })),
  guardLogin: vi.fn(),
  guardLogout: vi.fn(),
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
  securityRuntime: vi.fn(() => ({
    config: {
      csrf: {
        cookie: 'XSRF-TOKEN',
      },
    },
  })),
  validate: vi.fn(),
}))

vi.mock('@sveltejs/kit', () => ({
  fail: mocks.fail,
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

vi.mock('@holo-js/security', () => ({
  csrf: {
    field: mocks.csrfField,
  },
  getSecurityRuntime: mocks.securityRuntime,
}))

vi.mock('$lib/schemas/auth', () => ({
  loginForm: mocks.loginForm,
  registerForm: mocks.registerForm,
}))

const loginPage = await import('../src/routes/login/+page.server.ts')
const logoutRoute = await import('../src/routes/logout/+server.ts')
const registerPage = await import('../src/routes/register/+page.server.ts')
const superAdminPage = await import('../src/routes/super-admin/+page.server.ts')
const superAdminLoginPage = await import('../src/routes/super-admin/login/+page.server.ts')

function createRequest(path = '/login') {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
  })
}

function createCookies() {
  return {
    set: vi.fn(),
  }
}

describe('SvelteKit auth page loads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets the csrf cookie and returns the hidden field for login', async () => {
    const cookies = createCookies()
    const csrfField = {
      name: '_token',
      value: 'signed-token',
    }
    mocks.csrfField.mockResolvedValue(csrfField)

    await expect(loginPage.load({
      cookies,
      request: createRequest('/login'),
      url: new URL('http://localhost/login'),
    })).resolves.toEqual({
      csrf: csrfField,
    })

    expect(cookies.set).toHaveBeenCalledWith('XSRF-TOKEN', 'signed-token', {
      path: '/',
      sameSite: 'lax',
      secure: false,
    })
  })

  it('sets the csrf cookie and returns the hidden field for register', async () => {
    const cookies = createCookies()
    const csrfField = {
      name: '_token',
      value: 'signed-register-token',
    }
    mocks.csrfField.mockResolvedValue(csrfField)

    await expect(registerPage.load({
      cookies,
      request: createRequest('/register'),
      url: new URL('https://localhost/register'),
    })).resolves.toEqual({
      csrf: csrfField,
    })

    expect(cookies.set).toHaveBeenCalledWith('XSRF-TOKEN', 'signed-register-token', {
      path: '/',
      sameSite: 'lax',
      secure: true,
    })
  })
})

describe('SvelteKit login page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SvelteKit action failures before logging in', async () => {
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

    await expect(loginPage.actions.default({
      request: createRequest('/login'),
    })).resolves.toEqual({
      status: 422,
      data: failure,
    })

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      csrf: true,
      throttle: 'login',
    })
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('redirects from the server after successful login', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'editor@example.com',
        password: 'secret-secret',
        remember: false,
      },
      fail: vi.fn(),
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

    await expect(loginPage.actions.default({
      request: createRequest('/login'),
    })).rejects.toMatchObject({
      status: 303,
      location: '/admin',
    })

    expect(mocks.login).toHaveBeenCalledWith(submission.data)
    expect(mocks.redirect).toHaveBeenCalledWith(303, '/admin')
  })
})

describe('SvelteKit register page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SvelteKit action failures before registering', async () => {
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

    await expect(registerPage.actions.default({
      request: createRequest('/register'),
    })).resolves.toEqual({
      status: 422,
      data: failure,
    })

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('redirects from the server after successful registration', async () => {
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

    await expect(registerPage.actions.default({
      request: createRequest('/register'),
    })).rejects.toMatchObject({
      status: 303,
      location: '/verify-email?email=reader%40example.com',
    })

    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
    expect(mocks.redirect).toHaveBeenCalledWith(303, '/verify-email?email=reader%40example.com')
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

describe('SvelteKit super admin login page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SvelteKit action failures before logging in the admin guard', async () => {
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

    await expect(superAdminLoginPage.actions.default({
      request: createRequest('/super-admin/login'),
    })).resolves.toEqual({
      status: 422,
      data: failure,
    })

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.guardLogin).not.toHaveBeenCalled()
  })

  it('redirects from the server after super admin login', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'super-admin@example.com',
        password: 'admin-secret',
        remember: false,
      },
      fail: vi.fn(),
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

    await expect(superAdminLoginPage.actions.default({
      request: createRequest('/super-admin/login'),
    })).rejects.toMatchObject({
      status: 303,
      location: '/super-admin',
    })

    expect(mocks.guardLogin).toHaveBeenCalledWith(submission.data)
    expect(mocks.redirect).toHaveBeenCalledWith(303, '/super-admin')
  })
})
