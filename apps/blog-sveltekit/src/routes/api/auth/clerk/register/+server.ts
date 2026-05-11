import { registerWithClerk } from '@holo-js/auth-clerk'
import type { RequestHandler } from './$types'

export const GET = (async (event) => {
  return await registerWithClerk(event)
}) satisfies RequestHandler
