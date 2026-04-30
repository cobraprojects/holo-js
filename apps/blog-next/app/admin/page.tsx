import Link from 'next/link'

import { getAdminDashboardData } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function AdminDashboardPage() {
  const dashboard = await getAdminDashboardData()

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <h1 style={{ margin: 0 }}>Admin</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem' }}>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.postCount}</strong><div>Posts</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.publishedCount}</strong><div>Published</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.categoryCount}</strong><div>Categories</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.tagCount}</strong><div>Tags</div></article>
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <Link href="/admin/posts" style={{ color: '#7dd3fc' }}>Manage posts</Link>
        <Link href="/admin/categories" style={{ color: '#7dd3fc' }}>Manage categories</Link>
        <Link href="/admin/tags" style={{ color: '#7dd3fc' }}>Manage tags</Link>
      </div>
    </section>
  )
}
