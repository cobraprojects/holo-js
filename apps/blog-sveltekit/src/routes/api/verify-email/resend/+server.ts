import { json } from '@sveltejs/kit'
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { isValidationException } from '@holo-js/validation'

import { resendEmailVerificationForm } from '$lib/schemas/auth'
import type { RequestHandler } from './$types'

const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return json({
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  })
}

export const POST: RequestHandler = async ({ request }) => {
  const input = await validate(request, resendEmailVerificationForm, {
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
}
