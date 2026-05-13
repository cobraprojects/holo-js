import { authOnly, guestOnly, protectRoutes } from '@holo-js/auth/next/server'

export const proxy = protectRoutes(
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

export const config = {
  matcher: ['/login', '/register', '/forgot-password', '/reset-password', '/admin/:path*', '/super-admin', '/super-admin/login'],
}
