import auth from '@holo-js/auth'
import { callback } from '@holo-js/auth-social'

export default defineEventHandler(async (event) => {
  const result = await callback('github', event)
  if (!result.ok) {
    setResponseStatus(event, result.status)
    return { message: result.message }
  }

  await auth.guard(result.guard).loginUsing(result.user)
  return sendRedirect(event, '/admin', 303)
})
