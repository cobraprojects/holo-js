import { redirect, type RequestHandler } from '@sveltejs/kit'
import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export const POST = (async (event) => {
  if (await provider() !== 'workos') {
    throw redirect(303, '/')
  }

  const result = await logoutWithWorkos(event)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  throw redirect(303, result.url)
}) satisfies RequestHandler
