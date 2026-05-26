import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, loginForm, {
      throttle: 'login',
    })

    const session = await auth.guard('admin').login(input)

    return Response.json({
      ok: true,
      status: 200,
      data: {
        message: session.emailVerificationRequired
          ? 'Signed in. Verify your email address to continue.'
          : 'Signed in as super admin.',
        redirectTo: session.emailVerificationRequired
          ? session.emailVerificationRoute ?? '/verify-email'
          : '/super-admin',
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
