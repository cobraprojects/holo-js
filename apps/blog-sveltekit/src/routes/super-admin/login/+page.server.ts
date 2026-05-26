import { redirect } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'
import { csrf } from '@holo-js/security'

import { loginForm } from '$lib/schemas/auth'
import type { Actions, PageServerLoad } from './$types'

export const load = (async ({ request }) => ({
  csrf: {
    input: await csrf.input(request),
  },
})) satisfies PageServerLoad

export const actions = {
  default: async ({ request }) => {
    const input = await validate(request, loginForm, {
      throttle: 'login',
    })

    const session = await auth.guard('admin').login(input)

    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/super-admin')
  },
} satisfies Actions
