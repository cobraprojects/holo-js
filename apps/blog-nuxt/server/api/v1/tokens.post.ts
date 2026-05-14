import auth from '@holo-js/auth'
import { validate } from '@holo-js/forms'

import { loginForm } from '#shared/schemas/auth'

export default defineEventHandler(async (event) => {
  const submission = await validate(event, loginForm, {
    throttle: 'login',
  })

  if (!submission.valid) {
    const failure = submission.fail()
    setResponseStatus(event, failure.status)
    return failure
  }

  const { data: token, error } = await auth.guard('api').login({
    ...submission.data,
    abilities: ['posts.read'],
  })

  if (error) {
    setResponseStatus(event, 401)

    return {
      ok: false,
      message: 'Invalid credentials.',
    }
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    ok: true,
    token: token.plainTextToken,
    tokenId: token.id,
    abilities: token.abilities,
  }
})
