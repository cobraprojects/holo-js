import { guestOnly } from '@holo-js/adapter-next/server'

export const proxy = guestOnly({
  routes: ['/login', '/register', '/forgot-password', '/reset-password'],
  redirectTo: '/admin',
})

export const config = {
  matcher: ['/login', '/register', '/forgot-password', '/reset-password'],
}
