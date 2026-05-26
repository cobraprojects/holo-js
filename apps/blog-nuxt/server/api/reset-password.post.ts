import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resetPasswordForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, resetPasswordForm)

  await resetPassword(input)

  return {
    ok: true,
    status: 200,
    data: {
      message: 'Password reset successfully. You can sign in with your new password.',
      redirectTo: '/login',
    },
  }
})
