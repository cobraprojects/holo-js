import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminCategoryById: vi.fn(),
  notFound: vi.fn(() => {
    const error = new Error('NEXT_NOT_FOUND')
    error.digest = 'NEXT_NOT_FOUND'
    throw error
  }),
  updateCategoryAction: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminCategoryById: mocks.getAdminCategoryById,
}))

vi.mock('../app/admin/actions.ts', () => ({
  updateCategoryAction: mocks.updateCategoryAction,
}))

const { default: EditCategoryPage } = await import('../app/admin/categories/[id]/edit/page.tsx')

describe('edit category page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['0x10', '1e2', '1.5', '0', '-1'])('rejects non-canonical category id %s', async (id) => {
    await expect(EditCategoryPage({
      params: Promise.resolve({ id }),
    })).rejects.toMatchObject({
      digest: 'NEXT_NOT_FOUND',
    })

    expect(mocks.getAdminCategoryById).not.toHaveBeenCalled()
  })

  it('renders an existing category edit form', async () => {
    mocks.getAdminCategoryById.mockResolvedValue({
      id: 16,
      name: 'Framework',
      description: 'Framework notes.',
    })

    const element = await EditCategoryPage({
      params: Promise.resolve({ id: '16' }),
    })

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    const form = renderer.root.findByType('form')
    expect(mocks.getAdminCategoryById).toHaveBeenCalledWith(16)
    expect(renderer.root.findByType('input').props.defaultValue).toBe('Framework')
    expect(renderer.root.findByType('textarea').props.defaultValue).toBe('Framework notes.')

    await form.props.action(new FormData())

    expect(mocks.updateCategoryAction).toHaveBeenCalledWith(16, expect.any(FormData))

    await act(async () => {
      renderer.unmount()
    })
  })

  it('renders not found for missing categories', async () => {
    mocks.getAdminCategoryById.mockResolvedValue(null)

    await expect(EditCategoryPage({
      params: Promise.resolve({ id: '99' }),
    })).rejects.toMatchObject({
      digest: 'NEXT_NOT_FOUND',
    })

    expect(mocks.getAdminCategoryById).toHaveBeenCalledWith(99)
  })
})
