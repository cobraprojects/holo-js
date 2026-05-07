import { logout, user } from '@holo-js/auth'

export default defineEventHandler(async () => {
  await logout()

  return {
    ok: true,
    authenticated: false,
    message: 'Signed out successfully.',
    user: await user(),
  }
})
