import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminPostFormData: vi.fn(),
  getAdminPostsData: vi.fn(),
  createPostAction: vi.fn(),
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminPostFormData: mocks.getAdminPostFormData,
  getAdminPostsData: mocks.getAdminPostsData,
}))

vi.mock('../app/admin/actions.ts', () => ({
  createPostAction: mocks.createPostAction,
}))

const { default: NewPostPage } = await import('../app/admin/posts/new/page.tsx')

describe('new post page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads only form option data for the create form', async () => {
    mocks.getAdminPostFormData.mockResolvedValue({
      categories: [{ id: 1, name: 'News' }],
      tags: [{ id: 2, name: 'TypeScript' }],
    })

    const element = await NewPostPage()
    const postFormElement = element.props.children[1]

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(mocks.getAdminPostFormData).toHaveBeenCalledTimes(1)
    expect(mocks.getAdminPostsData).not.toHaveBeenCalled()
    expect(postFormElement.props).toMatchObject({
      action: mocks.createPostAction,
      imagePath: undefined,
      post: undefined,
      submitLabel: 'Create post',
      data: {
        categories: [{ id: 1, name: 'News' }],
        tags: [{ id: 2, name: 'TypeScript' }],
      },
    })

    await act(async () => {
      renderer.unmount()
    })
  })
})
