import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { isValidationException } from '@holo-js/validation'

import { resendEmailVerificationForm } from '#shared/schemas/auth'

const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return {
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  }
}

export default defineEventHandler(async (event) => {
  const input = await validate(event, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  try {
    await resendEmailVerification(input.email)
  } catch (error) {
    if (!isValidationException(error)) {
      throw error
    }
  }

  return resendSuccessResponse()
})
