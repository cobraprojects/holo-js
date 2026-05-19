import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '@/lib/schemas/auth'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export async function POST(request: Request) {
  const submission = await validate(request, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  const success = () => Response.json(submission.success({
    message: resendSuccessMessage,
  }))

  if (!submission.valid) {
    const failure = submission.fail()

    return Response.json(failure, {
      status: failure.status,
    })
  }

  await resendEmailVerification(submission.data.email)

  return success()
}
