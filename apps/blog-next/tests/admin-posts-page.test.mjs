import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminPostsData: vi.fn(),
  deletePostAction: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminPostsData: mocks.getAdminPostsData,
}))

vi.mock('../app/admin/actions.ts', () => ({
  deletePostAction: mocks.deletePostAction,
}))

const { default: AdminPostsPage } = await import('../app/admin/posts/page.tsx')

describe('admin posts page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders post metadata and wires navigation and delete actions', async () => {
    mocks.getAdminPostsData.mockResolvedValue({
      posts: [
        {
          id: 3,
          title: 'Published post',
          status: 'published',
          category: { name: 'News' },
        },
        {
          id: 4,
          title: 'Draft post',
          status: 'draft',
          category: null,
        },
      ],
    })

    const element = await AdminPostsPage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(renderer.root.findByProps({ href: '/admin/posts/realtime' }).props.children).toBe('Realtime demo')
    expect(renderer.root.findByProps({ href: '/admin/posts/new' }).props.children).toBe('New post')
    expect(renderer.root.findByProps({ children: 'Published post' }).type).toBe('h2')
    expect(JSON.stringify(renderer.toJSON())).toContain('published')
    expect(JSON.stringify(renderer.toJSON())).toContain('News')
    expect(JSON.stringify(renderer.toJSON())).toContain('draft')
    expect(JSON.stringify(renderer.toJSON())).toContain('Uncategorized')
    expect(renderer.root.findByProps({ href: '/admin/posts/3/edit' }).props.children).toBe('Edit')

    const forms = renderer.root.findAllByType('form')
    await forms[0].props.action(new FormData())

    expect(mocks.deletePostAction).toHaveBeenCalledWith(3, expect.any(FormData))

    await act(async () => {
      renderer.unmount()
    })
  })
})
