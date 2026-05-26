import { fail, redirect } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { csrf } from '@holo-js/security'

import { registerForm } from '$lib/schemas/auth'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ request }) => ({
  csrf: {
    input: await csrf.input(request),
  },
})) satisfies PageServerLoad

export const actions = {
  default: async ({ request }) => {
    const submission = await validate(request, registerForm, {
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
