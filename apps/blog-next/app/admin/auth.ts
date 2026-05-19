import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'

export async function requireAdminAuth(): Promise<void> {
  const currentAuth = await auth()

  if (!currentAuth.authenticated) {
    redirect('/login')
  }
}
