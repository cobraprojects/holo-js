import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const input = await validate(event, loginForm, {
    throttle: 'login',
  })

  const token = await auth.guard('api').login(input)

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    ok: true,
    token: token.plainTextToken,
    tokenId: token.id,
    abilities: token.abilities,
  }
})
