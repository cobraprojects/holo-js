'use client'

import Link from 'next/link'
import { useAuth } from '@holo-js/auth/next/client'
import { logoutAction } from './logout/actions'

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

const logoutFormStyle = {
  display: 'inline',
} as const

export function AuthNav() {
  const auth = useAuth()
  const displayName = auth.user?.name ?? auth.user?.email ?? 'Account'

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
      <form action={logoutAction} style={logoutFormStyle}>
        <button type="submit" style={logoutButtonStyle}>Logout</button>
      </form>
      {auth.provider === 'workos' && (
        <form action="/api/auth/workos/logout" method="post" style={logoutFormStyle}>
          <button type="submit" style={logoutButtonStyle}>Logout from WorkOS</button>
        </form>
      )}
      {auth.provider === 'clerk' && (
        <form action="/api/auth/clerk/logout" method="post" style={logoutFormStyle}>
          <button type="submit" style={logoutButtonStyle}>Logout from Clerk</button>
        </form>
      )}
    </>
  )
}
