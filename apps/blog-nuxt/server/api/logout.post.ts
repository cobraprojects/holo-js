import { logout, user } from '@holo-js/auth'

export default defineEventHandler(async (event) => {
  const signedOut = await logout()
  event.node.res.setHeader('set-cookie', [...signedOut.cookies])

  return {
    ok: true,
    authenticated: false,
    message: 'Signed out successfully.',
    user: await user(),
  }
})
