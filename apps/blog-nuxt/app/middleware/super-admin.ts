import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  guard: 'admin',
  redirectTo: '/super-admin/login',
})
