import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export async function POST(request: Request) {
  if (await provider() !== 'clerk') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const result = await logoutWithClerk(request)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
