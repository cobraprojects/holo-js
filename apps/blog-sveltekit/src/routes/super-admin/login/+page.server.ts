import { fail, redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, loginForm, {
      throttle: 'login',
    })

    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    const { data: session, error } = await auth.guard('admin').login(submission.data)
    if (error) {
      const failure = submission.fail({
        status: error.status,
        errors: error.fields,
      })

      return fail(failure.status, failure)
    }

    const redirectTo = session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/super-admin'

    redirect(303, redirectTo)
  },
} satisfies Actions
