import auth from '@holo-js/auth'

export async function POST() {
  const admin = auth.guard('admin')
  await admin.logout()

  return Response.json({
    ok: true,
    authenticated: false,
    message: 'Signed out of super admin.',
    user: await admin.user(),
  })
}
