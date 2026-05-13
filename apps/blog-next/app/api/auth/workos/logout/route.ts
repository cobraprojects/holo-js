import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'

export async function POST(request: Request) {
  if (await provider() !== 'workos') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const result = await logoutWithWorkos(request)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
