import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resetPasswordForm } from '../../lib/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, resetPasswordForm)

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { error } = await resetPassword(submission.data)
  if (error) {
    setResponseStatus(event, error.status)
    return {
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: submission.values,
      errors: error.fields,
    }
  }

  return submission.success({
    message: 'Password reset successfully. You can sign in with your new password.',
    redirectTo: '/login',
  })
})
