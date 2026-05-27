import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, loginForm, {
      throttle: 'login',
    })

    const session = await login(input)

    return Response.json({
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
    })
  } catch (error) {
    const response = validationExceptionResponse(error)
    if (response) {
      return response
    }

    throw error
  }
}
