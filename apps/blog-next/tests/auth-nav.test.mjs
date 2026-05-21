import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  refreshUser: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('@holo-js/auth/next/client', () => ({
  useAuth: () => ({
    authenticated: true,
    provider: 'local',
    refreshUser: mocks.refreshUser,
    user: {
      email: 'reader@example.com',
      name: 'Reader',
    },
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
  }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

const originalFetch = globalThis.fetch
const originalConsoleWarn = console.warn

const { AuthNav } = await import('../app/auth-nav.tsx')

describe('auth nav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = mocks.fetch
    console.warn = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.warn = originalConsoleWarn
  })

  it('navigates home after logout even when auth refresh fails', async () => {
    const refreshError = new Error('refresh failed')
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }))
    mocks.refreshUser.mockRejectedValue(refreshError)

    let renderer
    await act(async () => {
      renderer = create(jsx(AuthNav, {}))
    })

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/logout', { method: 'POST' })
    expect(mocks.refreshUser).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('Auth refresh failed after logout.', refreshError)
    expect(mocks.replace).toHaveBeenCalledWith('/')

    await act(async () => {
      renderer.unmount()
    })
  })
})
