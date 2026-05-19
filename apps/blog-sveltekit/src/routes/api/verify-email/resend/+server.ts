import { json } from '@sveltejs/kit'
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '$lib/schemas/auth'
import type { RequestHandler } from './$types'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export const POST: RequestHandler = async ({ request }) => {
  const submission = await validate(request, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  const success = () => json(submission.success({
    message: resendSuccessMessage,
  }))

  if (!submission.valid) {
    const failure = submission.fail()

    return json(failure, {
      status: failure.status,
    })
  }

  await resendEmailVerification(submission.data.email)

  return success()
}
