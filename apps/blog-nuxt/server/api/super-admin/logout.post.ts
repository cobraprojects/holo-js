import auth from '@holo-js/auth'

export default defineEventHandler(async () => {
  const admin = auth.guard('admin')
  await admin.logout()

  return {
    ok: true,
    authenticated: false,
    message: 'Signed out of super admin.',
    user: await admin.user(),
  }
})
