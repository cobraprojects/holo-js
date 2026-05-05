import { json } from '@sveltejs/kit'
import { resetPassword } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { resetPasswordForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, resetPasswordForm)

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await resetPassword(submission.data)
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
    message: 'Password reset successfully. You can sign in with your new password.',
    redirectTo: '/login',
  }))
}
