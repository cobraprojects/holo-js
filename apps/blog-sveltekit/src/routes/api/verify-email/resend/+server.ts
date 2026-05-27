import { json } from '@sveltejs/kit'
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '$lib/schemas/auth'
import type { RequestHandler } from './$types'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export const POST: RequestHandler = async ({ request }) => {
  const input = await validate(request, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  await resendEmailVerification(input.email)

  return json({
    ok: true,
    status: 200,
    data: {
      message: resendSuccessMessage,
    },
  })
}
