import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'
import { csrfProtection } from '@holo-js/security/next/server'

const csrf = csrfProtection()
const auth = protectRoutes(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
  guestOnly({
    routes: ['/super-admin/login'],
    guard: 'admin',
    redirectTo: '/super-admin',
  }),
  authOnly({
    routes: ['/super-admin'],
    guard: 'admin',
    redirectTo: '/super-admin/login',
  }),
)

export async function proxy(request: Parameters<typeof csrf>[0]) {
  const csrfResponse = await csrf(request)
  if (csrfResponse?.status === 419) {
    return csrfResponse
  }

  const authResponse = await auth(request)
  return authResponse ?? csrfResponse
}

export const config = {
  matcher: [
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/admin/:path*',
    '/super-admin',
    '/super-admin/login',
    '/api/:path*',
  ],
}
