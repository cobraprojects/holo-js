import { json } from '@sveltejs/kit'
import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, resendEmailVerificationForm)

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await resendEmailVerification(submission.data.email)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return json(failure, { status: failure.status })
  }

  return json(submission.success({
    message: 'A fresh verification email has been sent.',
  }))
}
