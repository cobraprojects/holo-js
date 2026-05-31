import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { isValidationException } from '@holo-js/validation'

import { loginForm } from '@/lib/schemas/auth'
import { validationExceptionResponse } from '../../../../server/lib/validation-response'

export async function POST(request: Request) {
  try {
    const input = await validate(request, loginForm, {
      throttle: 'login',
    })

    const token = await (async () => {
      try {
        return await auth.guard('api').login(input)
      } catch (error) {
        if (isValidationException(error)) {
          return Response.json({
            ok: false,
            status: 401,
            message: 'Invalid credentials.',
          }, {
            status: 401,
          })
        }

        throw error
      }
    })()

    if (token instanceof Response) {
      return token
    }

    return Response.json({
      ok: true,
      token: token.plainTextToken,
      tokenId: token.id,
      abilities: token.abilities,
    }, {
      headers: {
        'Cache-Control': 'no-store',
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
