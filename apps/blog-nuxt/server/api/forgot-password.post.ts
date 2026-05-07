import { requestPasswordReset } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

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
    setResponseStatus(event, error.status)
    return {
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: sanitizeFlashedInput(submission.values),
      errors: error.fields,
    }
  }

  return submission.success({
    message: 'If an account exists for that email, a reset link has been sent.',
  })
})
