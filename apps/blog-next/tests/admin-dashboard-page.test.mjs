import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authorize: vi.fn(),
  getAdminDashboardData: vi.fn(),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  Post: {
    model: 'Post',
  },
}))

vi.mock('@holo-js/auth/next/server', () => ({
  auth: mocks.auth,
}))

vi.mock('@holo-js/authorization', () => ({
  authorize: mocks.authorize,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/server/models/Post', () => ({
  default: mocks.Post,
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminDashboardData: mocks.getAdminDashboardData,
}))

vi.mock('../app/admin/broadcast-feed.tsx', () => ({
  BroadcastFeed: () => jsx('div', { 'data-testid': 'broadcast-feed' }),
}))

const { default: AdminDashboardPage } = await import('../app/admin/page.tsx')

describe('admin dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAdminDashboardData.mockResolvedValue({
      postCount: 4,
      publishedCount: 3,
      categoryCount: 2,
      tagCount: 5,
    })
  })

  it('redirects before fetching dashboard data when unauthenticated', async () => {
    mocks.auth.mockResolvedValue({
      authenticated: false,
      user: null,
    })

    await expect(AdminDashboardPage()).rejects.toMatchObject({
      location: '/login',
    })

    expect(mocks.redirect).toHaveBeenCalledWith('/login')
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.getAdminDashboardData).not.toHaveBeenCalled()
  })

  it('authorizes admin access before rendering dashboard data', async () => {
    mocks.auth.mockResolvedValue({
      authenticated: true,
      user: {
        email: 'editor@example.com',
        name: 'Editor User',
      },
    })

    const element = await AdminDashboardPage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(mocks.authorize).toHaveBeenCalledWith('viewAny', mocks.Post)
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getAdminDashboardData.mock.invocationCallOrder[0],
    )
    expect(JSON.stringify(renderer.toJSON())).toContain('Editor User')
    expect(renderer.root.findByProps({ href: '/admin/posts' }).props.children).toBe('Manage posts')

    await act(async () => {
      renderer.unmount()
    })
  })
})
