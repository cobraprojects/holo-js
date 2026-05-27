import { check, verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, verifyEmailForm)

  const wasAuthenticated = await check()
  await verifyEmail(input.token)

  return {
    ok: true,
    status: 200,
    data: {
      message: wasAuthenticated
        ? 'Email address verified.'
        : 'Email address verified. You can sign in now.',
      redirectTo: wasAuthenticated ? '/admin' : '/login',
    },
  }
})
