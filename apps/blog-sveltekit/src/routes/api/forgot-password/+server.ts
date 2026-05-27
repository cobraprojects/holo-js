import { json } from '@sveltejs/kit'
import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { forgotPasswordForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, forgotPasswordForm)

  await requestPasswordReset(input)

  return json({
    ok: true,
    status: 200,
    data: {
      message: 'If an account exists for that email, a reset link has been sent.',
    },
  })
}
