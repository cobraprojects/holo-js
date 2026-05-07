import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { forgotPasswordForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, forgotPasswordForm)

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { error } = await requestPasswordReset(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return submission.success({
    message: 'If an account exists for that email, a reset link has been sent.',
  })
})
