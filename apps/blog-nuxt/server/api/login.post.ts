import { login } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { loginForm } from '../../lib/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: session, error } = await login(submission.data)
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

  event.node.res.setHeader('set-cookie', [...session.cookies])

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
