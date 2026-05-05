import { logout, user } from '@holo-js/auth'

export async function POST() {
  const signedOut = await logout()
  const headers = new Headers()
  for (const cookie of signedOut.cookies) {
    headers.append('set-cookie', cookie)
  }

  return Response.json({
    ok: true,
    authenticated: false,
    message: 'Signed out successfully.',
    user: await user(),
  }, {
    headers,
  })
}
