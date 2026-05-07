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
)

export const config = {
  matcher: ['/login', '/register', '/forgot-password', '/reset-password', '/admin/:path*'],
}
