import { json } from '@sveltejs/kit'
import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '$lib/schemas/auth'

export async function POST({ request }: { request: Request }) {
  const input = await validate(request, loginForm, {
    throttle: 'login',
  })

  const token = await auth.guard('api').login(input)

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
