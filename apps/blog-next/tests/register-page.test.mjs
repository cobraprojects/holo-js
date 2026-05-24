import assert from 'node:assert/strict'
import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loginUsing: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  register: vi.fn(),
  registerForm: Symbol('registerForm'),
  revalidatePath: vi.fn(),
  useForm: vi.fn(),
  validate: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  loginUsing: mocks.loginUsing,
  register: mocks.register,
}))

vi.mock('@holo-js/adapter-next/client', () => ({
  useForm: mocks.useForm,
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

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/lib/schemas/auth', () => ({
  registerForm: mocks.registerForm,
}))

const { default: RegisterPage } = await import('../app/register/page.tsx')
const { registerAction } = await import('../app/register/actions.ts')

function createFormState(submit) {
  return {
    values: {
      name: '',
      email: '',
      password: '',
      passwordConfirmation: '',
    },
    fields: {
      name: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
      email: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
      password: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
      passwordConfirmation: {
        onInput: vi.fn(),
        onBlur: vi.fn(),
      },
    },
    errors: {
      has: vi.fn(() => false),
      first: vi.fn(),
    },
    submitting: false,
    submit,
    lastSubmission: null,
  }
}

describe('register page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits through the register server action', async () => {
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
    mocks.useForm.mockImplementation((_schema, options) => createFormState(vi.fn(async () => {
      const formData = new FormData()
      formData.set('name', 'Reader')
      formData.set('email', 'bad')
      formData.set('password', 'password123')
      formData.set('passwordConfirmation', 'password123')

      return await options.submitter({ formData })
    })))

    let renderer
    await act(async () => {
      renderer = create(jsx(RegisterPage, {}))
    })

    assert.ok(renderer, 'Expected register page to render.')

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.useForm).toHaveBeenCalledWith(mocks.registerForm, expect.objectContaining({
      csrf: true,
      validateOn: 'blur',
    }))
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(FormData), mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe('registerAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns validation failures before creating an account', async () => {
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

    await expect(registerAction(new FormData())).resolves.toBe(failure)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(FormData), mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.loginUsing).not.toHaveBeenCalled()
  })

  it('returns registration failures without starting a session', async () => {
    const failure = {
      ok: false,
      status: 422,
      errors: {
        email: ['The email has already been taken.'],
      },
    }
    const submission = {
      valid: true,
      data: {
        name: 'Reader',
        email: 'reader@example.com',
        password: 'password123',
        passwordConfirmation: 'password123',
      },
      fail: vi.fn(() => failure),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: null,
      error: {
        status: 422,
        fields: {
          email: ['The email has already been taken.'],
        },
      },
    })

    await expect(registerAction(new FormData())).resolves.toBe(failure)
    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('uses the native Next redirect after verified registration', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const submission = {
      valid: true,
      data: {
        name: 'Reader',
        email: 'reader@example.com',
        password: 'password123',
        passwordConfirmation: 'password123',
      },
      fail: vi.fn(),
    }
    mocks.validate.mockResolvedValue(submission)
    mocks.register.mockResolvedValue({
      data: created,
      error: null,
    })
    mocks.loginUsing.mockResolvedValue({
      emailVerificationRequired: false,
      user: created,
    })

    await expect(registerAction(new FormData())).rejects.toMatchObject({
      location: '/admin',
    })

    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/admin')
  })

  it('redirects to email verification when the new session requires it', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const submission = {
      valid: true,
      data: {
        name: 'Reader',
        email: 'reader@example.com',
        password: 'password123',
        passwordConfirmation: 'password123',
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
      emailVerificationRoute: '/verify-email',
      user: created,
    })

    await expect(registerAction(new FormData())).rejects.toMatchObject({
      location: '/verify-email',
    })

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/verify-email')
  })
})
