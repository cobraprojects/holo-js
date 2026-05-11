import { redirect, type RequestHandler } from '@sveltejs/kit'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export const POST = (async (event) => {
  const result = await logoutWithWorkos(event)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  throw redirect(303, result.url)
}) satisfies RequestHandler
