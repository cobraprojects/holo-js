import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'
import { createError, sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  if (await provider() !== 'workos') {
    return await sendRedirect(event, '/', 303)
  }

  const result = await logoutWithWorkos(event)
  if (!result.ok) {
    throw createError({
      statusCode: 422,
      statusMessage: result.message,
    })
  }

  return await sendRedirect(event, result.url, 303)
})
