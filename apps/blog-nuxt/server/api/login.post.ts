import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, {
    throttle: 'login',
  })

  const session = await login(input)

  return {
    ok: true,
    status: 200,
    data: {
      message: session.emailVerificationRequired
        ? 'Signed in. Verify your email address to continue.'
        : 'Signed in successfully.',
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/admin',
      user: session.user,
    },
  }
})
