import { auth } from '@holo-js/auth/sveltekit/server'
import type { LayoutServerLoad } from './$types'

export const load = (async () => {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
  }
}) satisfies LayoutServerLoad
