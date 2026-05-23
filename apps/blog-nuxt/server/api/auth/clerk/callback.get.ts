import { completeClerkAuth } from '@holo-js/auth-clerk'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const { error } = await completeClerkAuth(event)
  if (error) {
    return await sendRedirect(event, `/login?error=${encodeURIComponent(error.code)}`, 303)
  }

  return await sendRedirect(event, '/admin', 303)
})
