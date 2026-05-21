import assert from 'node:assert/strict'
import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  refreshUser: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
  useForm: vi.fn(),
}))

vi.mock('@holo-js/adapter-next/client', () => ({
  useForm: mocks.useForm,
}))

vi.mock('@holo-js/auth/next/client', () => ({
  useAuth: () => ({
    refreshUser: mocks.refreshUser,
  }),
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
  verifyEmailForm: {},
}))

const originalFetch = globalThis.fetch
const originalConsoleError = console.error

const { default: VerifyEmailPage } = await import('../app/verify-email/page.tsx')

function createFormState(overrides = {}) {
  return {
    values: {
      token: mocks.searchParams.get('token') ?? '',
    },
    errors: {
      has: vi.fn(() => false),
      first: vi.fn(),
    },
    submitting: false,
    submit: vi.fn(),
    lastSubmission: null,
    ...overrides,
  }
}

async function renderPage() {
  let renderer

  await act(async () => {
    renderer = create(jsx(VerifyEmailPage, {}))
  })

  assert.ok(renderer, 'Expected verify-email page to render.')
  return renderer
}

describe('verify email page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.searchParams = new URLSearchParams()
    globalThis.fetch = mocks.fetch
    console.error = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
  })

  it('submits the token, refreshes auth state, and redirects after verification succeeds', async () => {
    mocks.searchParams = new URLSearchParams('token=verify-token')
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        redirectTo: '/login',
      },
    })))
    mocks.useForm.mockImplementation((_schema, options) => createFormState({
      submit: vi.fn(async () => {
        const formData = new FormData()
        formData.set('token', 'verify-token')
        return options.submitter({ formData })
      }),
    }))

    const renderer = await renderPage()

    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.useForm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      initialValues: {
        token: 'verify-token',
      },
    }))
    expect(mocks.fetch).toHaveBeenCalledWith('/api/verify-email', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(mocks.fetch.mock.calls[0][1].body.get('token')).toBe('verify-token')
    expect(mocks.refreshUser).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith('/login')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('does not refresh or redirect when token verification is rejected', async () => {
    mocks.searchParams = new URLSearchParams('token=bad-token')
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      errors: {
        token: ['This verification link is invalid.'],
      },
    })))
    mocks.useForm.mockImplementation((_schema, options) => createFormState({
      submit: vi.fn(async () => {
        const formData = new FormData()
        formData.set('token', 'bad-token')
        return options.submitter({ formData })
      }),
    }))

    const renderer = await renderPage()

    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({
        preventDefault: vi.fn(),
      })
    })

    expect(mocks.refreshUser).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })

  it('reflects submitting and successful verification form states', async () => {
    mocks.searchParams = new URLSearchParams('token=verify-token')
    mocks.useForm.mockReturnValue(createFormState({
      submitting: true,
      lastSubmission: {
        ok: true,
      },
    }))

    const renderer = await renderPage()

    expect(renderer.root.findByType('button').props.children).toBe('Verifying...')
    expect(renderer.root.findByProps({
      children: 'Your email address has been verified.',
    }).type).toBe('p')
    expect(renderer.root.findByProps({
      children: 'Sign in',
    }).props.href).toBe('/login')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('displays token submission errors from the form API', async () => {
    mocks.searchParams = new URLSearchParams('token=expired-token')
    mocks.useForm.mockReturnValue(createFormState({
      errors: {
        has: vi.fn(field => field === 'token'),
        first: vi.fn(field => field === 'token' ? 'This verification link has expired.' : undefined),
      },
      lastSubmission: {
        ok: false,
      },
    }))

    const renderer = await renderPage()

    const error = renderer.root.findByProps({
      children: 'This verification link has expired.',
    })

    expect(error.type).toBe('span')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('shows the resend success message returned by the API', async () => {
    mocks.searchParams = new URLSearchParams('email=reader%40example.com')
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        message: 'Verification email sent.',
      },
    })))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/verify-email/resend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'reader@example.com',
      }),
    })
    expect(renderer.root.findByProps({
      children: 'Verification email sent.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('uses the default resend success message when the API omits one', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {},
    })))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(renderer.root.findByProps({
      children: 'A fresh verification email has been sent.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('shows resend failure messages returned by the API', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      errors: {
        _root: ['Please wait before requesting another email.'],
      },
    })))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/verify-email/resend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    expect(renderer.root.findByProps({
      children: 'Please wait before requesting another email.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('falls back when resend failure payloads do not include a string message', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      errors: {
        _root: [503],
      },
    })))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(renderer.root.findByProps({
      children: 'Could not send another verification email.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('falls back when resend failure payloads omit root errors', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      errors: {},
    })))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(renderer.root.findByProps({
      children: 'Could not send another verification email.',
    }).type).toBe('p')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('falls back when resend returns an invalid response payload', async () => {
    mocks.fetch.mockResolvedValue(new Response('not json'))
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(renderer.root.findByProps({
      children: 'Could not send another verification email.',
    }).type).toBe('p')
    expect(console.error).toHaveBeenCalledWith(
      'Failed to resend verification email.',
      expect.any(SyntaxError),
    )

    await act(async () => {
      renderer.unmount()
    })
  })

  it('falls back when resend fails before receiving a response', async () => {
    const networkError = new Error('network unavailable')
    mocks.fetch.mockRejectedValue(networkError)
    mocks.useForm.mockReturnValue(createFormState())

    const renderer = await renderPage()

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(renderer.root.findByProps({
      children: 'Could not send another verification email.',
    }).type).toBe('p')
    expect(console.error).toHaveBeenCalledWith('Failed to resend verification email.', networkError)

    await act(async () => {
      renderer.unmount()
    })
  })
})
