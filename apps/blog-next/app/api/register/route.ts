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

  const session = await loginUsing(created)
  const headers = new Headers()
  for (const cookie of session.cookies) {
    headers.append('set-cookie', cookie)
  }

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
    headers,
  })
}
