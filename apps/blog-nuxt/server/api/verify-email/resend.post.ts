import { resendEmailVerification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resendEmailVerificationForm } from '#shared/schemas/auth'

const resendSuccessMessage = 'A fresh verification email has been sent.'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, resendEmailVerificationForm, {
    throttle: 'emailVerificationResend',
  })

  const success = () => submission.success({
    message: resendSuccessMessage,
  })

  if (!submission.valid) {
    const failure = submission.fail()

    setResponseStatus(event, failure.status)
    return failure
  }

  const { error } = await resendEmailVerification(submission.data.email)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return success()
})
