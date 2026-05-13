import { redirect, type RequestHandler } from '@sveltejs/kit'
import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export const POST = (async (event) => {
  if (await provider() !== 'clerk') {
    throw redirect(303, '/')
  }

  const result = await logoutWithClerk(event)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  throw redirect(303, result.url)
}) satisfies RequestHandler
