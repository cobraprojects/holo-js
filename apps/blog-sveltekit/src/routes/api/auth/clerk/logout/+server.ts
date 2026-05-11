import { redirect, type RequestHandler } from '@sveltejs/kit'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export const POST = (async (event) => {
  const result = await logoutWithClerk(event)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  throw redirect(303, result.url)
}) satisfies RequestHandler
