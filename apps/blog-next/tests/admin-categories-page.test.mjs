import { jsx } from 'react/jsx-runtime'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminCategoriesData: vi.fn(),
  createCategoryAction: vi.fn(),
  deleteCategoryAction: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }) => jsx('a', { ...props, href, children }),
}))

vi.mock('@/server/lib/blog', () => ({
  getAdminCategoriesData: mocks.getAdminCategoriesData,
}))

vi.mock('../app/admin/actions.ts', () => ({
  createCategoryAction: mocks.createCategoryAction,
  deleteCategoryAction: mocks.deleteCategoryAction,
}))

const { default: AdminCategoriesPage } = await import('../app/admin/categories/page.tsx')

describe('admin categories page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders categories and wires create and delete actions', async () => {
    mocks.getAdminCategoriesData.mockResolvedValue({
      categories: [
        { id: 7, name: 'Framework', slug: 'framework' },
        { id: 9, name: 'Security', slug: 'security' },
      ],
    })

    const element = await AdminCategoriesPage()

    let renderer
    await act(async () => {
      renderer = create(element)
    })

    const forms = renderer.root.findAllByType('form')
    expect(forms[0].props.action).toBe(mocks.createCategoryAction)
    expect(renderer.root.findByProps({ name: 'name' }).props.placeholder).toBe('Category name')
    expect(renderer.root.findByProps({ name: 'description' }).props.placeholder).toBe('Description')
    expect(renderer.root.findByProps({ children: 'Framework' }).type).toBe('strong')
    expect(renderer.root.findByProps({ children: 'framework' }).type).toBe('div')
    expect(renderer.root.findByProps({ href: '/admin/categories/7/edit' }).props.children).toBe('Edit')

    await forms[1].props.action(new FormData())

    expect(mocks.deleteCategoryAction).toHaveBeenCalledWith(7, expect.any(FormData))

    await act(async () => {
      renderer.unmount()
    })
  })
})
