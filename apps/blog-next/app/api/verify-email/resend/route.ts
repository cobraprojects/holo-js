import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../../server/lib/validation-response'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export async function POST(request: Request) {
  try {
    const input = await validate(request, resendEmailVerificationForm, {
      throttle: 'emailVerificationResend',
    })

    await resendEmailVerification(input.email)

    return Response.json({
      ok: true,
      status: 200,
      data: {
        message: resendSuccessMessage,
      },
    })
  } catch (error) {
    const response = validationExceptionResponse(error)
    if (response) {
      return response
    }

    throw error
  }
}
