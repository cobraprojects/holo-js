import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fail: vi.fn((status, data) => ({
    ...data,
    status,
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

describe('SvelteKit login page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before logging in', async () => {
    const validationError = new Error('Validation failed.')
    mocks.validate.mockRejectedValue(validationError)

    await expect(loginPage.actions.default({
      request: createRequest('/login'),
    })).rejects.toBe(validationError)

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('returns the login redirect target after successful login', async () => {
    const input = {
      email: 'editor@example.com',
      password: 'secret-secret',
      remember: false,
    }
    mocks.validate.mockResolvedValue(input)
    mocks.login.mockResolvedValue({
      emailVerificationRequired: false,
      user: {
        email: 'editor@example.com',
      },
    })

    await expect(loginPage.actions.default({
      request: createRequest('/login'),
    })).rejects.toMatchObject({
      status: 303,
      location: '/admin',
    })
    expect(mocks.login).toHaveBeenCalledWith(input)
  })
})

describe('SvelteKit register page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before registering', async () => {
    const validationError = new Error('Validation failed.')
    mocks.validate.mockRejectedValue(validationError)

    await expect(registerPage.actions.default({
      request: createRequest('/register'),
    })).rejects.toBe(validationError)

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.registerForm, {
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('returns the registration redirect target after successful registration', async () => {
    const created = {
      email: 'reader@example.com',
    }
    const input = {
      name: 'Reader',
      email: 'reader@example.com',
      password: 'secret-secret',
      passwordConfirmation: 'secret-secret',
    }
    mocks.validate.mockResolvedValue(input)
    mocks.register.mockResolvedValue(created)
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
    expect(mocks.register).toHaveBeenCalledWith(input)
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

describe('SvelteKit super admin login page action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns form failures before logging in the admin guard', async () => {
    const validationError = new Error('Validation failed.')
    mocks.validate.mockRejectedValue(validationError)

    await expect(superAdminLoginPage.actions.default({
      request: createRequest('/super-admin/login'),
    })).rejects.toBe(validationError)

    expect(mocks.validate).toHaveBeenCalledWith(expect.any(Request), mocks.loginForm, {
      throttle: 'login',
    })
    expect(mocks.guardLogin).not.toHaveBeenCalled()
  })

  it('returns the super admin redirect target after login', async () => {
    const input = {
      email: 'super-admin@example.com',
      password: 'admin-secret',
      remember: false,
    }
    mocks.validate.mockResolvedValue(input)
    mocks.guardLogin.mockResolvedValue({
      emailVerificationRequired: false,
      user: {
        email: 'super-admin@example.com',
      },
    })

    await expect(superAdminLoginPage.actions.default({
      request: createRequest('/super-admin/login'),
    })).rejects.toMatchObject({
      status: 303,
      location: '/super-admin',
    })
    expect(mocks.guardLogin).toHaveBeenCalledWith(input)
  })
})
