import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshUser: vi.fn(),
  replace: vi.fn(),
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
}))

vi.mock('@/lib/schemas/auth', () => ({
  loginForm: {},
}))

const { default: SuperAdminLoginPage } = await import('../app/super-admin/login/page.tsx')

function createFormState(rootError) {
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
    submit: vi.fn(),
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
})
