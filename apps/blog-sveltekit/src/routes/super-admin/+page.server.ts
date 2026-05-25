import { redirect } from '@sveltejs/kit'
import authRuntime from '@holo-js/auth'
import { auth } from '@holo-js/auth/sveltekit/server'
import type { Actions } from './$types'

export async function load() {
  const currentAuth = await auth({ guard: 'admin' })

  if (!currentAuth.authenticated) {
    throw redirect(303, '/super-admin/login')
  }

  return {
    admin: currentAuth.user,
  }
}

export const actions = {
  default: async () => {
    await authRuntime.guard('admin').logout()
    redirect(303, '/super-admin/login')
  },
} satisfies Actions
