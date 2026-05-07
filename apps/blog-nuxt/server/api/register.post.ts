import { loginUsing, register } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { registerForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, registerForm, {
    throttle: 'register',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: created, error } = await register(submission.data)
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

  const session = await loginUsing(created)
  event.node.res.setHeader('set-cookie', [...session.cookies])
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
