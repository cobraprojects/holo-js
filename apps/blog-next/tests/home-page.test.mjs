import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getHomePageData: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/server/lib/blog', () => ({
  getHomePageData: mocks.getHomePageData,
}))

const { default: HomePage } = await import('../app/page.tsx')

function createHomeData(featured) {
  return {
    featured,
    posts: [
      {
        id: 1,
        title: 'Typed routes',
        slug: 'typed-routes',
        excerpt: 'Typed route excerpt.',
        category: {
          name: 'Framework',
          slug: 'framework',
        },
        tags: [
          {
            id: 10,
            name: 'TypeScript',
            slug: 'typescript',
          },
        ],
      },
    ],
    categories: [
      {
        id: 2,
        name: 'Engineering',
        slug: 'engineering',
      },
    ],
    tags: [
      {
        id: 3,
        name: 'Release',
        slug: 'release',
      },
    ],
  }
}

describe('home page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders featured content, latest posts, categories, and tags', async () => {
    mocks.getHomePageData.mockResolvedValue(createHomeData({
      title: 'Featured post',
      slug: 'featured-post',
      excerpt: 'Featured excerpt.',
    }))

    const element = await HomePage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(renderer.root.findByProps({ href: '/posts/featured-post' }).props.children).toBe('Featured post')
    expect(renderer.root.findByProps({ href: '/posts/typed-routes' }).props.children).toBe('Typed routes')
    expect(renderer.root.findByProps({ href: '/categories/framework' }).props.children).toBe('Framework')
    expect(renderer.root.findByProps({ href: '/categories/engineering' }).props.children).toBe('Engineering')
    expect(renderer.root.findByProps({ href: '/tags/typescript' }).props.children).toEqual(['#', 'TypeScript'])
    expect(renderer.root.findByProps({ href: '/tags/release' }).props.children).toEqual(['#', 'Release'])

    await act(async () => {
      renderer.unmount()
    })
  })

  it('omits the featured section when there is no featured post', async () => {
    mocks.getHomePageData.mockResolvedValue(createHomeData(null))

    const element = await HomePage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(() => renderer.root.findByProps({ children: 'Featured story' })).toThrow()
    expect(renderer.root.findByProps({ href: '/posts/typed-routes' }).props.children).toBe('Typed routes')

    await act(async () => {
      renderer.unmount()
    })
  })
})
