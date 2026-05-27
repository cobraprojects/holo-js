import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { forgotPasswordForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, forgotPasswordForm)

    await requestPasswordReset(input)

    return Response.json({
      ok: true,
      status: 200,
      data: {
        message: 'If an account exists for that email, a reset link has been sent.',
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
