import { json } from '@sveltejs/kit'
import { requestPasswordReset } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { forgotPasswordForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, forgotPasswordForm)

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await requestPasswordReset(submission.data)
  if (error) {
    return json({
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: submission.values,
      errors: error.fields,
    }, {
      status: error.status,
    })
  }

  return json(submission.success({
    message: 'If an account exists for that email, a reset link has been sent.',
  }))
}
