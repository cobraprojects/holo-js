import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: session, error } = await auth.guard('admin').login(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    setResponseStatus(event, failure.status)
    return failure
  }

  return submission.success({
    message: 'Signed in as super admin.',
    redirectTo: '/super-admin',
    user: session.user,
  })
})
