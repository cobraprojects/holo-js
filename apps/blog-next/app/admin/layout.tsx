import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@holo-js/auth/next/server'
import { authorize } from '@holo-js/authorization'

import Post from '@/server/models/Post'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const currentAuth = await auth()
  if (!currentAuth.authenticated || !currentAuth.user) {
    redirect('/login')
  }
  await authorize('viewAny', Post)

  return children
}
