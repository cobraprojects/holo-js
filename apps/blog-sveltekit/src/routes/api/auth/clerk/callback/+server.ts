import { redirect, type RequestHandler } from '@sveltejs/kit'
import { completeClerkAuth } from '@holo-js/auth-clerk'

export const GET = (async (event) => {
  const result = await completeClerkAuth(event)
  if (!result.ok) {
    throw redirect(303, `/login?error=${encodeURIComponent(result.code)}`)
  }

  throw redirect(303, '/admin')
}) satisfies RequestHandler
