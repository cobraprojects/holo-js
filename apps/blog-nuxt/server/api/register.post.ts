import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, registerForm, {
    csrf: true,
    throttle: 'register',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: created, error } = await register(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  const session = await loginUsing(created)
  setResponseStatus(event, 201)
  return submission.success({
    message: session.emailVerificationRequired
      ? 'Account created. Check your inbox to verify your email address.'
      : 'Account created and signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
    user: session.user,
  }, 201)
})
