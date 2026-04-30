import { notFound } from 'next/navigation'
import { getAdminTagById } from '@/server/lib/blog'
import { updateTagAction } from '../../../actions'

export const dynamic = 'force-dynamic'

export default async function EditTagPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tag = await getAdminTagById(Number(id))

  if (!tag) {
    notFound()
  }

  const updateWithId = updateTagAction.bind(null, tag.id)

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Edit tag</h1>
      <form action={updateWithId} style={{ display: 'grid', gap: '0.75rem' }}>
        <input name="name" defaultValue={tag.name} required />
        <button type="submit">Save tag</button>
      </form>
    </section>
  )
}
