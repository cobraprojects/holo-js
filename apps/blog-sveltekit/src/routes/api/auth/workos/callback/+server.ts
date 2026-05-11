import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeWorkosAuth } from '@holo-js/auth-workos'

export const GET = (async (event) => {
  const result = await completeWorkosAuth(event)
  if (!result.ok) {
    throw redirect(303, `/login?error=${encodeURIComponent(result.code)}`)
  }

  throw redirect(303, '/admin')
}) satisfies RequestHandler
