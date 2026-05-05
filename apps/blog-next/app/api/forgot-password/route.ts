import { requestPasswordReset } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { forgotPasswordForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, forgotPasswordForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await requestPasswordReset(submission.data)
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
    message: 'If an account exists for that email, a reset link has been sent.',
  }))
}
