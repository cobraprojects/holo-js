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
    const validationError = new Error('Validation failed.')

    mocks.validate.mockRejectedValue(validationError)

    await expect(superAdminLoginAction(new FormData())).rejects.toBe(validationError)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(FormData), expect.anything(), {
      throttle: 'login',
    })
    expect(mocks.guardLogin).not.toHaveBeenCalled()
  })

  it('returns auth failures without redirecting', async () => {
    const input = {
      email: 'admin@example.com',
      password: 'bad-password',
      remember: false,
    }
    const authError = new Error('These credentials do not match our records.')
    mocks.validate.mockResolvedValue(input)
    mocks.guardLogin.mockImplementation(async () => {
      throw authError
    })

    await expect(superAdminLoginAction(new FormData())).rejects.toBe(authError)
    expect(mocks.guardLogin).toHaveBeenCalledWith(input)
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('uses the native Next redirect after super admin login', async () => {
    const input = {
      email: 'admin@example.com',
      password: 'secret-secret',
      remember: false,
    }
    mocks.validate.mockResolvedValue(input)
    mocks.guardLogin.mockResolvedValue({
      emailVerificationRequired: false,
      user: {
        email: 'admin@example.com',
      },
    })

    await expect(superAdminLoginAction(new FormData())).rejects.toMatchObject({
      location: '/super-admin',
    })

    expect(mocks.guardLogin).toHaveBeenCalledWith(input)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/super-admin')
  })

  it('redirects to email verification when the admin session requires it', async () => {
    const input = {
      email: 'admin@example.com',
      password: 'secret-secret',
      remember: false,
    }
    mocks.validate.mockResolvedValue(input)
    mocks.guardLogin.mockResolvedValue({
      emailVerificationRequired: true,
      emailVerificationRoute: '/verify-email',
      user: {
        email: 'admin@example.com',
      },
    })

    await expect(superAdminLoginAction(new FormData())).rejects.toMatchObject({
      location: '/verify-email',
    })

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/verify-email')
  })
})
