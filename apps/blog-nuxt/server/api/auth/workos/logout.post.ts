import { logoutWithWorkos } from '@holo-js/auth-workos'
import { createError, sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  const result = await logoutWithWorkos(event)
  if (!result.ok) {
    throw createError({
      statusCode: 422,
      statusMessage: result.message,
    })
  }

  return await sendRedirect(event, result.url, 303)
})
