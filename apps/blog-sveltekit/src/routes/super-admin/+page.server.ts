import { redirect } from '@sveltejs/kit'
import { auth } from '@holo-js/auth/sveltekit/server'

export async function load() {
  const currentAuth = await auth({ guard: 'admin' })

  if (!currentAuth.authenticated) {
    throw redirect(303, '/super-admin/login')
  }

  return {
    admin: currentAuth.user,
  }
}
