import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { isValidationException } from '@holo-js/validation'

import { resendEmailVerificationForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../../server/lib/validation-response'

const resendSuccessMessage = 'A fresh verification email has been sent.'

function resendSuccessResponse() {
  return Response.json({
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  })
}

export async function POST(request: Request) {
  try {
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
  } catch (error) {
    const response = validationExceptionResponse(error)
    if (response) {
      return response
    }

    throw error
  }
}
