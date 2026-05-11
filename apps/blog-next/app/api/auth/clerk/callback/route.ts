import { completeClerkAuth } from '@holo-js/auth-clerk'

export async function GET(request: Request) {
  const result = await completeClerkAuth(request)
  if (!result.ok) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent(result.code)}`, request.url))
  }

  return Response.redirect(new URL('/admin', request.url))
}
