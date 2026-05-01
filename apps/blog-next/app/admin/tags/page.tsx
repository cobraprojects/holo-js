import Link from 'next/link'
import { getAdminTagsData } from '@/server/lib/blog'
import { createTagAction, deleteTagAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AdminTagsPage() {
  const data = await getAdminTagsData()

  return (
    <section style={{ display: 'grid', gap: '1.5rem' }}>
      <h1 style={{ margin: 0 }}>Tags</h1>
      <form action={createTagAction} style={{ display: 'grid', gap: '0.75rem' }}>
        <input name="name" placeholder="Tag name" required />
        <button type="submit">Create tag</button>
      </form>
      {data.tags.map(tag => (
        <article key={tag.id} style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <div>
              <strong>{tag.name}</strong>
              <div style={{ color: '#94a3b8' }}>{tag.slug}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Link href={`/admin/tags/${tag.id}/edit`} style={{ color: '#7dd3fc' }}>Edit</Link>
              <form action={deleteTagAction.bind(null, tag.id)}>
                <button type="submit">Delete</button>
              </form>
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}
