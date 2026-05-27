import { redirect } from '@sveltejs/kit'
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
    const input = await validate(request, registerForm, {
      throttle: 'register',
    })

    const created = await register(input)

    const session = await loginUsing(created)
    redirect(303, session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin')
  },
} satisfies Actions
