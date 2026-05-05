import { verification } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { verifyEmailForm } from '../../lib/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, verifyEmailForm)

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { error } = await verification.consume(submission.data.token)
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
    message: 'Email address verified. You can sign in now.',
    redirectTo: '/login',
  })
})
