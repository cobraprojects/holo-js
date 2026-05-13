import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function POST(request: Request) {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch (error) {
    return Response.json({ ok: false, error: getErrorMessage(error) }, { status: 500 })
  }

  if (currentProvider !== 'workos') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  let result: Awaited<ReturnType<typeof logoutWithWorkos>>
  try {
    result = await logoutWithWorkos(request)
  } catch (error) {
    return Response.json({ ok: false, error: getErrorMessage(error) }, { status: 500 })
  }

  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
