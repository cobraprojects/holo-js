import assert from 'node:assert/strict'
import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loginUsing: vi.fn(),
  fetch: vi.fn(),
  register: vi.fn(),
  registerForm: Symbol('registerForm'),
  replace: vi.fn(),
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
  }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/lib/schemas/auth', () => ({
  registerForm: mocks.registerForm,
}))

const originalFetch = globalThis.fetch

const { default: RegisterPage } = await import('../app/register/page.tsx')
const registerRoute = await import('../app/api/register/route.ts')

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

async function renderPageWithRedirect(redirectTo = '/login') {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    data: {
      redirectTo,
    },
  })))
  mocks.useForm.mockImplementation((_schema, options) => createFormState(vi.fn(async () => {
    const formData = new FormData()
    formData.set('name', 'Reader')
    formData.set('email', 'reader@example.com')
    formData.set('password', 'password123')
    formData.set('passwordConfirmation', 'password123')

    return options.submitter({ formData })
  })))

  let renderer
  await act(async () => {
    renderer = create(jsx(RegisterPage, {}))
  })

  assert.ok(renderer, 'Expected register page to render.')
  return renderer
}

describe('register page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = mocks.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('navigates to same-app redirect targets after successful registration', async () => {
    const renderer = await renderPageWithRedirect('/login')

    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/register', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(mocks.useForm).toHaveBeenCalledWith(mocks.registerForm, expect.objectContaining({
      csrf: true,
    }))
    expect(mocks.replace).toHaveBeenCalledWith('/login')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('ignores response-provided register redirect targets', async () => {
    const renderer = await renderPageWithRedirect('https://evil.test/login')

    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.replace).toHaveBeenCalledWith('/login')

    await act(async () => {
      renderer.unmount()
    })
  })

})

describe('POST /api/register', () => {
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
    const request = new Request('http://localhost/api/register', {
      method: 'POST',
    })

    mocks.validate.mockResolvedValue(submission)

    const response = await registerRoute.POST(request)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual(failure)
    expect(mocks.validate).toHaveBeenCalledWith(request, mocks.registerForm, {
      csrf: true,
      throttle: 'register',
    })
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.loginUsing).not.toHaveBeenCalled()
  })

  it('keeps the verified registration success redirect unchanged', async () => {
    const created = {
      id: 7,
      email: 'reader@example.com',
    }
    const session = {
      emailVerificationRequired: false,
      user: created,
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
      success: vi.fn((data, status) => ({
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
    mocks.loginUsing.mockResolvedValue(session)

    const response = await registerRoute.POST(new Request('http://localhost/api/register', {
      method: 'POST',
    }))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 201,
      data: {
        message: 'Account created and signed in successfully.',
        redirectTo: '/admin',
        user: created,
      },
    })
    expect(mocks.register).toHaveBeenCalledWith(submission.data)
    expect(mocks.loginUsing).toHaveBeenCalledWith(created)
  })
})
