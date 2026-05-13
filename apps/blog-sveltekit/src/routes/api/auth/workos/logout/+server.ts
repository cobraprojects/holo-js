import { redirect, type RequestHandler } from '@sveltejs/kit'
import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const POST = (async (event) => {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch (error) {
    return Response.json({ ok: false, error: getErrorMessage(error) }, { status: 422 })
  }

  if (currentProvider !== 'workos') {
    throw redirect(303, '/')
  }

  const result = await logoutWithWorkos(event)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  throw redirect(303, result.url)
}) satisfies RequestHandler
