'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@holo-js/auth/next/client'

const linkStyle = {
  color: '#cbd5e1',
  textDecoration: 'none',
} as const

const logoutButtonStyle = {
  background: 'transparent',
  border: 0,
  color: '#cbd5e1',
  cursor: 'pointer',
  font: 'inherit',
  padding: 0,
} as const

export function AuthNav() {
  const auth = useAuth()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const displayName = auth.user?.name ?? auth.user?.email ?? 'Account'

  async function logout() {
    if (isLoggingOut) {
      return
    }

    setIsLoggingOut(true)
    try {
      const response = await fetch('/api/logout', { method: 'POST' })
      if (!response.ok) {
        console.warn('Logout failed.', { status: response.status })
        return
      }

      await auth.refreshUser()
    } catch (error) {
      console.warn('Logout failed.', error)
    } finally {
      setIsLoggingOut(false)
    }
  }

  if (!auth.authenticated) {
    return (
      <>
        <Link href="/login" style={linkStyle}>Login</Link>
        <Link href="/register" style={linkStyle}>Register</Link>
      </>
    )
  }

  return (
    <>
      <span style={{ color: '#e5eef8' }}>{displayName}</span>
      <button type="button" disabled={isLoggingOut} onClick={logout} style={logoutButtonStyle}>Logout</button>
    </>
  )
}
