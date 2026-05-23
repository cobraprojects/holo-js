import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeWorkosAuth } from '@holo-js/auth-workos'

export const GET = (async (event) => {
  const { error } = await completeWorkosAuth(event)
  if (error) {
    throw redirect(303, `/login?error=${encodeURIComponent(error.code)}`)
  }

  throw redirect(303, '/admin')
}) satisfies RequestHandler
