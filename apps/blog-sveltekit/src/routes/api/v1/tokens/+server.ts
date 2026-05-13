import { json } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const submission = await validate(request, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    return json(failure, {
      status: failure.status,
    })
  }

  const { data: token, error } = await auth.guard('api').login(submission.data)

  if (error) {
    return json({
      ok: false,
      message: 'Invalid credentials.',
    }, { status: 401 })
  }

  return json({
    ok: true,
    token: token.plainTextToken,
    tokenId: token.id,
    abilities: token.abilities,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
