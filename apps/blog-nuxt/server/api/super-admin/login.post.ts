import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, {
    throttle: 'login',
  })

  const session = await auth.guard('admin').login(input)

  return {
    ok: true,
    status: 200,
    data: {
      message: session.emailVerificationRequired
        ? 'Signed in. Verify your email address to continue.'
        : 'Signed in as super admin.',
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/super-admin',
      user: session.user,
    },
  }
})
