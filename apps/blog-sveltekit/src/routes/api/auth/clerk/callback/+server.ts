import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeClerkAuth } from '@holo-js/auth-clerk'

export const GET = (async (event) => {
  const { error } = await completeClerkAuth(event)
  if (error) {
    throw redirect(303, `/login?error=${encodeURIComponent(error.code)}`)
  }

  throw redirect(303, '/admin')
}) satisfies RequestHandler
