import { notFound } from 'next/navigation'
import { getAdminPostById } from '@/server/lib/blog'
import { updatePostAction } from '../../../actions'

export const dynamic = 'force-dynamic'

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getAdminPostById(Number(id))

  if (!data) {
    notFound()
  }

  const updateWithId = updatePostAction.bind(null, data.post.id)

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Edit post</h1>
      <form action={updateWithId} style={{ display: 'grid', gap: '1rem' }}>
        <input name="title" defaultValue={data.post.title} required />
        <textarea name="excerpt" defaultValue={data.post.excerpt ?? ''} rows={3} />
        <textarea name="body" defaultValue={data.post.body} rows={10} required />
        <select name="categoryId" defaultValue={data.post.category_id ? String(data.post.category_id) : ''}>
          <option value="">Uncategorized</option>
          {data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <fieldset style={{ border: '1px solid rgba(148, 163, 184, 0.2)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <legend style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Tags</legend>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {data.tags.map(tag => (
              <label key={tag.id} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', color: '#cbd5e1' }}>
                <input type="checkbox" name="tagIds" value={tag.id} defaultChecked={data.post.tags.some(t => t.id === tag.id)} />
                {tag.name}
              </label>
            ))}
          </div>
        </fieldset>
        <select name="status" defaultValue={data.post.status}>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
        </select>
        <button type="submit">Save post</button>
      </form>
    </section>
  )
}
