import { provider } from '@holo-js/auth'
import { logoutWithWorkos } from '@holo-js/auth-workos'
import { createError, sendRedirect } from 'h3'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default defineEventHandler(async (event) => {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: getErrorMessage(error),
    })
  }

  if (currentProvider !== 'workos') {
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
