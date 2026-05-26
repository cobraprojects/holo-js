import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '#shared/schemas/auth'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export default defineEventHandler(async (event) => {
  const input = await validate(event, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  await resendEmailVerification(input.email)

  return {
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  }
})
