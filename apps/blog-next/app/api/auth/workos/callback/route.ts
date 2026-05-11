import { completeWorkosAuth } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const result = await completeWorkosAuth(request)
  if (!result.ok) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent(result.code)}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
