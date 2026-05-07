import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

import { toWebRequest } from '../../../lib/request'

export default defineEventHandler(async (event) => {
  const result = await callback('google', toWebRequest(event))
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return { message: result.message }
  }

  await auth.guard(result.guard).loginUsing(result.user)
  return sendRedirect(event, '/admin', 303)
})
