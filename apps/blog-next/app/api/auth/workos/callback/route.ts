import { completeWorkosAuth } from '@holo-js/auth-workos'

export async function GET(request: Request) {
  const { error } = await completeWorkosAuth(request)
  if (error) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent(error.code)}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
