import { sequence } from '@sveltejs/kit/hooks'
import { authOnly, guestOnly } from '@holo-js/auth/sveltekit/server'

export const handle = sequence(
  guestOnly({
    routes: ['/login', '/register', '/forgot-password', '/reset-password'],
    redirectTo: '/admin',
  }),
  authOnly({
    routes: ['/admin/*'],
    redirectTo: '/login',
  }),
)
