import { check, verification } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { verifyEmailForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, verifyEmailForm)

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const wasAuthenticated = await check()
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
    message: wasAuthenticated
      ? 'Email address verified.'
      : 'Email address verified. You can sign in now.',
    redirectTo: wasAuthenticated ? '/admin' : '/login',
  })
})
