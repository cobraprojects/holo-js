import Link from 'next/link'
import { getAdminCategoriesData } from '@/server/lib/blog'
import { createCategoryAction, deleteCategoryAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AdminCategoriesPage() {
  const data = await getAdminCategoriesData()

  return (
    <section style={{ display: 'grid', gap: '1.5rem' }}>
      <h1 style={{ margin: 0 }}>Categories</h1>
      <form action={createCategoryAction} style={{ display: 'grid', gap: '0.75rem' }}>
        <input name="name" placeholder="Category name" required />
        <textarea name="description" placeholder="Description" rows={3} />
        <button type="submit">Create category</button>
      </form>
      {data.categories.map(category => (
        <article key={category.id} style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <div>
              <strong>{category.name}</strong>
              <div style={{ color: '#94a3b8' }}>{category.slug}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Link href={`/admin/categories/${category.id}/edit`} style={{ color: '#7dd3fc' }}>Edit</Link>
              <form action={deleteCategoryAction.bind(null, category.id)}>
                <button type="submit">Delete</button>
              </form>
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}
