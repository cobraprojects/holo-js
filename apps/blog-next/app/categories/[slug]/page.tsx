import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getCategoryArchive } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const archive = await getCategoryArchive(slug)

  if (!archive) {
    notFound()
  }

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>{archive.category.name}</h1>
      <p style={{ color: '#cbd5e1' }}>{archive.category.description}</p>
      {archive.posts.map(post => (
        <article key={post.id} style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827' }}>
          <h2 style={{ marginTop: 0 }}><Link href={`/posts/${post.slug}`} style={{ color: '#fff', textDecoration: 'none' }}>{post.title}</Link></h2>
          <p style={{ color: '#cbd5e1' }}>{post.excerpt}</p>
        </article>
      ))}
    </section>
  )
}
