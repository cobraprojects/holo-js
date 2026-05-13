import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'
import { createError, sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  if (await provider() !== 'clerk') {
    return await sendRedirect(event, '/', 303)
  }

  const result = await logoutWithClerk(event)
  if (!result.ok) {
    throw createError({
      statusCode: 422,
      statusMessage: result.message,
    })
  }

  return await sendRedirect(event, result.url, 303)
})
