import { authOnly } from '@holo-js/auth/nuxt/server'

export default authOnly({
  routes: ['/admin/*'],
  redirectTo: '/login',
})
