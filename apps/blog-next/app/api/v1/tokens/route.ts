import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '@/lib/schemas/auth'

export async function POST(request: Request) {
  const submission = await validate(request, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    return Response.json(failure, {
      status: failure.status,
    })
  }

  const { data: token, error } = await auth.guard('api').login({
    ...submission.data,
    abilities: ['posts.read'],
  })

  if (error) {
    return Response.json({
      ok: false,
      message: 'Invalid credentials.',
    }, { status: 401 })
  }

  return Response.json({
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
