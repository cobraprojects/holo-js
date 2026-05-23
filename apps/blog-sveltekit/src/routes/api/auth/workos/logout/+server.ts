import { redirect, type RequestHandler } from '@sveltejs/kit'
import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export const POST = (async (event) => {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch {
    throw redirect(303, '/')
  }

  if (currentProvider !== 'workos') {
    throw redirect(303, '/')
  }

  const { data, error } = await logoutWithWorkos(event)
  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  throw redirect(303, data.url)
}) satisfies RequestHandler
