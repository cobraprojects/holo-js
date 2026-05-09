import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, resendEmailVerificationForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await resendEmailVerification(submission.data.email)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: 'A fresh verification email has been sent.',
  }))
}
