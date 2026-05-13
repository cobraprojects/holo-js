import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { SuperAdminLogoutButton } from './logout-button'

export default async function SuperAdminPage() {
  const currentAuth = await auth({ guard: 'admin' })

  if (!currentAuth.authenticated) {
    redirect('/super-admin/login')
  }

  const displayName = currentAuth.user?.name ?? currentAuth.user?.email ?? 'Super Admin'

  return (
    <section style={{ display: 'grid', gap: '0.75rem', maxWidth: '42rem' }}>
      <p style={{ margin: 0, color: '#7dd3fc', fontSize: '0.875rem', textTransform: 'uppercase' }}>Admin guard</p>
      <h1 style={{ margin: 0 }}>Super Admin</h1>
      <p style={{ margin: 0, color: '#cbd5e1' }}>Signed in as {displayName} through the admin guard.</p>
      <div>
        <SuperAdminLogoutButton />
      </div>
    </section>
  )
}
