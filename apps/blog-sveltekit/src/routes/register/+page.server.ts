import { fail, redirect } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { csrf, getSecurityRuntime } from '@holo-js/security'

import { registerForm } from '$lib/schemas/auth'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ cookies, request, url }) => {
  const field = await csrf.field(request)
  cookies.set(getSecurityRuntime().config.csrf.cookie, field.value, {
    path: '/',
    sameSite: 'lax',
    secure: url.protocol === 'https:',
  })

  return { csrf: field }
}) satisfies PageServerLoad

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
    const redirectTo = session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin'

    redirect(303, redirectTo)
  },
} satisfies Actions
