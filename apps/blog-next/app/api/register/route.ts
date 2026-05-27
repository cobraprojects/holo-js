import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, registerForm, {
      throttle: 'register',
    })

    const created = await register(input)

    const session = await loginUsing(created)
    return Response.json({
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
    }, {
      status: 201,
    })
  } catch (error) {
    const response = validationExceptionResponse(error)
    if (response) {
      return response
    }

    throw error
  }
}
