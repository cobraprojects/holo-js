import { completeClerkAuth } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const { error } = await completeClerkAuth(request)
  if (error) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent(error.code)}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
