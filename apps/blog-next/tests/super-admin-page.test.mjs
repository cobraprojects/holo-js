import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  superAdminLogoutAction: vi.fn(),
}))

vi.mock('@holo-js/auth/next/server', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('../app/super-admin/logout/actions.ts', () => ({
  superAdminLogoutAction: mocks.superAdminLogoutAction,
}))

const { default: SuperAdminPage } = await import('../app/super-admin/page.tsx')

describe('super admin page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects unauthenticated admin guard requests to login', async () => {
    mocks.auth.mockResolvedValue({
      authenticated: false,
      user: null,
    })

    await expect(SuperAdminPage()).rejects.toMatchObject({
      location: '/super-admin/login',
    })

    expect(mocks.auth).toHaveBeenCalledWith({ guard: 'admin' })
    expect(mocks.redirect).toHaveBeenCalledWith('/super-admin/login')
  })

  it('renders the authenticated admin identity', async () => {
    mocks.auth.mockResolvedValue({
      authenticated: true,
      user: {
        email: 'admin@example.com',
        name: 'Admin User',
      },
    })

    const element = await SuperAdminPage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(JSON.stringify(renderer.toJSON())).toContain('Admin User')
    expect(JSON.stringify(renderer.toJSON())).toContain('through the admin guard.')
    expect(renderer.root.findByType('form').props.action).toBe(mocks.superAdminLogoutAction)

    await act(async () => {
      renderer.unmount()
    })
  })
})
