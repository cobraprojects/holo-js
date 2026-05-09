import { check, verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, verifyEmailForm)

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const wasAuthenticated = await check()
  const { error } = await verifyEmail(submission.data.token)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: wasAuthenticated
      ? 'Email address verified.'
      : 'Email address verified. You can sign in now.',
    redirectTo: wasAuthenticated ? '/admin' : '/login',
  }))
}
