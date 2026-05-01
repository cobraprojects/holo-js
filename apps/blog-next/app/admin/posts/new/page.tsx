import { getAdminPostsData } from '@/server/lib/blog'
import { createPostAction } from '../../actions'

export const dynamic = 'force-dynamic'

export default async function NewPostPage() {
  const data = await getAdminPostsData()

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>New post</h1>
      <form action={createPostAction} style={{ display: 'grid', gap: '1rem' }}>
        <input name="title" placeholder="Title" required />
        <textarea name="excerpt" placeholder="Excerpt" rows={3} />
        <textarea name="body" placeholder="Body" rows={10} required />
        <select name="categoryId" defaultValue="">
          <option value="">Uncategorized</option>
          {data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <fieldset style={{ border: '1px solid rgba(148, 163, 184, 0.2)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <legend style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Tags</legend>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {data.tags.map(tag => (
              <label key={tag.id} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', color: '#cbd5e1' }}>
                <input type="checkbox" name="tagIds" value={tag.id} />
                {tag.name}
              </label>
            ))}
          </div>
        </fieldset>
        <select name="status" defaultValue="published">
          <option value="published">Published</option>
          <option value="draft">Draft</option>
        </select>
        <button type="submit">Create post</button>
      </form>
    </section>
  )
}
