import { login } from '@holo-js/auth'
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

  const { data: session, error } = await login(submission.data)
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

  const headers = new Headers()
  for (const cookie of session.cookies) {
    headers.append('set-cookie', cookie)
  }

  return Response.json(submission.success({
    message: session.emailVerificationRequired
      ? 'Signed in. Verify your email address to continue.'
      : 'Signed in successfully.',
    redirectTo: session.emailVerificationRequired
      ? session.emailVerificationRoute ?? '/verify-email'
      : '/admin',
    user: session.user,
  }), {
    headers,
  })
}
