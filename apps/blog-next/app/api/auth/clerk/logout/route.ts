import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'

export async function POST(request: Request) {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch {
    return Response.redirect(new URL('/', request.url), 303)
  }

  if (currentProvider !== 'clerk') {
    return Response.redirect(new URL('/', request.url), 303)
  }

  const { data, error } = await logoutWithClerk(request)
  if (error) {
    return Response.json({ data, error }, { status: error.status })
  }

  return Response.redirect(data.url, 303)
}
