import Link from 'next/link'

import { getHomePageData } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const { featured, posts, categories, tags } = await getHomePageData()

  return (
    <div style={{ display: 'grid', gap: '2rem' }}>
      <section style={{ display: 'grid', gap: '0.75rem', padding: '1.5rem', borderRadius: '1rem', background: 'linear-gradient(135deg, #16213a, #111827)' }}>
        <span style={{ color: '#7dd3fc', fontSize: '0.85rem', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Reference Blog</span>
        <h1 style={{ margin: 0, fontSize: 'clamp(2.5rem, 5vw, 4rem)' }}>Ship a real Holo blog on Next.js</h1>
        <p style={{ margin: 0, maxWidth: '46rem', color: '#cbd5e1', lineHeight: 1.7 }}>
          This app demonstrates a real content model, admin CRUD flows, and public blog routes using only public Holo APIs.
        </p>
      </section>

      {featured ? (
        <section style={{ display: 'grid', gap: '0.75rem', padding: '1.5rem', borderRadius: '1rem', border: '1px solid rgba(148, 163, 184, 0.2)', background: '#111827' }}>
          <span style={{ color: '#f9a8d4', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Featured story</span>
          <h2 style={{ margin: 0 }}><Link href={`/posts/${featured.slug}`} style={{ color: '#fff', textDecoration: 'none' }}>{featured.title}</Link></h2>
          <p style={{ margin: 0, color: '#cbd5e1' }}>{featured.excerpt}</p>
        </section>
      ) : null}

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>Latest posts</h2>
          <Link href="/posts" style={{ color: '#7dd3fc' }}>Browse all</Link>
        </div>
        <div style={{ display: 'grid', gap: '1rem' }}>
          {posts.map(post => (
            <article key={post.id} style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
              <h3 style={{ marginTop: 0 }}><Link href={`/posts/${post.slug}`} style={{ color: '#fff', textDecoration: 'none' }}>{post.title}</Link></h3>
              <p style={{ color: '#cbd5e1' }}>{post.excerpt}</p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {post.category ? <Link href={`/categories/${post.category.slug}`} style={{ color: '#7dd3fc' }}>{post.category.name}</Link> : null}
                {post.tags.map(tag => <Link key={tag.id} href={`/tags/${tag.slug}`} style={{ color: '#f9a8d4' }}>#{tag.name}</Link>)}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem' }}>
        <div style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827' }}>
          <h3 style={{ marginTop: 0 }}>Categories</h3>
          <ul style={{ paddingLeft: '1rem', marginBottom: 0 }}>
            {categories.map(category => <li key={category.id}><Link href={`/categories/${category.slug}`} style={{ color: '#cbd5e1' }}>{category.name}</Link></li>)}
          </ul>
        </div>
        <div style={{ padding: '1.25rem', borderRadius: '1rem', background: '#111827' }}>
          <h3 style={{ marginTop: 0 }}>Tags</h3>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {tags.map(tag => <Link key={tag.id} href={`/tags/${tag.slug}`} style={{ color: '#f9a8d4' }}>#{tag.name}</Link>)}
          </div>
        </div>
      </section>
    </div>
  )
}
