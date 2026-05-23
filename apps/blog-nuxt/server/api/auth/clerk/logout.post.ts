import { provider } from '@holo-js/auth'
import { logoutWithClerk } from '@holo-js/auth-clerk'
import { createError, sendRedirect } from 'h3'

export default defineEventHandler(async (event) => {
  let currentProvider: string | null
  try {
    currentProvider = await provider()
  } catch {
    return await sendRedirect(event, '/', 303)
  }

  if (currentProvider !== 'clerk') {
    return await sendRedirect(event, '/', 303)
  }

  const { data, error } = await logoutWithClerk(event)
  if (error) {
    throw createError({
      statusCode: error.status,
      statusMessage: error.message,
    })
  }

  return await sendRedirect(event, data.url, 303)
})
