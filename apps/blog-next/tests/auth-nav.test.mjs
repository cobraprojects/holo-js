import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logoutAction: vi.fn(),
}))

vi.mock('@holo-js/auth/next/client', () => ({
  useAuth: () => ({
    authenticated: true,
    provider: 'local',
    user: {
      email: 'reader@example.com',
      name: 'Reader',
    },
  }),
}))

vi.mock('../app/logout/actions.ts', () => ({
  logoutAction: mocks.logoutAction,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

const { AuthNav } = await import('../app/auth-nav.tsx')

describe('auth nav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders logout as a native server action form', async () => {
    let renderer
    await act(async () => {
      renderer = create(jsx(AuthNav, {}))
    })

    const form = renderer.root.findByType('form')
    const button = renderer.root.findByType('button')

    expect(form.props.action).toBe(mocks.logoutAction)
    expect(button.props.type).toBe('submit')
    expect(button.props.children).toBe('Logout')

    await act(async () => {
      renderer.unmount()
    })
  })
})
