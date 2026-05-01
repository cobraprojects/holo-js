import { notFound } from 'next/navigation'
import { getAdminCategoryById } from '@/server/lib/blog'
import { updateCategoryAction } from '../../../actions'

export const dynamic = 'force-dynamic'

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const category = await getAdminCategoryById(Number(id))

  if (!category) {
    notFound()
  }

  const updateWithId = updateCategoryAction.bind(null, category.id)

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Edit category</h1>
      <form action={updateWithId} style={{ display: 'grid', gap: '0.75rem' }}>
        <input name="name" defaultValue={category.name} required />
        <textarea name="description" defaultValue={category.description ?? ''} rows={3} />
        <button type="submit">Save category</button>
      </form>
    </section>
  )
}
