import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
  createPost: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
}))

vi.mock('@holo-js/auth/next/server', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/server/lib/blog', () => ({
  createPost: mocks.createPost,
  updatePost: mocks.updatePost,
  deletePost: mocks.deletePost,
  createCategory: mocks.createCategory,
  updateCategory: mocks.updateCategory,
  deleteCategory: mocks.deleteCategory,
  createTag: mocks.createTag,
  updateTag: mocks.updateTag,
  deleteTag: mocks.deleteTag,
}))

const actions = await import('../app/admin/actions.ts')

function createPostFormData() {
  const formData = new FormData()
  formData.set('title', 'Protected post')
  formData.set('excerpt', 'Protected excerpt')
  formData.set('body', 'Protected body')
  formData.set('status', 'published')
  formData.set('categoryId', '1')
  formData.append('tagIds', '2')
  return formData
}

function createCategoryFormData() {
  const formData = new FormData()
  formData.set('name', 'Protected category')
  formData.set('description', 'Protected description')
  return formData
}

function createTagFormData() {
  const formData = new FormData()
  formData.set('name', 'Protected tag')
  return formData
}

const cases = [
  {
    name: 'createPostAction',
    mutate: mocks.createPost,
    run: () => actions.createPostAction(createPostFormData()),
    redirectTo: '/admin/posts',
  },
  {
    name: 'updatePostAction',
    mutate: mocks.updatePost,
    run: () => actions.updatePostAction(1, createPostFormData()),
    redirectTo: '/admin/posts',
  },
  {
    name: 'deletePostAction',
    mutate: mocks.deletePost,
    run: () => actions.deletePostAction(1),
    redirectTo: '/admin/posts',
  },
  {
    name: 'createCategoryAction',
    mutate: mocks.createCategory,
    run: () => actions.createCategoryAction(createCategoryFormData()),
    redirectTo: '/admin/categories',
  },
  {
    name: 'updateCategoryAction',
    mutate: mocks.updateCategory,
    run: () => actions.updateCategoryAction(1, createCategoryFormData()),
    redirectTo: '/admin/categories',
  },
  {
    name: 'deleteCategoryAction',
    mutate: mocks.deleteCategory,
    run: () => actions.deleteCategoryAction(1),
    redirectTo: '/admin/categories',
  },
  {
    name: 'createTagAction',
    mutate: mocks.createTag,
    run: () => actions.createTagAction(createTagFormData()),
    redirectTo: '/admin/tags',
  },
  {
    name: 'updateTagAction',
    mutate: mocks.updateTag,
    run: () => actions.updateTagAction(1, createTagFormData()),
    redirectTo: '/admin/tags',
  },
  {
    name: 'deleteTagAction',
    mutate: mocks.deleteTag,
    run: () => actions.deleteTagAction(1),
    redirectTo: '/admin/tags',
  },
]

describe('admin actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(cases)('redirects unauthenticated $name before mutating', async ({ mutate, run }) => {
    mocks.auth.mockResolvedValue({ authenticated: false })

    await expect(run()).rejects.toThrow('NEXT_REDIRECT:/login')

    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).toHaveBeenCalledWith('/login')
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each(cases)('runs authenticated $name before redirecting', async ({ mutate, run, redirectTo }) => {
    mocks.auth.mockResolvedValue({ authenticated: true })
    mutate.mockResolvedValue(undefined)

    await expect(run()).rejects.toThrow(`NEXT_REDIRECT:${redirectTo}`)

    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).toHaveBeenCalledWith(redirectTo)
  })

  it('normalizes empty post form fields before creating and updating', async () => {
    mocks.auth.mockResolvedValue({ authenticated: true })
    mocks.createPost.mockResolvedValue(undefined)
    mocks.updatePost.mockResolvedValue(undefined)

    await expect(actions.createPostAction(new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/posts')
    await expect(actions.updatePostAction(1, new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/posts')

    const expectedPostInput = {
      title: '',
      excerpt: '',
      body: '',
      status: 'published',
      categoryId: '',
      tagIds: '',
    }
    expect(mocks.createPost).toHaveBeenCalledWith(expectedPostInput)
    expect(mocks.updatePost).toHaveBeenCalledWith(1, expectedPostInput)
  })

  it('normalizes empty category and tag form fields before mutating', async () => {
    mocks.auth.mockResolvedValue({ authenticated: true })
    mocks.createCategory.mockResolvedValue(undefined)
    mocks.updateCategory.mockResolvedValue(undefined)
    mocks.createTag.mockResolvedValue(undefined)
    mocks.updateTag.mockResolvedValue(undefined)

    await expect(actions.createCategoryAction(new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/categories')
    await expect(actions.updateCategoryAction(1, new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/categories')
    await expect(actions.createTagAction(new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/tags')
    await expect(actions.updateTagAction(1, new FormData())).rejects.toThrow('NEXT_REDIRECT:/admin/tags')

    const expectedCategoryInput = {
      name: '',
      description: '',
    }
    expect(mocks.createCategory).toHaveBeenCalledWith(expectedCategoryInput)
    expect(mocks.updateCategory).toHaveBeenCalledWith(1, expectedCategoryInput)
    expect(mocks.createTag).toHaveBeenCalledWith({ name: '' })
    expect(mocks.updateTag).toHaveBeenCalledWith(1, { name: '' })
  })
})
