import { json } from '@sveltejs/kit'
import { check, verifyEmail } from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { verifyEmailForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, verifyEmailForm)

  if (!submission.valid) {
    return json(submission.fail(), {
      status: submission.fail().status,
    })
  }

  const authenticationCheck = check()
  const verificationResult = verifyEmail(submission.data.token)
  const [wasAuthenticated, { error }] = await Promise.all([authenticationCheck, verificationResult])
  if (error) {
    const failure = submission.fail({
      status: error.status,
      errors: error.fields,
    })

    return json(failure, { status: failure.status })
  }

  return json(submission.success({
    message: wasAuthenticated
      ? 'Email address verified.'
      : 'Email address verified. You can sign in now.',
    redirectTo: wasAuthenticated ? '/admin' : '/login',
  }))
}
