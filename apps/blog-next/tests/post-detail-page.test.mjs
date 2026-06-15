import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPublishedPostBySlug: vi.fn(),
  notFound: vi.fn(() => {
    const error = new Error('NEXT_NOT_FOUND')
    error.digest = 'NEXT_NOT_FOUND'
    throw error
  }),
}))

vi.mock('next/image', () => ({
  default: ({ alt, src, ...props }) => jsx('img', { ...props, alt, src }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}))

vi.mock('@/server/lib/blog', () => ({
  getPublishedPostBySlug: mocks.getPublishedPostBySlug,
}))

const { default: PostDetailPage } = await import('../app/posts/[slug]/page.tsx')

describe('post detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the published post with media, category, and tags', async () => {
    mocks.getPublishedPostBySlug.mockResolvedValue({
      id: 7,
      title: 'Typed routes',
      excerpt: 'A short summary.',
      body: 'Full post body.',
      category: {
        name: 'Framework',
        slug: 'framework',
      },
      tags: [
        {
          id: 1,
          name: 'TypeScript',
          slug: 'typescript',
        },
      ],
      getFirstMediaPath: vi.fn(async () => '/media/post-thumb.jpg'),
    })

    const element = await PostDetailPage({
      params: Promise.resolve({ slug: 'typed-routes' }),
    })

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(mocks.getPublishedPostBySlug).toHaveBeenCalledWith('typed-routes')
    expect(renderer.root.findByProps({ children: 'Typed routes' }).type).toBe('h1')
    expect(renderer.root.findByProps({ href: '/categories/framework' }).props.children).toBe('Framework')
    expect(renderer.root.findByProps({ href: '/tags/typescript' }).props.children).toEqual(['#', 'TypeScript'])
    expect(renderer.root.findByType('img').props.src).toBe('/media/post-thumb.jpg')
    expect(renderer.root.findByProps({ children: 'Full post body.' }).type).toBe('div')

    await act(async () => {
      renderer.unmount()
    })
  })

  it('returns notFound when the post is missing', async () => {
    mocks.getPublishedPostBySlug.mockResolvedValue(undefined)

    await expect(PostDetailPage({
      params: Promise.resolve({ slug: 'missing' }),
    })).rejects.toMatchObject({
      digest: 'NEXT_NOT_FOUND',
    })

    expect(mocks.notFound).toHaveBeenCalledTimes(1)
  })
})
