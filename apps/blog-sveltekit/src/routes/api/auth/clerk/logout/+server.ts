import type { RequestHandler } from '@sveltejs/kit'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export const POST = (async (event) => {
  return await logoutWithClerk(event)
}) satisfies RequestHandler
