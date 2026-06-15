import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authorize: vi.fn(),
  getAdminPostById: vi.fn(),
  notFound: vi.fn(() => {
    const error = new Error('NEXT_NOT_FOUND')
    error.digest = 'NEXT_NOT_FOUND'
    throw error
  }),
  Post: {
    model: 'Post',
  },
  PostForm: vi.fn(() => jsx('form', {})),
  redirect: vi.fn((location) => {
    const error = new Error('NEXT_REDIRECT')
    error.location = location
    throw error
  }),
  updatePostAction: vi.fn(),
}))

vi.mock('@holo-js/auth/next/server', () => ({
  auth: mocks.auth,
}))

vi.mock('@holo-js/authorization', () => ({
  authorize: mocks.authorize,
}))

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}))

vi.mock('@/server/models/Post', () => ({
  default: mocks.Post,
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminPostById: mocks.getAdminPostById,
}))

vi.mock('../app/admin/posts/post-form.jsx', () => ({
  PostForm: mocks.PostForm,
}))

vi.mock('../app/admin/actions.ts', () => ({
  updatePostAction: mocks.updatePostAction,
}))

const { default: EditPostPage } = await import('../app/admin/posts/[id]/edit/page.tsx')

function createPost() {
  return {
    id: 7,
    title: 'Protected draft',
    excerpt: 'Private excerpt',
    body: 'Private body',
    status: 'draft',
    category_id: 3,
    tags: [
      {
        id: 11,
      },
    ],
    getFirstMediaPath: vi.fn(async () => '/media/post.jpg'),
  }
}

function createPageData(post = createPost()) {
  return {
    post,
    categories: [
      {
        id: 3,
        name: 'Engineering',
      },
    ],
    tags: [
      {
        id: 11,
        name: 'TypeScript',
      },
    ],
  }
}

describe('edit post page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({
      authenticated: true,
      user: {
        email: 'editor@example.com',
      },
    })
  })

  it('authorizes the loaded post before rendering the edit form', async () => {
    const post = createPost()
    mocks.getAdminPostById.mockResolvedValue(createPageData(post))

    const element = await EditPostPage({
      params: Promise.resolve({ id: '7' }),
    })

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(mocks.authorize).toHaveBeenCalledWith('viewAny', mocks.Post)
    expect(mocks.authorize).toHaveBeenCalledWith('update', post)
    expect(mocks.authorize.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.PostForm.mock.invocationCallOrder[0],
    )
    expect(mocks.PostForm.mock.calls[0]?.[0]).toMatchObject({
      imagePath: '/media/post.jpg',
      post: {
        id: 7,
        title: 'Protected draft',
        body: 'Private body',
      },
    })

    await act(async () => {
      renderer.unmount()
    })
  })

  it('does not render post data when record authorization fails', async () => {
    const post = createPost()
    const authorizationError = new Error('Only the author can update posts.')
    mocks.getAdminPostById.mockResolvedValue(createPageData(post))
    mocks.authorize.mockImplementation(async (ability) => {
      if (ability === 'update') {
        throw authorizationError
      }
    })

    await expect(EditPostPage({
      params: Promise.resolve({ id: '7' }),
    })).rejects.toBe(authorizationError)

    expect(mocks.PostForm).not.toHaveBeenCalled()
    expect(post.getFirstMediaPath).not.toHaveBeenCalled()
  })
})
