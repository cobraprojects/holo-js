import { json } from '@sveltejs/kit'
import { check, verification } from '@holo-js/auth'
import { sanitizeFlashedInput, validate } from '@holo-js/forms'

import { verifyEmailForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, verifyEmailForm)

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const authenticationCheck = check()
  const verificationResult = verification.consume(submission.data.token)
  const [wasAuthenticated, { error }] = await Promise.all([authenticationCheck, verificationResult])
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

  return json(submission.success({
    message: wasAuthenticated
      ? 'Email address verified.'
      : 'Email address verified. You can sign in now.',
    redirectTo: wasAuthenticated ? '/admin' : '/login',
  }))
}
