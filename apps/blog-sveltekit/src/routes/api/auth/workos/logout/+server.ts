import type { RequestHandler } from '@sveltejs/kit'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export const POST = (async (event) => {
  return await logoutWithWorkos(event)
}) satisfies RequestHandler
