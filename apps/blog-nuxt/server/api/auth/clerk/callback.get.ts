import { completeClerkAuth } from '@holo-js/auth-clerk'
import { sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const result = await completeClerkAuth(event)
  if (!result.ok) {
    const errCode = result.code ?? 'unknown_error'
    return await sendRedirect(event, `/login?error=${encodeURIComponent(errCode)}`, 303)
  }

  return await sendRedirect(event, '/admin', 303)
})
