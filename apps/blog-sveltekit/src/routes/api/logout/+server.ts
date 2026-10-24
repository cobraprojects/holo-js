import { logout, user } from '@holo-js/auth'

export async function POST() {
  await logout()

  return Response.json({
    ok: true,
    authenticated: false,
    message: 'Signed out successfully.',
    user: await user(),
  })
}
