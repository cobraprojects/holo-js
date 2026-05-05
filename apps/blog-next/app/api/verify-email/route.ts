import { verification } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, verifyEmailForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { error } = await verification.consume(submission.data.token)
  if (error) {
    return Response.json({
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: submission.values,
      errors: error.fields,
    }, {
      status: error.status,
    })
  }

  return Response.json(submission.success({
    message: 'Email address verified. You can sign in now.',
    redirectTo: '/login',
  }))
}
