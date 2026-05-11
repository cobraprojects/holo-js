import { logoutWithClerk } from '@holo-js/auth-clerk'

export async function POST(request: Request) {
  const result = await logoutWithClerk(request)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
