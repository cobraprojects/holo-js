import { json } from '@sveltejs/kit'
import { logout, user } from '@holo-js/auth'

export async function POST() {
  await logout()

  return json({
    ok: true,
    authenticated: false,
    message: 'Signed out successfully.',
    user: await user(),
  })
}
