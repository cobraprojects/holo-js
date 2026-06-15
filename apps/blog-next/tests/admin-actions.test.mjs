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
  authorize: vi.fn(),
  Category: {
    model: 'Category',
    findOrFail: vi.fn(),
  },
  Post: {
    model: 'Post',
    findOrFail: vi.fn(),
  },
  Tag: {
    model: 'Tag',
    findOrFail: vi.fn(),
  },
  categoryRecord: { id: 1, name: 'Protected category' },
  postRecord: { id: 1, title: 'Protected post' },
  tagRecord: { id: 1, name: 'Protected tag' },
}))

vi.mock('@holo-js/auth/next/server', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@holo-js/authorization', () => ({
  authorize: mocks.authorize,
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

vi.mock('@/server/models/Category', () => ({
  default: mocks.Category,
}))

vi.mock('@/server/models/Post', () => ({
  default: mocks.Post,
}))

vi.mock('@/server/models/Tag', () => ({
  default: mocks.Tag,
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
    expectedAuth: ['create', mocks.Post],
    mutate: mocks.createPost,
    run: () => actions.createPostAction(createPostFormData()),
    redirectTo: '/admin/posts',
  },
  {
    name: 'updatePostAction',
    expectedAuth: ['update', mocks.postRecord],
    mutate: mocks.updatePost,
    run: () => actions.updatePostAction(1, createPostFormData()),
    redirectTo: '/admin/posts',
  },
  {
    name: 'deletePostAction',
    expectedAuth: ['delete', mocks.postRecord],
    mutate: mocks.deletePost,
    run: () => actions.deletePostAction(1),
    redirectTo: '/admin/posts',
  },
  {
    name: 'createCategoryAction',
    expectedAuth: ['manage', mocks.Category],
    mutate: mocks.createCategory,
    run: () => actions.createCategoryAction(createCategoryFormData()),
    redirectTo: '/admin/categories',
  },
  {
    name: 'updateCategoryAction',
    expectedAuth: ['update', mocks.categoryRecord],
    mutate: mocks.updateCategory,
    run: () => actions.updateCategoryAction(1, createCategoryFormData()),
    redirectTo: '/admin/categories',
  },
  {
    name: 'deleteCategoryAction',
    expectedAuth: ['delete', mocks.categoryRecord],
    mutate: mocks.deleteCategory,
    run: () => actions.deleteCategoryAction(1),
    redirectTo: '/admin/categories',
  },
  {
    name: 'createTagAction',
    expectedAuth: ['manage', mocks.Tag],
    mutate: mocks.createTag,
    run: () => actions.createTagAction(createTagFormData()),
    redirectTo: '/admin/tags',
  },
  {
    name: 'updateTagAction',
    expectedAuth: ['update', mocks.tagRecord],
    mutate: mocks.updateTag,
    run: () => actions.updateTagAction(1, createTagFormData()),
    redirectTo: '/admin/tags',
  },
  {
    name: 'deleteTagAction',
    expectedAuth: ['delete', mocks.tagRecord],
    mutate: mocks.deleteTag,
    run: () => actions.deleteTagAction(1),
    redirectTo: '/admin/tags',
  },
]

describe('admin actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.Category.findOrFail.mockResolvedValue(mocks.categoryRecord)
    mocks.Post.findOrFail.mockResolvedValue(mocks.postRecord)
    mocks.Tag.findOrFail.mockResolvedValue(mocks.tagRecord)
  })

  it.each(cases)('redirects unauthenticated $name before mutating', async ({ mutate, run }) => {
    mocks.auth.mockResolvedValue({ authenticated: false })

    await expect(run()).rejects.toThrow('NEXT_REDIRECT:/login')

    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).toHaveBeenCalledWith('/login')
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each(cases)('runs authenticated $name before redirecting', async ({ expectedAuth, mutate, run, redirectTo }) => {
    mocks.auth.mockResolvedValue({ authenticated: true, user: { id: 1, email: 'editor@example.com' } })
    mutate.mockResolvedValue(undefined)

    await expect(run()).rejects.toThrow(`NEXT_REDIRECT:${redirectTo}`)

    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mocks.authorize).toHaveBeenCalledWith(...expectedAuth)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0])
    expect(mocks.redirect).toHaveBeenCalledWith(redirectTo)
  })

  it('returns post validation failures before creating and updating', async () => {
    mocks.auth.mockResolvedValue({ authenticated: true, user: { id: 1, email: 'editor@example.com' } })
    mocks.createPost.mockResolvedValue(undefined)
    mocks.updatePost.mockResolvedValue(undefined)

    await expect(actions.createPostAction(new FormData())).resolves.toMatchObject({
      ok: false,
      status: 422,
      errors: {
        title: ['Title is required.'],
      },
    })
    await expect(actions.updatePostAction(1, new FormData())).resolves.toMatchObject({
      ok: false,
      status: 422,
      errors: {
        title: ['Title is required.'],
      },
    })

    expect(mocks.createPost).not.toHaveBeenCalled()
    expect(mocks.updatePost).not.toHaveBeenCalled()
  })

  it('lets post image validation failures bubble without redirecting', async () => {
    mocks.auth.mockResolvedValue({ authenticated: true, user: { id: 1, email: 'editor@example.com' } })
    mocks.createPost.mockRejectedValue(new Error('The selected file must be 2 MB or smaller.'))

    await expect(actions.createPostAction(createPostFormData())).rejects.toThrow('The selected file must be 2 MB or smaller.')
    expect(mocks.redirect).not.toHaveBeenCalledWith('/admin/posts')
  })

  it('normalizes empty category and tag form fields before mutating', async () => {
    mocks.auth.mockResolvedValue({ authenticated: true, user: { id: 1, email: 'editor@example.com' } })
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
