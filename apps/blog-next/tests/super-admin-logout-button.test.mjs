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
    refreshUser: mocks.refreshUser,
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
  }),
}))

const originalFetch = globalThis.fetch
const originalConsoleWarn = console.warn

const { SuperAdminLogoutButton } = await import('../app/super-admin/logout-button.tsx')

function createDeferred() {
  let resolvePromise = () => {}
  const promise = new Promise(resolve => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve(value) {
      resolvePromise(value)
    },
  }
}

describe('super admin logout button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = mocks.fetch
    console.warn = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.warn = originalConsoleWarn
  })

  it('navigates to login after logout even when auth refresh fails', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }))
    mocks.refreshUser.mockRejectedValue(new Error('refresh failed'))

    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLogoutButton, {}))
    })

    const button = renderer.root.findByType('button')
    await act(async () => {
      await button.props.onClick()
    })

    expect(mocks.fetch).toHaveBeenCalledWith('/api/super-admin/logout', { method: 'POST' })
    expect(mocks.refreshUser).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      'Super admin auth refresh failed after logout.',
      expect.any(Error),
    )
    expect(mocks.replace).toHaveBeenCalledWith('/super-admin/login')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('ignores duplicate logout clicks while a request is in flight', async () => {
    const logoutResponse = createDeferred()
    mocks.fetch.mockReturnValue(logoutResponse.promise)

    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLogoutButton, {}))
    })

    const firstClick = renderer.root.findByType('button').props.onClick()
    await act(async () => {
      await Promise.resolve()
    })

    const loadingButton = renderer.root.findByType('button')
    expect(loadingButton.props.disabled).toBe(true)
    expect(loadingButton.props.children).toBe('Signing out...')

    await act(async () => {
      await loadingButton.props.onClick()
    })

    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    logoutResponse.resolve(new Response(null, { status: 500 }))
    await act(async () => {
      await firstClick
    })

    expect(console.warn).toHaveBeenCalledWith('Super admin logout failed.', { status: 500 })
    expect(mocks.replace).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })

  it('keeps users on the page when the logout request fails before clearing the session', async () => {
    const logoutError = new Error('network failed')
    mocks.fetch.mockRejectedValue(logoutError)

    let renderer
    await act(async () => {
      renderer = create(jsx(SuperAdminLogoutButton, {}))
    })

    await act(async () => {
      await renderer.root.findByType('button').props.onClick()
    })

    expect(console.warn).toHaveBeenCalledWith('Super admin logout failed.', logoutError)
    expect(mocks.refreshUser).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()

    await act(async () => {
      renderer.unmount()
    })
  })
})
