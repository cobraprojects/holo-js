import { fail, redirect } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '$lib/schemas/auth'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, registerForm, {
      csrf: true,
      throttle: 'register',
    })

    if (!submission.valid) {
      const failure = submission.fail()
      return fail(failure.status, failure)
    }

    const { data: created, error } = await register(submission.data)
    if (error) {
      const failure = submission.fail({
        status: error.status,
        errors: error.fields,
      })

      return fail(failure.status, failure)
    }

    const session = await loginUsing(created)
    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin')
  },
} satisfies Actions
