import { login } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
    csrf: true,
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: session, error } = await login(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return submission.success({
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
    user: session.user,
  })
})
