import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'

import Post from '@/server/models/Post'

export async function requireAdminAuth(): Promise<void> {
  const currentAuth = await auth()

  if (!currentAuth.authenticated) {
    redirect('/login')
  }

  await authorize('viewAny', Post)
}
