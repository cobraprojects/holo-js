import { auth } from '@holo-js/auth/sveltekit/server'
import { readValidationFlash } from '@holo-js/adapter-sveltekit'
import { csrf } from '@holo-js/security'
import type { LayoutServerLoad } from './$types'

export const load = (async ({ request, url }) => {
  const currentAuth = await auth()

  return {
    auth: currentAuth,
    csrf: { input: await csrf.input(request) },
    holoValidationFlash: readValidationFlash(url),
  }
}) satisfies LayoutServerLoad
