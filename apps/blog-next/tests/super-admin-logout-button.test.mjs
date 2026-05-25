import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guardLogout: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  revalidatePath: vi.fn(),
  superAdminLogoutAction: vi.fn(),
}))

vi.mock('@holo-js/auth', () => ({
  default: {
    guard: vi.fn(() => ({
      logout: mocks.guardLogout,
    })),
  },
}))

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('../app/super-admin/logout/actions.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  superAdminLogoutAction: mocks.superAdminLogoutAction,
}))

const { SuperAdminLogoutButton } = await import('../app/super-admin/logout-button.tsx')
vi.doUnmock('../app/super-admin/logout/actions.ts')
const { superAdminLogoutAction } = await import('../app/super-admin/logout/actions.ts?actual')

describe('super admin logout button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders logout as a native server action form', async () => {
    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLogoutButton, {}))
    })

    const form = renderer.root.findByType('form')
    const button = renderer.root.findByType('button')

    expect(form.props.action).toBe(mocks.superAdminLogoutAction)
    expect(button.props.type).toBe('submit')
    expect(button.props.children).toBe('Sign out of super admin')

    await act(async () => {
      renderer.unmount()
    })
  })
})

describe('superAdminLogoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs out the admin guard and redirects to super admin login', async () => {
    mocks.guardLogout.mockResolvedValue({
      authenticated: false,
    })

    await expect(superAdminLogoutAction()).rejects.toMatchObject({
      location: '/super-admin/login',
    })

    expect(mocks.guardLogout).toHaveBeenCalledTimes(1)
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout')
    expect(mocks.redirect).toHaveBeenCalledWith('/super-admin/login')
  })
})
