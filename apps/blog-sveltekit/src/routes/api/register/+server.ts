import { json } from '@sveltejs/kit'
import { loginUsing, register } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { registerForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, registerForm, {
    throttle: 'register',
  })

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const { data: created, error } = await register(submission.data)
  if (error) {
    return json({
      ok: false as const,
      status: error.status,
      valid: false as const,
      values: sanitizeFlashedInput(submission.values),
      errors: error.fields,
    }, {
      status: error.status,
    })
  }

  const session = await loginUsing(created)
  return json(submission.success({
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
