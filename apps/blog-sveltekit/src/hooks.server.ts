import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'
import { csrfProtection } from '@holo-js/security/sveltekit/server'

export const handle = sequence(
  csrfProtection(),
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
