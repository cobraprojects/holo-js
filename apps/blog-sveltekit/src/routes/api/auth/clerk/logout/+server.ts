import { redirect, type RequestHandler } from '@sveltejs/kit'
import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export const POST = (async (event) => {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch {
    throw redirect(303, '/')
  }

  if (currentProvider !== 'clerk') {
    throw redirect(303, '/')
  }

  const { data, error } = await logoutWithClerk(event)
  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  throw redirect(303, data.url)
}) satisfies RequestHandler
