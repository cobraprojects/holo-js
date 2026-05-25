import { auth } from '@holo-js/auth/sveltekit/server'
import { csrf } from '@holo-js/security'
import type { LayoutServerLoad } from './$types'

export const load = (async ({ request }) => {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
    csrf: await csrf.field(request),
  }
}) satisfies LayoutServerLoad
