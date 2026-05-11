import { completeWorkosAuth } from '@holo-js/auth-workos'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const result = await completeWorkosAuth(event)
  if (!result.ok) {
    return await sendRedirect(event, `/login?error=${encodeURIComponent(result.code)}`, 303)
  }

  return await sendRedirect(event, '/admin', 303)
})
