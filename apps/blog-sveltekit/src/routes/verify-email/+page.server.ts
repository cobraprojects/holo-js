import { fail, redirect } from '@sveltejs/kit'
import { check, verifyEmail } from '@holo-js/auth'

import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = ({ url }) => {
  const email = url.searchParams.get('email') ?? ''
  const token = url.searchParams.get('token')?.trim()

  return {
    email,
    hasVerificationToken: Boolean(token),
  }
}

export const actions: Actions = {
  default: async ({ url }) => {
    const token = url.searchParams.get('token')?.trim()

    if (!token) {
      return fail(422, {
        verificationError: 'Verification token is required.',
      })
    }

    const [wasAuthenticated] = await Promise.all([
      check(),
      verifyEmail(token),
    ])

    throw redirect(303, wasAuthenticated ? '/admin' : '/login')
  },
}
