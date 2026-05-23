import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export async function POST(request: Request) {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch {
    return Response.redirect(new URL('/', request.url), 303)
  }

  if (currentProvider !== 'workos') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const { data, error } = await logoutWithWorkos(request)
  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  return Response.redirect(data.url, 303)
}
