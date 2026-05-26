import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { forgotPasswordForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, forgotPasswordForm)

  await requestPasswordReset(input)

  return {
    ok: true,
    status: 200,
    data: {
      message: 'If an account exists for that email, a reset link has been sent.',
    },
  }
})
