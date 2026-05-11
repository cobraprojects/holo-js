import { logoutWithWorkos } from '@holo-js/auth-workos'

export async function POST(request: Request) {
  const result = await logoutWithWorkos(request)
  if (!result.ok) {
    return Response.json(result, { status: 422 })
  }

  return Response.redirect(result.url, 303)
}
