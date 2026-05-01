import Link from 'next/link'

import { getPublishedPosts } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function PostsPage() {
  const posts = await getPublishedPosts()

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Posts</h1>
      {posts.map(post => (
        <article key={post.id} style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
          <h2 style={{ marginTop: 0 }}><Link href={`/posts/${post.slug}`} style={{ color: '#fff', textDecoration: 'none' }}>{post.title}</Link></h2>
          <p style={{ color: '#cbd5e1' }}>{post.excerpt}</p>
        </article>
      ))}
    </section>
  )
}
