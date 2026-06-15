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

function createFormState(submit, rootError) {
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
      first: vi.fn(field => field === '_root' ? rootError : undefined),
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
    const submit = vi.fn()
    mocks.useForm.mockImplementation(() => createFormState(submit))

    let renderer
    await act(async () => {
      renderer = create(jsx(RegisterPage, {}))
    })

    assert.ok(renderer, 'Expected register page to render.')

    const event = { preventDefault: vi.fn() }
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit(event)
    })

    expect(mocks.useForm).toHaveBeenCalledWith(mocks.registerForm, expect.objectContaining({
      validateOn: 'blur',
      submitter: expect.any(Function),
    }))
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })

  it('renders root submission errors above the fields', async () => {
    mocks.useForm.mockImplementation(() => createFormState(vi.fn(), 'Registration is unavailable.'))

    let renderer
    await act(async () => {
      renderer = create(jsx(RegisterPage, {}))
    })

    expect(renderer.root.findByProps({
      children: 'Registration is unavailable.',
    }).type).toBe('p')

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
    const validationError = new Error('Validation failed.')

    mocks.validate.mockRejectedValue(validationError)

    await expect(registerAction(new FormData())).rejects.toBe(validationError)
    expect(mocks.validate).toHaveBeenCalledWith(expect.any(FormData), mocks.registerForm, {
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.loginUsing).not.toHaveBeenCalled()
  })

  it('returns registration failures without starting a session', async () => {
    const input = {
      name: 'Reader',
      email: 'reader@example.com',
      password: 'password123',
      passwordConfirmation: 'password123',
    }
    const registrationError = new Error('The email has already been taken.')
    mocks.validate.mockResolvedValue(input)
    mocks.register.mockImplementation(async () => {
      throw registrationError
    })

    await expect(registerAction(new FormData())).rejects.toBe(registrationError)
    expect(mocks.register).toHaveBeenCalledWith(input)
    expect(mocks.loginUsing).not.toHaveBeenCalled()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('uses the native Next redirect after verified registration', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const input = {
      name: 'Reader',
      email: 'reader@example.com',
      password: 'password123',
      passwordConfirmation: 'password123',
    }
    mocks.validate.mockResolvedValue(input)
    mocks.register.mockResolvedValue(created)
    mocks.loginUsing.mockResolvedValue({
      emailVerificationRequired: false,
      user: created,
    })

    await expect(registerAction(new FormData())).rejects.toMatchObject({
      location: '/admin',
    })

    expect(mocks.register).toHaveBeenCalledWith(input)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/admin')
  })

  it('redirects to email verification when the new session requires it', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const input = {
      name: 'Reader',
      email: 'reader@example.com',
      password: 'password123',
      passwordConfirmation: 'password123',
    }
    mocks.validate.mockResolvedValue(input)
    mocks.register.mockResolvedValue(created)
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
