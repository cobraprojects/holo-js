'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@holo-js/auth/next/client'

export function SuperAdminLogoutButton() {
  const router = useRouter()
  const auth = useAuth({ guard: 'admin' })
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  async function logout() {
    if (isLoggingOut) {
      return
    }

    setIsLoggingOut(true)
    try {
      const response = await fetch('/api/super-admin/logout', { method: 'POST' })
      if (!response.ok) {
        console.warn('Super admin logout failed.', { status: response.status })
        return
      }

      await auth.refreshUser()
      router.replace('/super-admin/login')
    } catch (error) {
      console.warn('Super admin logout failed.', error)
    } finally {
      setIsLoggingOut(false)
    }
  }

  return (
    <button type="button" onClick={logout} disabled={isLoggingOut}>
      {isLoggingOut ? 'Signing out...' : 'Sign out of super admin'}
    </button>
  )
}
