import { loginWithWorkos } from '@holo-js/auth-workos'
import type { RequestHandler } from './$types'

export const GET = (async (event) => {
  return await loginWithWorkos(event)
}) satisfies RequestHandler
