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
    return json(submission.fail(), {
      status: submission.fail().status,
    })
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
    message: 'Signed in as super admin.',
    redirectTo: '/super-admin',
    user: session.user,
  }))
}
