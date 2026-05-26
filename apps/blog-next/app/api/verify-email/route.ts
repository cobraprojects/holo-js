import { check, verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, verifyEmailForm)

    const wasAuthenticated = await check()
    await verifyEmail(input.token)

    return Response.json({
      ok: true,
      status: 200,
      data: {
        message: wasAuthenticated
          ? 'Email address verified.'
          : 'Email address verified. You can sign in now.',
        redirectTo: wasAuthenticated ? '/admin' : '/login',
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
