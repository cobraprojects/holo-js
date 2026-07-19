import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { AuthProvider } from '@holo-js/auth/next/client'
import { auth } from '@holo-js/auth/next/server'

import { AuthNav } from './auth-nav'

export const metadata: Metadata = {
  title: 'blog-next',
  description: 'A reference Holo blog built on Next.js',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Inter, Arial, sans-serif', background: '#0b1020', color: '#e5eef8' }}>
        <AuthProvider initialProvider={currentAuth.provider} initialUser={currentAuth.user}>
          <div style={{ minHeight: '100vh' }}>
            <header style={{ borderBottom: '1px solid rgba(148, 163, 184, 0.2)', background: 'rgba(11, 16, 32, 0.92)' }}>
              <nav style={{ maxWidth: '72rem', margin: '0 auto', display: 'flex', gap: '1rem', alignItems: 'center', padding: '1rem 1.5rem', flexWrap: 'wrap' }}>
                <Link href="/" style={{ color: '#fff', textDecoration: 'none', fontWeight: 700 }}>blog-next</Link>
                <Link href="/posts" style={{ color: '#cbd5e1', textDecoration: 'none' }}>Posts</Link>
                <Link href="/api-token-posts" style={{ color: '#cbd5e1', textDecoration: 'none' }}>API Token</Link>
                <Link href="/admin" style={{ color: '#cbd5e1', textDecoration: 'none' }}>Admin</Link>
                <Link href="/super-admin" style={{ color: '#cbd5e1', textDecoration: 'none' }}>Super Admin</Link>
                <AuthNav />
              </nav>
            </header>
            <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2rem 1.5rem 4rem' }}>{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  )
}
