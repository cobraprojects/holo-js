import { check, verification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

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
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return submission.success({
    message: wasAuthenticated
      ? 'Email address verified.'
      : 'Email address verified. You can sign in now.',
    redirectTo: wasAuthenticated ? '/admin' : '/login',
  })
})
