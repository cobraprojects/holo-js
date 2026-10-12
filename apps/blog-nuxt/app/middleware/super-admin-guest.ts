import { guestOnly } from '@holo-js/auth/nuxt/server'

export default guestOnly({
  guard: 'admin',
  redirectTo: '/super-admin',
})
