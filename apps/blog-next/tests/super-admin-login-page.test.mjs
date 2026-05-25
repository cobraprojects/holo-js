import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guardLogin: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  revalidatePath: vi.fn(),
  superAdminLoginAction: vi.fn(),
  useForm: vi.fn(),
  validate: vi.fn(),
}))

vi.mock('@holo-js/adapter-next/client', () => ({
  useForm: mocks.useForm,
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: vi.fn(() => ({
      login: mocks.guardLogin,
    })),
  },
}))

vi.mock('@holo-js/forms', () => ({
  validate: mocks.validate,
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: Symbol('loginForm'),
}))

vi.mock('../app/super-admin/login/actions.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  superAdminLoginAction: mocks.superAdminLoginAction,
}))

const { default: SuperAdminLoginPage } = await import('../app/super-admin/login/page.tsx')
vi.doUnmock('../app/super-admin/login/actions.ts')
const { superAdminLoginAction } = await import('../app/super-admin/login/actions.ts?actual')

function createFormState(rootError, submit = vi.fn()) {
  return {
    values: {
      email: '',
      password: '',
      remember: false,
    },
    fields: {
      email: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
      password: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
      remember: {
        onInput: vi.fn(),
      },
    },
    errors: {
      has: vi.fn(() => false),
      first: vi.fn(field => field === '_root' ? rootError : undefined),
    },
    submitting: false,
    submit,
    lastSubmission: {
      ok: false,
    },
  }
}

describe('super admin login page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders root submission errors above the fields', async () => {
    mocks.useForm.mockReturnValue(createFormState('Too many login attempts.'))

    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLoginPage, {}))
    })

    const rootError = renderer.root.findByProps({
      children: 'Too many login attempts.',
    })

    expect(rootError.type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('submits through the super admin login server action', async () => {
    mocks.superAdminLoginAction.mockResolvedValue({
      ok: false,
      status: 422,
    })
    mocks.useForm.mockImplementation((_schema, options) => createFormState(undefined, vi.fn(async () => {
      const formData = new FormData()
      formData.set('email', 'admin@example.com')
      formData.set('password', 'secret-secret')

      return await options.submitter({ formData })
    })))

    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLoginPage, {}))
    })

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.superAdminLoginAction).toHaveBeenCalledWith(expect.any(FormData))

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe('superAdminLoginAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures before logging in', async () => {
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

    await expect(superAdminLoginAction(new FormData())).resolves.toBe(failure)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(FormData), expect.anything(), {
      throttle: 'login',
    })
    expect(mocks.guardLogin).not.toHaveBeenCalled()
  })

  it('returns auth failures without redirecting', async () => {
    const failure = {
      ok: false,
      status: 401,
      errors: {
        _root: ['These credentials do not match our records.'],
      },
    }
    const submission = {
      valid: true,
      data: {
        email: 'admin@example.com',
        password: 'bad-password',
        remember: false,
      },
      fail: vi.fn(() => failure),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.guardLogin.mockResolvedValue({
      data: null,
      error: {
        status: 401,
        fields: {
          _root: ['These credentials do not match our records.'],
        },
      },
    })

    await expect(superAdminLoginAction(new FormData())).resolves.toBe(failure)
    expect(mocks.guardLogin).toHaveBeenCalledWith(submission.data)
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('uses the native Next redirect after super admin login', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'admin@example.com',
        password: 'secret-secret',
        remember: false,
      },
      fail: vi.fn(),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.guardLogin.mockResolvedValue({
      data: {
        emailVerificationRequired: false,
        user: {
          email: 'admin@example.com',
        },
      },
      error: null,
    })

    await expect(superAdminLoginAction(new FormData())).rejects.toMatchObject({
      location: '/super-admin',
    })

    expect(mocks.guardLogin).toHaveBeenCalledWith(submission.data)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/super-admin')
  })

  it('redirects to email verification when the admin session requires it', async () => {
    const submission = {
      valid: true,
      data: {
        email: 'admin@example.com',
        password: 'secret-secret',
        remember: false,
      },
      fail: vi.fn(),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.guardLogin.mockResolvedValue({
      data: {
        emailVerificationRequired: true,
        emailVerificationRoute: '/verify-email',
        user: {
          email: 'admin@example.com',
        },
      },
      error: null,
    })

    await expect(superAdminLoginAction(new FormData())).rejects.toMatchObject({
      location: '/verify-email',
    })

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/verify-email')
  })
})
