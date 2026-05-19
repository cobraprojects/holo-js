import { json } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async () => {
  const admin = auth.guard('admin')
  await admin.logout()

  return json({
    ok: true,
    authenticated: false,
    message: 'Signed out of super admin.',
    user: await admin.user(),
  })
}
