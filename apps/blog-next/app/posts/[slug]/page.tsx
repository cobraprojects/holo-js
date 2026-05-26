import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'

import { getPublishedPostBySlug } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function PostDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = await getPublishedPostBySlug(slug)

  if (!post) {
    notFound()
  }

  const imagePath = await post.getFirstMediaPath('images', 'thumb')

  return (
    <article style={{ display: 'grid', gap: '1rem' }}>
      <Link href="/posts" style={{ color: '#7dd3fc' }}>Back to posts</Link>
      <h1 style={{ margin: 0 }}>{post.title}</h1>
      {imagePath ? <Image src={imagePath} alt="" width={1200} height={675} style={{ width: '100%', height: 'auto', borderRadius: '1rem', background: '#111827' }} /> : null}
      <p style={{ margin: 0, color: '#cbd5e1' }}>{post.excerpt}</p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {post.category ? <Link href={`/categories/${post.category.slug}`} style={{ color: '#7dd3fc' }}>{post.category.name}</Link> : null}
        {post.tags.map(tag => <Link key={tag.id} href={`/tags/${tag.slug}`} style={{ color: '#f9a8d4' }}>#{tag.name}</Link>)}
      </div>
      <div style={{ padding: '1.5rem', borderRadius: '1rem', background: '#111827', lineHeight: 1.8 }}>{post.body}</div>
    </article>
  )
}
