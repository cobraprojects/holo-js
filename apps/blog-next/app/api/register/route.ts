import { loginUsing, register } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { registerForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, registerForm, {
    throttle: 'register',
  })

  if (!submission.valid) {
    return Response.json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: created, error } = await register(submission.data)
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return Response.json(failure, { status: failure.status })
  }

  const session = await loginUsing(created)
  return Response.json(submission.success({
    message: session.emailVerificationRequired
      ? 'Account created. Check your inbox to verify your email address.'
      : 'Account created and signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
    user: session.user,
  }, 201), {
    status: 201,
  })
}
