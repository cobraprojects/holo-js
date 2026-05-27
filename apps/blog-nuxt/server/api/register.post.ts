import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, registerForm, {
    throttle: 'register',
  })

  const created = await register(input)

  const session = await loginUsing(created)
  setResponseStatus(event, 201)
  return {
    ok: true,
    status: 201,
    data: {
      message: session.emailVerificationRequired
        ? 'Account created. Check your inbox to verify your email address.'
        : 'Account created and signed in successfully.',
      redirectTo: session.emailVerificationRequired
        ? session.emailVerificationRoute ?? '/verify-email'
        : '/admin',
      user: session.user,
    },
  }
})
