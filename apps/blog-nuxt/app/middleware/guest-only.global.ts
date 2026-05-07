import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({
  routes: ['/login', '/register', '/forgot-password', '/reset-password'],
  redirectTo: '/admin',
})
