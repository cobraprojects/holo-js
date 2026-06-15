import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminTagById: vi.fn(),
  notFound: vi.fn(() => {
    const error = new Error('NEXT_NOT_FOUND')
    error.digest = 'NEXT_NOT_FOUND'
    throw error
  }),
  updateTagAction: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminTagById: mocks.getAdminTagById,
}))

vi.mock('../app/admin/actions.ts', () => ({
  updateTagAction: mocks.updateTagAction,
}))

const { default: EditTagPage } = await import('../app/admin/tags/[id]/edit/page.tsx')

describe('edit tag page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['0x10', '1e2', '1.5', '0', '-1'])('rejects non-canonical tag id %s', async (id) => {
    await expect(EditTagPage({
      params: Promise.resolve({ id }),
    })).rejects.toMatchObject({
      digest: 'NEXT_NOT_FOUND',
    })

    expect(mocks.getAdminTagById).not.toHaveBeenCalled()
  })

  it('loads canonical decimal tag ids', async () => {
    mocks.getAdminTagById.mockResolvedValue({
      id: 16,
      name: 'Framework',
    })

    const element = await EditTagPage({
      params: Promise.resolve({ id: '16' }),
    })

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    expect(mocks.getAdminTagById).toHaveBeenCalledWith(16)
    expect(renderer.root.findByType('input').props.defaultValue).toBe('Framework')

    await act(async () => {
      renderer.unmount()
    })
  })
})
