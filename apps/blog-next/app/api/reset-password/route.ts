import { resetPassword } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { resetPasswordForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, resetPasswordForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await resetPassword(submission.data)
  if (error) {
    return Response.json({
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: sanitizeFlashedInput(submission.values),
      errors: error.fields,
    }, {
      status: error.status,
    })
  }

  return Response.json(submission.success({
    message: 'Password reset successfully. You can sign in with your new password.',
    redirectTo: '/login',
  }))
}
