import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, resendEmailVerificationForm)

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { error } = await resendEmailVerification(submission.data.email)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return submission.success({
    message: 'A fresh verification email has been sent.',
  })
})
