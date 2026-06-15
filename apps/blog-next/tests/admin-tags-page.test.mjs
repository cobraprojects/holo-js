import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminTagsData: vi.fn(),
  createTagAction: vi.fn(),
  deleteTagAction: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminTagsData: mocks.getAdminTagsData,
}))

vi.mock('../app/admin/actions.ts', () => ({
  createTagAction: mocks.createTagAction,
  deleteTagAction: mocks.deleteTagAction,
}))

const { default: AdminTagsPage } = await import('../app/admin/tags/page.tsx')

describe('admin tags page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders tags and wires create and delete actions', async () => {
    mocks.getAdminTagsData.mockResolvedValue({
      tags: [
        { id: 7, name: 'TypeScript', slug: 'typescript' },
        { id: 9, name: 'Security', slug: 'security' },
      ],
    })

    const element = await AdminTagsPage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    const forms = renderer.root.findAllByType('form')
    expect(forms[0].props.action).toBe(mocks.createTagAction)
    expect(renderer.root.findByProps({ name: 'name' }).props.placeholder).toBe('Tag name')
    expect(renderer.root.findByProps({ children: 'TypeScript' }).type).toBe('strong')
    expect(renderer.root.findByProps({ children: 'typescript' }).type).toBe('div')
    expect(renderer.root.findByProps({ href: '/admin/tags/7/edit' }).props.children).toBe('Edit')

    await forms[1].props.action(new FormData())

    expect(mocks.deleteTagAction).toHaveBeenCalledWith(7, expect.any(FormData))

    await act(async () => {
      renderer.unmount()
    })
  })
})
