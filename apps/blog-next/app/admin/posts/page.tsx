import Link from 'next/link'
import { getAdminPostsData } from '@/server/lib/blog'
import { deletePostAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AdminPostsPage() {
  const data = await getAdminPostsData()

  return (
    <section style={{ display: 'grid', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Posts</h1>
        <Link href="/admin/posts/new" style={{ color: '#7dd3fc' }}>New post</Link>
      </div>
      {data.posts.map(post => (
        <article key={post.id} style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: '0 0 0.5rem 0' }}>{post.title}</h2>
              <div style={{ color: '#94a3b8' }}>{post.status} · {post.category?.name ?? 'Uncategorized'}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <Link href={`/admin/posts/${post.id}/edit`} style={{ color: '#7dd3fc' }}>Edit</Link>
              <form action={deletePostAction.bind(null, post.id)}>
                <button type="submit">Delete</button>
              </form>
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}
