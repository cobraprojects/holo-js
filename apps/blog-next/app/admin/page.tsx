import Link from 'next/link'
import { user } from '@holo-js/auth'

import { getAdminDashboardData } from '@/server/lib/blog'
import { BroadcastFeed } from './broadcast-feed'

export const dynamic = 'force-dynamic'

export default async function AdminDashboardPage() {
  const [dashboard, currentUser] = await Promise.all([
    getAdminDashboardData(),
    user(),
  ])
  const displayName = currentUser?.name ?? currentUser?.email ?? 'Editor'

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Signed in as {displayName}</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem' }}>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.postCount}</strong><div>Posts</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.publishedCount}</strong><div>Published</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.categoryCount}</strong><div>Categories</div></article>
        <article style={{ padding: '1rem', borderRadius: '1rem', background: '#111827' }}><strong>{dashboard.tagCount}</strong><div>Tags</div></article>
      </div>
      <BroadcastFeed />
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <Link href="/admin/posts" style={{ color: '#7dd3fc' }}>Manage posts</Link>
        <Link href="/admin/categories" style={{ color: '#7dd3fc' }}>Manage categories</Link>
        <Link href="/admin/tags" style={{ color: '#7dd3fc' }}>Manage tags</Link>
      </div>
    </section>
  )
}
