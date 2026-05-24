import { json } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '$lib/schemas/auth'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request }) => {
  const submission = await validate(request, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    return json(failure, { status: failure.status })
  }

  const { data: session, error } = await auth.guard('admin').login(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return json(failure, { status: failure.status })
  }

  return json(submission.success({
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in as super admin.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/super-admin',
    user: session.user,
  }))
}
