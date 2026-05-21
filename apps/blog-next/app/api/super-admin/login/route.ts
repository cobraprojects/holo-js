import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: session, error } = await auth.guard('admin').login(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  return Response.json(submission.success({
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in as super admin.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/super-admin',
    user: session.user,
  }))
}
