import assert from 'node:assert/strict'
import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
  useForm: vi.fn(),
}))

vi.mock('@holo-js/adapter-next/client', () => ({
  useForm: mocks.useForm,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
  }),
  useSearchParams: () => mocks.searchParams,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/lib/schemas/auth', () => ({
  resetPasswordForm: {},
}))

const originalFetch = globalThis.fetch

const { default: ResetPasswordPage } = await import('../app/reset-password/page.tsx')

function createFormState(submit = vi.fn(), overrides = {}) {
  return {
    values: {
      token: mocks.searchParams.get('token') ?? '',
      password: '',
      passwordConfirmation: '',
    },
    fields: {
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
    ...overrides,
  }
}

async function renderPageWithFormState(formState) {
  mocks.useForm.mockReturnValue(formState)

  let renderer
  await act(async () => {
    renderer = create(jsx(ResetPasswordPage, {}))
  })

  assert.ok(renderer, 'Expected reset-password page to render.')
  return renderer
}

async function renderPageWithRedirect(redirectTo) {
  mocks.searchParams = new URLSearchParams('token=reset-token')
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    data: {
      redirectTo,
    },
  })))
  mocks.useForm.mockImplementation((_schema, options) => createFormState(vi.fn(async () => {
    const formData = new FormData()
    formData.set('token', 'reset-token')
    formData.set('password', 'password123')
    formData.set('passwordConfirmation', 'password123')

    return options.submitter({ formData })
  })))

  let renderer
  await act(async () => {
    renderer = create(jsx(ResetPasswordPage, {}))
  })

  assert.ok(renderer, 'Expected reset-password page to render.')
  return renderer
}

describe('reset password page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.searchParams = new URLSearchParams()
    globalThis.fetch = mocks.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('navigates to same-app redirect targets after a successful password reset', async () => {
    const renderer = await renderPageWithRedirect('/login')

    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/reset-password', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(mocks.useForm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      initialValues: {
        token: 'reset-token',
        password: '',
        passwordConfirmation: '',
      },
    }))
    expect(mocks.replace).toHaveBeenCalledWith('/login')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('shows the missing token message when no token is present', async () => {
    const renderer = await renderPageWithFormState(createFormState())

    expect(mocks.useForm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      initialValues: {
        token: '',
        password: '',
        passwordConfirmation: '',
      },
    }))
    expect(renderer.root.findByProps({
      children: 'A reset token is required to complete this form.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('wires password field input and blur handlers', async () => {
    mocks.searchParams = new URLSearchParams('token=reset-token')

    const passwordOnInput = vi.fn()
    const passwordOnBlur = vi.fn()
    const confirmationOnInput = vi.fn()
    const confirmationOnBlur = vi.fn()
    const renderer = await renderPageWithFormState(createFormState(vi.fn(), {
      fields: {
        password: {
          onInput: passwordOnInput,
          onBlur: passwordOnBlur,
        },
        passwordConfirmation: {
          onInput: confirmationOnInput,
          onBlur: confirmationOnBlur,
        },
      },
    }))

    const inputs = renderer.root.findAllByType('input')
    const passwordInput = inputs.find(input => input.props.name === 'password')
    const confirmationInput = inputs.find(input => input.props.name === 'passwordConfirmation')

    assert.ok(passwordInput, 'Expected password input to render.')
    assert.ok(confirmationInput, 'Expected password confirmation input to render.')

    passwordInput.props.onInput({ currentTarget: { value: 'password123' } })
    passwordInput.props.onBlur()
    confirmationInput.props.onInput({ currentTarget: { value: 'password123' } })
    confirmationInput.props.onBlur()

    expect(passwordOnInput).toHaveBeenCalledWith('password123')
    expect(passwordOnBlur).toHaveBeenCalledTimes(1)
    expect(confirmationOnInput).toHaveBeenCalledWith('password123')
    expect(confirmationOnBlur).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer.unmount()
    })
  })

  it('reflects submitting, validation error, and success states', async () => {
    mocks.searchParams = new URLSearchParams('token=reset-token')
    const errors = {
      password: 'Password is too short.',
      passwordConfirmation: 'Passwords do not match.',
      token: 'This reset link has expired.',
    }
    const renderer = await renderPageWithFormState(createFormState(vi.fn(), {
      errors: {
        has: vi.fn(field => Object.hasOwn(errors, field)),
        first: vi.fn(field => errors[field]),
      },
      submitting: true,
      lastSubmission: {
        ok: true,
      },
    }))

    expect(renderer.root.findByType('button').props.children).toBe('Resetting password...')
    expect(renderer.root.findByProps({
      children: 'Password is too short.',
    }).type).toBe('span')
    expect(renderer.root.findByProps({
      children: 'Passwords do not match.',
    }).type).toBe('span')
    expect(renderer.root.findByProps({
      children: 'This reset link has expired.',
    }).type).toBe('span')
    expect(renderer.root.findByProps({
      children: 'Your password has been reset successfully.',
    }).type).toBe('p')
    expect(renderer.root.findByProps({
      children: 'Sign in',
    }).props.href).toBe('/login')

    await act(async () => {
      renderer.unmount()
    })
  })
})
