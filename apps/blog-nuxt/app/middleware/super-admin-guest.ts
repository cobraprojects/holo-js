import { useAuth } from '@holo-js/auth/nuxt'

export default defineNuxtRouteMiddleware(async () => {
  const currentAuth = await useAuth({
    guard: 'admin',
  })

  if (!currentAuth.authenticated.value) {
    return undefined
  }

  return navigateTo('/super-admin', {
    redirectCode: 303,
  })
})
